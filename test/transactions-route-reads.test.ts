import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// Characterises the routes/transactions.tsx reads that the Drizzle conversion (#963) moves: what a
// cash save does with an archived or unknown category, and which people the delete sheet lists.
const BASE = "http://tally.test";

async function request(path: string, init?: RequestInit) {
	const res = await exports.default.fetch(BASE + path, init);

	return { res, html: await res.text() };
}

const post = (path: string, body: string) =>
	request(path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
	});

beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

describe("cash save with a category that is not on the list", () => {
	const cashBody = (category: string) =>
		new URLSearchParams({
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "12.34",
			merchant: "Route read market",
			category,
		}).toString();

	it("refuses an archived category and saves nothing", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();

		const { res, html } = await post("/transactions/cash", cashBody("1"));

		expect(res.status).toBe(422);
		expect(html).toContain("Pick a category from the list.");
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Route read market'",
			).first(),
		).toEqual({ n: 0 });
	});

	it("refuses an unknown category and saves nothing", async () => {
		const { res, html } = await post("/transactions/cash", cashBody("99999"));

		expect(res.status).toBe(422);
		expect(html).toContain("Pick a category from the list.");
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Route read market'",
			).first(),
		).toEqual({ n: 0 });
	});
});

describe("the delete sheet for a cash entry", () => {
	it("names the entry's For person from the household people", async () => {
		await env.DB.prepare(
			"INSERT INTO household_people(name) VALUES ('Ada Route'), ('Ben Route')",
		).run();
		const ben = await env.DB.prepare(
			"SELECT id FROM household_people WHERE name = 'Ben Route'",
		).first<{ id: number }>();
		const cash = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.parent_id IS NULL ORDER BY t.id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET for_person_id = ? WHERE id = ?",
		)
			.bind(ben?.id, cash?.id)
			.run();

		const { html } = await post(
			`/transactions/${cash?.id}/delete`,
			"back=/transactions",
		);
		const sheet = html.slice(html.indexOf('role="dialog"'));

		expect(sheet).toContain("Ben Route");
	});
});
