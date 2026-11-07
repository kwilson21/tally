// Spike: workers-qb (D1QB) against the real schema.
import { env } from "cloudflare:workers";
import { D1QB, Raw } from "workers-qb";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTLE_SUGGESTION_SQL, suggestBankNamesSql } from "../../src/db/merchant-names";

type Schema = {
	category_suggestions: { id: number; name: string; status: string; created_at: string; decided_at: string | null };
	merchants: { raw_name: string; suggested_name: string | null; display_name: string | null; default_category_id: number | null; suggestion_status: string; not_a_bill: number };
};
const qb = new D1QB<Schema>(env.DB);

beforeEach(async () => {
	await env.DB.batch([env.DB.prepare("DELETE FROM category_suggestions"), env.DB.prepare("DELETE FROM merchants")]);
});

describe("1. one real table, faithfully", () => {
	it("a Schema type only; no runtime schema object, no CHECK or index description", () => {
		expect(true).toBe(true);
	});
});

describe("2. compare-and-set update with RETURNING", () => {
	const dismiss = async (id: number) => {
		const r = await qb
			.update({
				tableName: "category_suggestions",
				data: { status: "dismissed", decided_at: new Raw("datetime('now')") },
				where: { conditions: ["id = ?", "status = 'pending'"], params: [id] },
				returning: ["name"],
			})
			.execute();
		return r.results?.[0] ?? null;
	};
	it("returns the name once, then null", async () => {
		const ins = await qb.insert({ tableName: "category_suggestions", data: { name: "Pets", status: "pending" }, returning: ["id"] }).execute();
		const id = ins.results?.id as number;
		expect(await dismiss(id)).toEqual({ name: "Pets" });
		expect(await dismiss(id)).toBeNull();
	});
});

describe("3. batch", () => {
	it("per-statement results, then rollback on a failing statement", async () => {
		const results = await qb.batchExecute([
			qb.insert({ tableName: "category_suggestions", data: { name: "A", status: "pending" }, returning: ["id"] }),
			qb.insert({ tableName: "category_suggestions", data: { name: "B", status: "pending" }, returning: ["name"] }),
		]);
		expect(results).toHaveLength(2);
		expect(results[1].results).toEqual({ name: "B" });
		await expect(
			qb.batchExecute([
				qb.insert({ tableName: "merchants", data: { raw_name: "M" } }),
				qb.insert({ tableName: "category_suggestions", data: { name: "a", status: "pending" } }),
			]),
		).rejects.toThrow();
		const left = await qb.fetchAll({ tableName: "merchants" }).execute();
		expect(left.results).toEqual([]);
	});
});

describe("4. hard queries", () => {
	it("settle a suggestion via the builder's upsert: the CASE is a Raw string", async () => {
		for (const [suggested, chosen] of [["Target\nTarget Corp", "Target"], ["Target", "My Target"], ["Target", null]] as const) {
			const out: unknown[] = [];
			for (const style of ["raw", "qb"] as const) {
				await env.DB.prepare("DELETE FROM merchants").run();
				await env.DB.prepare("INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('k', ?, 'pending')").bind(suggested).run();
				if (style === "raw")
					await env.DB.prepare(`INSERT INTO merchants (raw_name, display_name) VALUES ('k', ?)
						ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name, ${SETTLE_SUGGESTION_SQL}`).bind(chosen).run();
				else
					await qb.insert({
						tableName: "merchants",
						data: { raw_name: "k", display_name: chosen },
						onConflict: {
							column: "raw_name",
							data: {
								display_name: new Raw("excluded.display_name"),
								suggestion_status: new Raw(`CASE
									WHEN merchants.suggestion_status != 'pending' OR excluded.display_name IS NULL THEN merchants.suggestion_status
									WHEN instr(char(10) || COALESCE(merchants.suggested_name, '') || char(10), char(10) || excluded.display_name || char(10)) > 0 THEN 'accepted'
									ELSE 'rejected' END`),
							},
						},
					}).execute();
				out.push(await env.DB.prepare("SELECT suggestion_status s, display_name d FROM merchants WHERE raw_name='k'").first());
			}
			expect(out[1]).toEqual(out[0]);
		}
	});

	it("INSERT … SELECT FROM json_each(?) … ON CONFLICT: not expressible; only qb.raw, with positional args", async () => {
		await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
		await qb.raw({ query: suggestBankNamesSql("1"), args: [JSON.stringify(["NEW ONE", "NAMED"])] }).execute();
		const rows = await qb.fetchAll({ tableName: "merchants", orderBy: "raw_name" }).execute();
		expect((rows.results ?? []).map((r) => [r.raw_name, r.suggestion_status, r.display_name])).toEqual([
			["NAMED", "none", "Mine"],
			["NEW ONE", "pending", null],
		]);
	});

	it("numbered parameters (?1) as the real settleSuggestion uses, through where.params", async () => {
		await env.DB.prepare("INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('k', 'A', 'pending')").run();
		const r = await qb.raw({
			query: "UPDATE merchants SET display_name = ?1 WHERE raw_name = ?2 AND suggestion_status = 'pending' RETURNING raw_name",
			args: ["A", "k"],
			fetchType: "ALL",
		} as never).execute();
		expect(JSON.stringify(r.results)).toContain("k");
	});
});

describe("5. a hand-kept list derived from the schema", () => {
	it("no runtime column list; the Schema type is erased", () => {
		expect(true).toBe(true);
	});
});
