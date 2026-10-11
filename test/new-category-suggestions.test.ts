import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const THIS = TODAY.slice(0, 7);

async function get(path = "/settings") {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: [string, string][]) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

let suggestion: number;
let first: number;
let second: number;

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	// Every demo transaction is filed and the demo's own suggestion goes, so this suggestion stands alone.
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user', category_suggestion_id = NULL",
		),
		env.DB.prepare("DELETE FROM category_suggestions"),
	]);
	suggestion = (
		await env.DB.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		).first<{ id: number }>()
	)?.id as number;
	first = (
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 6412, 'CHEWY.COM', 'Chewy', 1, ?) RETURNING id",
		)
			.bind(`${THIS}-05`, suggestion)
			.first<{ id: number }>()
	)?.id as number;
	second = (
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, jev_none_fit, category_suggestion_id) VALUES (1, ?, 2399, 'PETSMART 0412', 'Petsmart', 1, ?) RETURNING id",
		)
			.bind(`${THIS}-02`, suggestion)
			.first<{ id: number }>()
	)?.id as number;
});

describe("Settings' Suggested card for a category that already exists", () => {
	it("says Create while the category is missing, and Add to once a person has made it", async () => {
		const before = await get();
		expect(before.html).toContain("Suggested: Pet Care");
		expect(before.html).toContain(">Create Pet Care<");

		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Pet Care', 'tag', 'cat-plum', 99)",
		).run();

		const after = await get();
		expect(after.html).toContain("Suggested: Pet Care");
		expect(after.html).toContain(">Add to Pet Care<");
		expect(after.html).not.toContain(">Create Pet Care<");
	});

	it("Add to files only the ticked transactions into the existing category, as the person's pick", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Pet Care', 'tag', 'cat-plum', 99)",
		).run();
		const made = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE name = 'Pet Care'",
			).first<{
				id: number;
			}>()
		)?.id as number;
		const categories = (
			await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{
				n: number;
			}>()
		)?.n;

		const { res } = await post(`/settings/suggestions/${suggestion}/create`, [
			["shown", String(first)],
			["shown", String(second)],
			["ids", String(first)],
		]);

		expect(res.status).toBe(200);
		const filed = await env.DB.prepare(
			"SELECT id, category_id AS categoryId, category_source AS source FROM transactions WHERE id IN (?, ?) ORDER BY id",
		)
			.bind(first, second)
			.all<{ id: number; categoryId: number | null; source: string | null }>();
		expect(filed.results).toEqual([
			{ id: first, categoryId: made, source: "user" },
			{ id: second, categoryId: null, source: null },
		]);
		const count = (
			await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{
				n: number;
			}>()
		)?.n;
		expect(count).toBe(categories);
		const status = await env.DB.prepare(
			"SELECT status FROM category_suggestions WHERE id = ?",
		)
			.bind(suggestion)
			.first<{ status: string }>();
		expect(status?.status).toBe("created");
	});

	it("names the category as it is stored in the Add to toast, whatever capitals the suggestion has", async () => {
		await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('pet care', 'tag', 'cat-plum', 99)",
		).run();

		const { res } = await post(`/settings/suggestions/${suggestion}/create`, [
			["shown", String(first)],
			["ids", String(first)],
		]);

		expect(res.status).toBe(200);
		const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast.message).toBe("Added 1 transaction to pet care");
		expect(trigger.announce).toContain("Added 1 transaction to pet care.");
	});
});
