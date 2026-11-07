// Spike: Drizzle ORM against the real schema, in the Workers runtime. See docs/spike-typed-db-layer.md.
import { env } from "cloudflare:workers";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	SETTLE_SUGGESTION_SQL,
	suggestBankNamesSql,
} from "../../src/db/merchant-names";
import {
	categorySuggestions,
	merchants,
	transactions,
} from "../../spike/drizzle/schema";
import exportSource from "../../src/settings/export.ts?raw";

const orm = drizzle(env.DB);

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM category_suggestions"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
});

/** Everything the schema file claims that the live schema does not back up. Empty means in step. */
async function drift(table: Parameters<typeof getTableConfig>[0]) {
	const config = getTableConfig(table);
	const problems: string[] = [];
	const { results: live } = await env.DB.prepare(
		`PRAGMA table_info(${config.name})`,
	).all<{ name: string; type: string; notnull: number; pk: number }>();
	const liveByName = new Map(live.map((c) => [c.name, c]));
	for (const column of config.columns) {
		const found = liveByName.get(column.name);
		if (!found) {
			problems.push(`${config.name}.${column.name} is not in the database`);
			continue;
		}
		if (Boolean(found.notnull) !== column.notNull && !column.primary)
			problems.push(`${config.name}.${column.name} not-null differs`);
		if (column.enumValues) {
			const row = await env.DB.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
			)
				.bind(config.name)
				.first<{ sql: string }>();
			const m = row?.sql.match(
				new RegExp(`\\b${column.name}\\s+IN\\s*\\(([^)]*)\\)`),
			);
			const allowed = [...(m?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1]);
			if (JSON.stringify([...allowed].sort()) !== JSON.stringify([...column.enumValues].sort()))
				problems.push(`${config.name}.${column.name} CHECK differs: ${allowed}`);
		}
	}
	for (const name of liveByName.keys())
		if (!config.columns.some((c) => c.name === name))
			problems.push(`${config.name}.${name} is in the database, not in the schema`);
	const { results: idx } = await env.DB.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
	)
		.bind(config.name)
		.all<{ name: string; sql: string }>();
	for (const i of idx) {
		const declared = config.indexes.find((d) => d.config.name === i.name);
		if (!declared) {
			problems.push(`index ${i.name} is in the database, not in the schema`);
			continue;
		}
		if (/CREATE UNIQUE/i.test(i.sql) !== Boolean(declared.config.unique))
			problems.push(`index ${i.name} uniqueness differs`);
		if (/\sWHERE\s/i.test(i.sql) !== Boolean(declared.config.where))
			problems.push(`index ${i.name} partial-ness differs`);
	}
	for (const d of config.indexes)
		if (!idx.some((i) => i.name === d.config.name))
			problems.push(`index ${d.config.name} is in the schema, not in the database`);
	return problems;
}

describe("1. one real table, faithfully", () => {
	it("category_suggestions, merchants and transactions match the live schema", async () => {
		expect(await drift(categorySuggestions)).toEqual([]);
		expect(await drift(merchants)).toEqual([]);
		// transactions: 58 columns; its unique indexes (transactions_entry_key, _upload_twin) are not described here on purpose.
		const problems = await drift(transactions);
		expect(problems.filter((p) => !p.startsWith("index "))).toEqual([]);
		console.log("[drizzle] transactions index drift (not described in spike):", problems);
	});

	it("fails on drift: a wrong CHECK list, a missing column, an extra column", async () => {
		const { sqliteTable, text, integer } = await import("drizzle-orm/sqlite-core");
		const wrong = sqliteTable("category_suggestions", {
			id: integer().primaryKey({ autoIncrement: true }),
			name: text().notNull(),
			status: text({ enum: ["pending", "created", "dismissed"] }).notNull(), // 'none' forgotten
			ghost: text(), // not in the database
		});
		const problems = await drift(wrong);
		expect(problems.join("\n")).toContain("status CHECK differs");
		expect(problems.join("\n")).toContain("ghost is not in the database");
		expect(problems.join("\n")).toContain("created_at is in the database, not in the schema");
		expect(problems.join("\n")).toContain("category_suggestions_pending_name is in the database, not in the schema");
	});

	it("the CHECK and the partial unique index are enforced by the real database, not by Drizzle", async () => {
		await expect(
			orm.insert(categorySuggestions).values({ name: "x", status: "bogus" as never }),
		).rejects.toThrow();
		await orm.insert(categorySuggestions).values({ name: "Pets", status: "pending" });
		const error = await orm
			.insert(categorySuggestions)
			.values({ name: "pets", status: "pending" })
			.then(() => null, (e: Error) => e);
		// Finding: Drizzle wraps the driver error. src/ has four `/UNIQUE/.test(error.message)` checks; they would miss this.
		expect(error?.message).toMatch(/^Failed query/);
		expect(error?.message).not.toMatch(/UNIQUE/);
		expect(String((error as Error & { cause?: Error }).cause?.message)).toMatch(/UNIQUE/);
		// the same name once decided is allowed again: the index is partial
		await orm.insert(categorySuggestions).values({ name: "pets", status: "dismissed" });
	});
});

