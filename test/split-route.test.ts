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
});
