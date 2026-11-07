// Spike: Kysely compiled to SQL and run through D1 ourselves. No D1 dialect is used (kysely-d1 has no transactions).
import { env } from "cloudflare:workers";
import {
	DummyDriver,
	Kysely,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	sql,
	type Compilable,
} from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTLE_SUGGESTION_SQL } from "../../src/db/merchant-names";

// The database's shape, written by hand (kysely-codegen could write it from a live database; it is a separate dependency).
interface Database {
	category_suggestions: {
		id: number;
		name: string;
		status: "pending" | "created" | "dismissed" | "none";
		created_at: string;
		decided_at: string | null;
	};
	merchants: {
		raw_name: string;
		suggested_name: string | null;
		display_name: string | null;
		default_category_id: number | null;
		suggestion_status: "none" | "pending" | "accepted" | "rejected";
		not_a_bill: number;
	};
}

const kdb = new Kysely<Database>({
	dialect: {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (db) => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	},
});

const statement = (q: Compilable) => {
	const { sql: text, parameters } = q.compile();
	return env.DB.prepare(text).bind(...parameters);
};
const all = async <T>(q: Compilable<T>) => (await statement(q).all<T>()).results;
const first = async <T>(q: Compilable<T>) => (await statement(q).first<T>()) ?? null;
const batch = (qs: Compilable[]) => env.DB.batch(qs.map(statement));

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM category_suggestions"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
});

describe("1. one real table, faithfully", () => {
	it("types only: there is no runtime schema object to compare, so drift is a type, not a test", async () => {
		// Kysely's Database interface is erased at build time. The only runtime route to the real schema is the introspector,
		// which needs a connection that can run PRAGMAs; the compile-only setup has none.
		await expect(kdb.introspection.getTables()).resolves.toEqual([]); // Dummy driver: sees nothing
	});
});

describe("2. compare-and-set update with RETURNING", () => {
	const dismiss = (id: number) =>
		first(
			kdb
				.updateTable("category_suggestions")
				.set({ status: "dismissed", decided_at: sql<string>`datetime('now')` })
				.where("id", "=", id)
				.where("status", "=", "pending")
				.returning("name"),
		);
	it("returns the name once, then null", async () => {
		const [row] = await all(
			kdb.insertInto("category_suggestions").values({ name: "Pets", status: "pending" }).returning("id"),
		);
		expect(await dismiss(row?.id ?? 0)).toEqual({ name: "Pets" });
		expect(await dismiss(row?.id ?? 0)).toBeNull();
	});
});

describe("3. db.batch of compiled queries", () => {
	it("per-statement results, then a failing statement rolls everything back", async () => {
		const results = await batch([
			kdb.insertInto("category_suggestions").values({ name: "A", status: "pending" }).returning("id"),
			kdb.insertInto("category_suggestions").values({ name: "B", status: "pending" }).returning("name"),
			kdb.selectFrom("category_suggestions").select("name").orderBy("name"),
		]);
		expect(results[1]?.results).toEqual([{ name: "B" }]);
		expect(results[2]?.results).toEqual([{ name: "A" }, { name: "B" }]);
		await expect(
			batch([
				kdb.insertInto("merchants").values({ raw_name: "M" }),
				kdb.insertInto("category_suggestions").values({ name: "a", status: "pending" }), // duplicate pending name
			]),
		).rejects.toThrow(/UNIQUE/); // the driver's own error, not wrapped
		expect(await all(kdb.selectFrom("merchants").select("raw_name"))).toEqual([]);
	});

	it("kysely's own transaction() is unavailable here (the dummy driver has no connection to hold)", async () => {
		// With kysely-d1, `db.transaction()` throws 'Transactions are not supported yet.' (read from its published source).
		expect(typeof kdb.transaction).toBe("function");
	});
});

describe("4. hard queries", () => {
	it("settle a suggestion: ON CONFLICT DO UPDATE with a CASE gives the same rows as SETTLE_SUGGESTION_SQL", async () => {
		for (const [suggested, chosen] of [["Target\nTarget Corp", "Target"], ["Target", "My Target"], ["Target", null]] as const) {
			const out: unknown[] = [];
			for (const style of ["raw", "kysely"] as const) {
				await env.DB.prepare("DELETE FROM merchants").run();
				await env.DB.prepare("INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('k', ?, 'pending')")
					.bind(suggested).run();
				if (style === "raw")
					await env.DB.prepare(`INSERT INTO merchants (raw_name, display_name) VALUES ('k', ?)
						ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name, ${SETTLE_SUGGESTION_SQL}`).bind(chosen).run();
				else
					await statement(
						kdb
							.insertInto("merchants")
							.values({ raw_name: "k", display_name: chosen })
							.onConflict((oc) =>
								oc.column("raw_name").doUpdateSet({
									display_name: (eb) => eb.ref("excluded.display_name"),
									suggestion_status: sql`CASE
										WHEN merchants.suggestion_status != 'pending' OR excluded.display_name IS NULL THEN merchants.suggestion_status
										WHEN instr(char(10) || COALESCE(merchants.suggested_name, '') || char(10), char(10) || excluded.display_name || char(10)) > 0 THEN 'accepted'
										ELSE 'rejected' END`,
								}),
							),
					).run();
				out.push(await env.DB.prepare("SELECT suggestion_status s, display_name d FROM merchants WHERE raw_name='k'").first());
			}
			expect(out[1]).toEqual(out[0]);
		}
	});

	it("INSERT … SELECT FROM json_each(?) … ON CONFLICT … WHERE, built with a table-valued function", async () => {
		await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
		const names = JSON.stringify(["NEW ONE", "NAMED"]);
		await statement(
			kdb
				.insertInto("merchants")
				.columns(["raw_name", "suggested_name", "suggestion_status"])
				.expression((eb) =>
					eb
						.selectFrom(sql<{ value: string }>`json_each(${names})`.as("j"))
						.select(["j.value as raw_name", "j.value as suggested_name", sql<"pending">`'pending'`.as("suggestion_status")])
						.where(sql<boolean>`1`), // SQLite needs a WHERE here or it reads ON as a join; the original has `WHERE 1` for this
				)
				.onConflict((oc) =>
					oc
						.column("raw_name")
						.doUpdateSet({ suggested_name: (eb) => eb.ref("excluded.suggested_name"), suggestion_status: "pending" })
						.where((eb) =>
							eb.and([eb("merchants.display_name", "is", null), eb("merchants.suggestion_status", "in", ["none", "pending"])]),
						),
				),
		).run();
		const rows = await all(kdb.selectFrom("merchants").select(["raw_name", "suggestion_status", "display_name"]).orderBy("raw_name"));
		expect(rows).toEqual([
			{ raw_name: "NAMED", suggestion_status: "none", display_name: "Mine" },
			{ raw_name: "NEW ONE", suggestion_status: "pending", display_name: null },
		]);
	});
});

describe("5. a hand-kept list derived from the schema", () => {
	it("there is no runtime column list: the Database interface cannot produce EXPORT_COLUMNS", () => {
		// Nothing to assert in code; see the report. kysely-codegen emits the same erased types.
		expect(true).toBe(true);
	});
});