describe("2. compare-and-set update with RETURNING", () => {
	const dismiss = (id: number) =>
		orm
			.update(categorySuggestions)
			.set({ status: "dismissed", decidedAt: sql`datetime('now')` })
			.where(and(eq(categorySuggestions.id, id), eq(categorySuggestions.status, "pending")))
			.returning({ name: categorySuggestions.name })
			.get();

	it("returns the name once, then undefined when it matches nothing", async () => {
		const [row] = await orm
			.insert(categorySuggestions)
			.values({ name: "Pets", status: "pending" })
			.returning({ id: categorySuggestions.id });
		expect(await dismiss(row?.id ?? 0)).toEqual({ name: "Pets" });
		expect(await dismiss(row?.id ?? 0)).toBeUndefined();
	});
});

describe("3. db.batch: per-statement results and rollback", () => {
	it("returns each statement's own result, RETURNING included", async () => {
		const results = await orm.batch([
			orm.insert(categorySuggestions).values({ name: "A", status: "pending" }).returning({ id: categorySuggestions.id }),
			orm.insert(categorySuggestions).values({ name: "B", status: "pending" }).returning({ name: categorySuggestions.name }),
			orm.update(categorySuggestions).set({ status: "created" }).where(eq(categorySuggestions.name, "A")).returning({ name: categorySuggestions.name }),
			orm.select().from(categorySuggestions),
		]);
		expect(results[0]).toHaveLength(1);
		expect(results[1]).toEqual([{ name: "B" }]);
		expect(results[2]).toEqual([{ name: "A" }]);
		expect(results[3]).toHaveLength(2);
	});

	it("one failing statement rolls the whole batch back", async () => {
		await expect(
			orm.batch([
				orm.insert(categorySuggestions).values({ name: "A", status: "pending" }),
				orm.insert(merchants).values({ rawName: "M" }),
				// violates the partial unique index (a second pending 'a'):
				orm.insert(categorySuggestions).values({ name: "a", status: "pending" }),
			]),
		).rejects.toThrow();
		expect(await orm.select().from(categorySuggestions)).toHaveLength(0);
		expect(await orm.select().from(merchants)).toHaveLength(0);
	});

	it("orm.transaction() is not usable on D1 (BEGIN is refused)", async () => {
		await expect(
			orm.transaction(async (tx) => {
				await tx.insert(merchants).values({ rawName: "T" });
			}),
		).rejects.toThrow();
		// and nothing was kept
		expect(await orm.select().from(merchants)).toHaveLength(0);
	});
});

