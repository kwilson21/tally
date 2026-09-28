import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";

async function get(path = "/transactions/organize") {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(fields: Record<string, string | string[]>) {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value])
			form.append(key, item);
	}
	const res = await exports.default.fetch(`${BASE}/transactions/organize`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: form.toString(),
	});
	return { res, html: await res.text() };
}

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("GET /transactions/organize", () => {
	it("groups different raw names by the name people see and shows the largest total first", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW ONE', 'Target')",
			),
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW TWO', 'Target')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 50000, 'RAW ONE')",
			).bind(todayUtc()),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 40000, 'RAW TWO')",
			).bind(todayUtc()),
		]);
		const { res, html } = await get();
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Organize · Tally</title>");
		expect(html).toMatch(/1 of \d+ · \d+ transactions left/);
		expect(html).toMatch(/Target[\s\S]*2 transactions · \$900\.00/);
		expect(html).toContain("From RAW ONE, RAW TWO");
		expect(html).toMatch(
			/<fieldset[^>]*>[\s\S]*<legend[^>]*>Category<\/legend>/,
		);
		expect(html).toMatch(/name="name"[^>]*value="Target"/);
		expect(html).toContain("Future Target transactions get this category too.");
	});

	it("skips a group without saving it", async () => {
		const first = (await get()).html.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1];
		const skipped = await get(
			`/transactions/organize?skip=${encodeURIComponent(first ?? "")}`,
		);
		expect(skipped.html).not.toMatch(new RegExp(`<h2[^>]*>${first}</h2>`));
		const unchanged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL",
		).first<{ n: number }>();
		expect(unchanged?.n).toBeGreaterThan(0);
	});

	it("shows the done state when nothing needs a category", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		const { html } = await get();
		expect(html).toContain("Every transaction has a category.");
	});
});

describe("POST /transactions/organize", () => {
	it("sets every category and source, merchant rules and rename, then redirects with announcements", async () => {
		const rawNames = ["SQ *LOCAL BAKERY 4432"];
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ? AND category_id IS NULL",
		)
			.bind(rawNames[0])
			.first<{ n: number }>();
		const { res } = await post({
			category: "2",
			name: "The Bakery",
			raw_name: rawNames,
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
		const noun = before?.n === 1 ? "transaction" : "transactions";
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: {
				message: `${before?.n} ${noun} set to Eating Out.`,
				type: "success",
			},
			announce: `${before?.n} ${noun} set to Eating Out.`,
		});
		const saved = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ? AND category_id = 2 AND category_source = 'user' AND updated_by = 'demo'",
		)
			.bind(rawNames[0])
			.first<{ n: number }>();
		expect(saved?.n).toBe(before?.n);
		expect(
			await env.DB.prepare(
				"SELECT display_name AS name, default_category_id AS category FROM merchants WHERE raw_name = ?",
			)
				.bind(rawNames[0])
				.first(),
		).toEqual({ name: "The Bakery", category: 2 });
	});

	it("returns 422 with a fieldset alert when category is missing", async () => {
		const { res, html } = await post({
			name: "Local Bakery",
			raw_name: "SQ *LOCAL BAKERY 4432",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(
			/role="alert"[^>]*>Pick a category from the list\.<\/p>/,
		);
	});
});

it("links to Organize from Home and the Needs category filter", async () => {
	expect((await get("/")).html).toContain('href="/transactions/organize"');
	expect((await get("/transactions?uncategorized=1")).html).toMatch(
		/<a[^>]*href="\/transactions\/organize"[^>]*>Organize by merchant<\/a>/,
	);
});
