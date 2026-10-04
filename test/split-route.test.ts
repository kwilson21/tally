import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
beforeEach(() => resetDemo(env.DB, "2026-09-22"));

async function post(path: string, fields: [string, string][]) {
	return exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
	});
}

describe("transaction splits", () => {
	it("renders two labeled parts and the server-computed live line", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${bakery?.id}/split`)
		).text();
		expect(html).toContain("$12.00 left to assign");
		expect(html.match(/name="part_category"/g)).toHaveLength(2);
		expect(html).toContain('hx-trigger="input delay:300ms"');
		// The amount request is nested inside a form that selects #page. Override that inherited
		// selector so its partial response can update the live total.
		expect(html).toMatch(/hx-select="#split-line (>|&gt;) \*"/);
	});

	it("does not offer or allow splitting income", async () => {
		const income = await env.DB.prepare(
			"SELECT id FROM transactions WHERE flag_income = 1 LIMIT 1",
		).first<{ id: number }>();
		const edit = await (
			await exports.default.fetch(`${BASE}/transactions/${income?.id}`)
		).text();
		expect(edit).not.toContain(`/transactions/${income?.id}/split?`);
		const form = await exports.default.fetch(
			`${BASE}/transactions/${income?.id}/split`,
		);
		expect(form.status).toBe(404);
		const response = await post(`/transactions/${income?.id}/split`, [
			["back", "/transactions"],
		]);
		expect(response.status).toBe(400);
	});

	it("rejects a mismatch, then saves children and removes them atomically", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const id = bakery?.id as number;
		const bad = await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "5"],
			["part_amount", "6"],
			["back", "/transactions"],
		]);
		expect(bad.status).toBe(422);
		expect(await bad.text()).toContain('role="alert"');
		const saved = await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "5"],
			["part_amount", "7"],
			["back", "/transactions"],
		]);
		expect(saved.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
			)
				.bind(id)
				.first<{ n: number }>(),
		).toEqual({ n: 2 });
		expect(
			(
				await env.DB.prepare("SELECT is_split FROM transactions WHERE id = ?")
					.bind(id)
					.first<{ is_split: number }>()
			)?.is_split,
		).toBe(1);
		await post(`/transactions/${id}/split/remove`, [["back", "/transactions"]]);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("excluding a split parent excludes its children", async () => {
		const costco = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
		).first<{ id: number }>();
		await post(`/transactions/${costco?.id}`, [
			["merchant", "Costco"],
			["note", ""],
			["excluded", "1"],
			["back", "/transactions"],
		]);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ? AND excluded = 1",
				)
					.bind(costco?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});

	it("writes nothing when the bank changed the amount after the parts were checked", async () => {
		const bakery = await env.DB.prepare(
			"SELECT id, amount_cents AS cents FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number; cents: number }>();
		const id = bakery?.id as number;
		const stale = [
			{ categoryId: 1, amountCents: 500 },
			{ categoryId: 5, amountCents: (bakery?.cents as number) - 400 },
		];
		expect(await saveSplit(env.DB, id, stale, "test")).toBe(false);
		expect(
			await env.DB.prepare(
				"SELECT is_split AS split, (SELECT COUNT(*) FROM transactions WHERE parent_id = ?1) AS parts FROM transactions WHERE id = ?1",
			)
				.bind(id)
				.first(),
		).toEqual({ split: 0, parts: 0 });
	});

	it("preserves reviewed credit metadata when income review columns are installed", async () => {
		const columns = await env.DB.prepare(
			"PRAGMA table_info(transactions)",
		).all<{
			name: string;
		}>();
		if (!columns.results.some((column) => column.name === "credit_reviewed_by"))
			return;

		const refund = await env.DB.prepare(
			"SELECT id, amount_cents AS amountCents FROM transactions WHERE amount_cents < 0 AND parent_id IS NULL AND flag_income = 0 LIMIT 1",
		).first<{ id: number; amountCents: number }>();
		const id = refund?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
		)
			.bind(id)
			.run();
		const total = Math.abs(refund?.amountCents as number);
		const first = Math.trunc(total / 2);
		const second = total - first;
		for (let save = 0; save < 2; save++) {
			const response = await post(`/transactions/${id}/split`, [
				["part_category", "1"],
				["part_category", "5"],
				["part_amount", (first / 100).toFixed(2)],
				["part_amount", (second / 100).toFixed(2)],
				["back", "/transactions"],
			]);
			expect(response.status).toBe(200);
		}
		const children = await env.DB.prepare(
			"SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE parent_id = ?",
		)
			.bind(id)
			.all();
		expect(children.results).toHaveLength(2);
		for (const child of children.results as Array<Record<string, unknown>>) {
			expect(child).toMatchObject({
				flag_income: 0,
				income_source: "user",
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
		}
	});

	it("keeps working on main before income review columns are installed", async () => {
		const columns = await env.DB.prepare(
			"PRAGMA table_info(transactions)",
		).all<{
			name: string;
		}>();
		if (columns.results.some((column) => column.name === "credit_reviewed_by"))
			return;

		const refund = await env.DB.prepare(
			"SELECT id, amount_cents AS amountCents FROM transactions WHERE amount_cents < 0 AND parent_id IS NULL AND flag_income = 0 LIMIT 1",
		).first<{ id: number; amountCents: number }>();
		const result = await saveSplit(
			env.DB,
			refund?.id as number,
			[
				{
					categoryId: 1,
					amountCents: Math.trunc((refund?.amountCents as number) / 2),
				},
				{
					categoryId: 5,
					amountCents:
						(refund?.amountCents as number) -
						Math.trunc((refund?.amountCents as number) / 2),
				},
			],
			"synthetic-test",
		);
		expect(result).toBe(true);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
			)
				.bind(refund?.id)
				.first(),
		).toEqual({ n: 2 });
	});
});