describe("4. hard queries", () => {
	it("settle a suggestion: ON CONFLICT DO UPDATE with a CASE, same outcome as SETTLE_SUGGESTION_SQL", async () => {
		const cases: [string, string | null][] = [
			["Target\nTarget Corp", "Target"], // chosen from the suggestions: accepted
			["Target", "My Target"], // own name: rejected
			["Target", null], // no name: unchanged
		];
		for (const [suggested, chosen] of cases) {
			for (const style of ["raw", "drizzle"] as const) {
				await env.DB.prepare("DELETE FROM merchants").run();
				await env.DB.prepare(
					"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('k', ?, 'pending')",
				).bind(suggested).run();
				if (style === "raw") {
					await env.DB.prepare(
						`INSERT INTO merchants (raw_name, display_name) VALUES ('k', ?)
						 ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name, ${SETTLE_SUGGESTION_SQL}`,
					).bind(chosen).run();
				} else {
					await orm
						.insert(merchants)
						.values({ rawName: "k", displayName: chosen })
						.onConflictDoUpdate({
							target: merchants.rawName,
							set: {
								displayName: sql`excluded.display_name`,
								// the CASE is still hand-written SQL, just wrapped
								suggestionStatus: sql`CASE
									WHEN merchants.suggestion_status != 'pending' OR excluded.display_name IS NULL THEN merchants.suggestion_status
									WHEN instr(char(10) || COALESCE(merchants.suggested_name, '') || char(10), char(10) || excluded.display_name || char(10)) > 0 THEN 'accepted'
									ELSE 'rejected' END`,
							},
						});
				}
				const row = await env.DB.prepare("SELECT suggestion_status s, display_name d FROM merchants WHERE raw_name='k'").first();
				(globalThis as Record<string, unknown>)[`out_${style}`] = row;
			}
			expect((globalThis as Record<string, unknown>).out_drizzle).toEqual((globalThis as Record<string, unknown>).out_raw);
		}
	});

	it("suggestBankNamesSql: INSERT … SELECT FROM json_each(?) … ON CONFLICT … WHERE, via the builder", async () => {
		await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
		const names = JSON.stringify(["NEW ONE", "NAMED"]);
		// Finding: .insert().select() always names every column (here 6), so a 3-column INSERT … SELECT cannot be built.
		await expect(
			orm.insert(merchants).select(sql`SELECT value, value, 'pending' FROM json_each(${names}) WHERE 1`),
		).rejects.toThrow(/Failed query/);
		// The whole statement goes through sql`` instead, which is the original SQL with a different wrapper.
		await orm.run(sql`INSERT INTO merchants (raw_name, suggested_name, suggestion_status)
			SELECT value, value, 'pending' FROM json_each(${names}) WHERE 1
			ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name, suggestion_status = 'pending'
			WHERE merchants.display_name IS NULL AND merchants.suggestion_status IN ('none', 'pending')`);
		// (the typed upsert half works when the values are plain: see the settle test above and the next test)
		// raw original for comparison
		const rows = await orm.select().from(merchants).orderBy(merchants.rawName);
		expect(rows.map((r) => [r.rawName, r.suggestionStatus, r.displayName])).toEqual([
			["NAMED", "none", "Mine"],
			["NEW ONE", "pending", null],
		]);
		// the original SQL gives the same rows
		await env.DB.prepare("DELETE FROM merchants").run();
		await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
		await env.DB.prepare(suggestBankNamesSql("1")).bind(names).run();
		const raw = await orm.select().from(merchants).orderBy(merchants.rawName);
		expect(raw).toEqual(rows);
	});

	it("a typed upsert with setWhere, plain values", async () => {
		await orm.insert(merchants).values([{ rawName: "A", displayName: "Mine" }, { rawName: "B" }]);
		const rows = await orm
			.insert(merchants)
			.values([{ rawName: "A", suggestedName: "x" }, { rawName: "B", suggestedName: "x" }])
			.onConflictDoUpdate({
				target: merchants.rawName,
				set: { suggestedName: sql`excluded.suggested_name`, suggestionStatus: "pending" },
				setWhere: sql`${merchants.displayName} IS NULL`,
			})
			.returning({ rawName: merchants.rawName });
		expect(rows).toEqual([{ rawName: "B" }]); // RETURNING only lists rows the WHERE let through
	});

	it("json_each as a typed filter: only the WHERE is raw", async () => {
		await orm.insert(categorySuggestions).values([
			{ name: "A", status: "pending" },
			{ name: "B", status: "pending" },
			{ name: "C", status: "none" },
		]);
		const ids = JSON.stringify(["A", "C"]);
		const rows = await orm
			.select({ name: categorySuggestions.name })
			.from(categorySuggestions)
			.where(sql`${categorySuggestions.name} IN (SELECT value FROM json_each(${ids}))`);
		expect(rows.map((r) => r.name).sort()).toEqual(["A", "C"]);
	});
});

describe("5. a hand-kept list derived from the schema", () => {
	const handKept = (() => {
		const m = exportSource.match(/transactions:\s*"([^"]*)"/);
		return (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	})();

	it("the transactions column list comes from the schema; a missing migration column fails the drift test", async () => {
		const derived = Object.values(getTableColumns(transactions)).map((c) => c.name);
		expect(derived).toHaveLength(58);
		expect(await drift(transactions).then((p) => p.filter((x) => !x.startsWith("index ")))).toEqual([]);
	});

	it("finding: the hand-kept EXPORT_COLUMNS list for transactions leaves these columns out today", () => {
		const derived = Object.values(getTableColumns(transactions)).map((c) => c.name);
		const missing = derived.filter((c) => !handKept.includes(c));
		console.log(`[drizzle] hand-kept export has ${handKept.length} of ${derived.length} transactions columns; missing:`, missing);
		expect(missing.length).toBeGreaterThan(0);
	});
});
