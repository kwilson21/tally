import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
		expect(html).toContain('hx-trigger="input changed delay:300ms"');
		// The amount request is nested inside a form that selects #page. Override that inherited
		// selector so its partial response can update the live total.
		expect(html).toContain('hx-select="#split-line"');
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

	it("keeps reviewed refund amounts in spending when split, re-split, and restored", async () => {
		const credit = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>();
		const id = credit?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -10000, credit_reviewed = 1 WHERE id = ?",
		)
			.bind(id)
			.run();
		const before = await env.DB.prepare(
			"SELECT SUM(amount_cents) AS cents FROM transactions WHERE excluded = 0 AND is_split = 0 AND (amount_cents >= 0 OR credit_reviewed = 1 OR flag_income = 1)",
		).first<{ cents: number }>();
		await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "60.00"],
			["part_amount", "40.00"],
			["back", "/transactions"],
		]);
		const firstSplit = await env.DB.prepare(
			"SELECT SUM(amount_cents) AS cents, SUM(credit_reviewed) AS reviewed FROM transactions WHERE parent_id = ?",
		)
			.bind(id)
			.first<{ cents: number; reviewed: number }>();
		expect(firstSplit).toEqual({ cents: -10000, reviewed: 2 });
		await post(`/transactions/${id}/split`, [
			["part_category", "1"],
			["part_category", "5"],
			["part_amount", "30.00"],
			["part_amount", "70.00"],
			["back", "/transactions"],
		]);
		const secondSplit = await env.DB.prepare(
			"SELECT SUM(amount_cents) AS cents, SUM(credit_reviewed) AS reviewed FROM transactions WHERE parent_id = ?",
		)
			.bind(id)
			.first<{ cents: number; reviewed: number }>();
		expect(secondSplit).toEqual({ cents: -10000, reviewed: 2 });
		await post(`/transactions/${id}/split/remove`, [["back", "/transactions"]]);
		const after = await env.DB.prepare(
			"SELECT SUM(amount_cents) AS cents FROM transactions WHERE excluded = 0 AND is_split = 0 AND (amount_cents >= 0 OR credit_reviewed = 1 OR flag_income = 1)",
		).first<{ cents: number }>();
		expect(after?.cents).toBe(before?.cents);
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
});
