// Spike, candidate 1: no new library. Generated schema + a parameter-owning template.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type Fragment, prepare, q, table } from "../../spike/baseline/q";
import { childFirst, diff, introspect, type Schema } from "../../spike/baseline/introspect";
import { SCHEMA } from "../../spike/baseline/schema.generated";
import { SETTLE_SUGGESTION_SQL, suggestBankNamesSql } from "../../src/db/merchant-names";
import exportSource from "../../src/settings/export.ts?raw";
import resetSource from "../../src/demo/reset.ts?raw";

const live = () =>
	introspect(async (sql) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results);

beforeEach(async () => {
	await env.DB.batch([env.DB.prepare("DELETE FROM category_suggestions"), env.DB.prepare("DELETE FROM merchants")]);
});

describe("1. one real table, faithfully (every table, in fact)", () => {
	it("the generated schema matches the live one: columns, CHECK lists, indexes (partial or not), foreign keys", async () => {
		expect(diff(SCHEMA as unknown as Schema, await live())).toEqual([]);
		const cs = SCHEMA.category_suggestions;
		expect(cs.checks.status).toEqual(["pending", "created", "dismissed", "none"]);
		expect(cs.indexes.find((i) => i.name === "category_suggestions_pending_name")).toEqual({
			name: "category_suggestions_pending_name",
			unique: true,
			partial: true,
		});
	});

	it("fails on drift: a stale copy with a column removed and a CHECK value forgotten", async () => {
		const stale = structuredClone(SCHEMA) as unknown as Schema;
		stale.transactions!.columns = stale.transactions!.columns.filter((c) => c.name !== "note_state");
		stale.category_suggestions!.checks.status = ["pending", "created", "dismissed"];
		const problems = diff(stale, await live());
		expect(problems).toContain("transactions.note_state is in the database, not in the generated schema");
		expect(problems).toContain("category_suggestions CHECK lists differ");
	});
});

describe("2. compare-and-set update", () => {
	it("stays one line of SQL; the table name is checked, the id is a parameter", async () => {
		const dismiss = async (id: number) =>
			prepare(env.DB, q`UPDATE ${table("category_suggestions")} SET status = 'dismissed', decided_at = datetime('now') WHERE id = ${id} AND status = 'pending' RETURNING name`)
				.first<{ name: string }>();
		const { id } = (await env.DB.prepare("INSERT INTO category_suggestions (name, status) VALUES ('Pets','pending') RETURNING id").first<{ id: number }>())!;
		expect(await dismiss(id)).toEqual({ name: "Pets" });
		expect(await dismiss(id)).toBeNull();
		expect(() => table("nope" as never)).toThrow(/no table/);
	});
});

describe("3. db.batch", () => {
	it("is D1's own batch: per-statement results, rollback on a failing statement", async () => {
		const results = await env.DB.batch([
			prepare(env.DB, q`INSERT INTO category_suggestions (name, status) VALUES (${"A"}, 'pending') RETURNING id`),
			prepare(env.DB, q`INSERT INTO category_suggestions (name, status) VALUES (${"B"}, 'pending') RETURNING name`),
		]);
		expect(results[1]?.results).toEqual([{ name: "B" }]);
		await expect(
			env.DB.batch([
				prepare(env.DB, q`INSERT INTO merchants (raw_name) VALUES (${"M"})`),
				prepare(env.DB, q`INSERT INTO category_suggestions (name, status) VALUES (${"a"}, 'pending')`),
			]),
		).rejects.toThrow(/UNIQUE/);
		expect((await env.DB.prepare("SELECT count(*) c FROM merchants").first<{ c: number }>())?.c).toBe(0);
	});
});

describe("4. hard queries", () => {
	it("the SQL is unchanged; a guard fragment brings its own parameters and the numbering follows", async () => {
		await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
		// Today: `${sql}${gate.sql(args.length + 1)}`. Here the guard is a fragment and nothing is counted by hand.
		const guard: Fragment = q`(SELECT 1) AND ${"owner-1"} = ${"owner-1"}`;
		await prepare(
			env.DB,
			q`INSERT INTO merchants (raw_name, suggested_name, suggestion_status)
			  SELECT value, value, 'pending' FROM json_each(${JSON.stringify(["NEW ONE", "NAMED"])}) WHERE ${guard}
			  ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name, suggestion_status = 'pending'
			  WHERE merchants.display_name IS NULL AND merchants.suggestion_status IN ('none', 'pending')`,
		).run();
		const rows = (await env.DB.prepare("SELECT raw_name, suggestion_status s FROM merchants ORDER BY raw_name").all()).results;
		expect(rows).toEqual([{ raw_name: "NAMED", s: "none" }, { raw_name: "NEW ONE", s: "pending" }]);
		// and the original string still works as it is
		await env.DB.prepare("DELETE FROM merchants").run();
		await env.DB.prepare(suggestBankNamesSql("1")).bind(JSON.stringify(["X"])).run();
		expect((await env.DB.prepare("SELECT raw_name FROM merchants").all()).results).toEqual([{ raw_name: "X" }]);
		expect(SETTLE_SUGGESTION_SQL).toContain("CASE");
	});
});

describe("5. hand-kept lists derived from the schema", () => {
	const handKept = (src: string, table: string) =>
		(src.match(new RegExp(`\\b${table}:\\s*"([^"]*)"`))?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

	it("the transactions export list, from the schema", () => {
		const derived = SCHEMA.transactions.columns.map((c) => c.name);
		expect(derived).toHaveLength(58);
		const hand = handKept(exportSource, "transactions");
		const missing = derived.filter((c) => !hand.includes(c));
		console.log(`[baseline] hand-kept export has ${hand.length} of ${derived.length} transactions columns; missing:`, missing);
	});

	it("TABLES_CHILD_FIRST: the foreign keys give an order, and the hand list is compared to it", async () => {
		const list = [...resetSource.matchAll(/^\t"([a-z_]+)",$/gm)].map((m) => m[1] as string);
		const order = childFirst(SCHEMA as unknown as Schema);
		const notListed = Object.keys(SCHEMA).filter((t) => !list.includes(t));
		console.log("[baseline] tables not in TABLES_CHILD_FIRST:", notListed);
		// any list is safe to run in order when no table comes before one of its children
		const index = (t: string) => list.indexOf(t);
		const wrong = list.filter((parent) =>
			Object.entries(SCHEMA).some(([child, info]) => (info.references as readonly string[]).includes(parent) && child !== parent && index(child) > index(parent) && index(child) !== -1),
		);
		console.log("[baseline] hand-list tables placed before a table that references them:", wrong);
		expect(order).toHaveLength(Object.keys(SCHEMA).length);
		// derived order really deletes: run it against live D1 (inside a batch so nothing is kept if it fails)
		await env.DB.batch(order.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	});

	it("a column added by a migration but not regenerated fails the test", async () => {
		await env.DB.prepare("ALTER TABLE transactions ADD COLUMN spike_new_column TEXT").run();
		const problems = diff(SCHEMA as unknown as Schema, await live());
		expect(problems).toEqual(["transactions.spike_new_column is in the database, not in the generated schema"]);
	});
});
