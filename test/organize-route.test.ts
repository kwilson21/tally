import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";

async function get(path = "/transactions/organize") {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(
	fields: Record<string, string | string[]>,
	path = "/transactions/organize",
	htmx = false,
) {
	const form = new URLSearchParams();
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value])
			form.append(key, item);
	}
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
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
		expect(html).toMatch(/1 of \d+ · \d+ left, all months/);
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

	it("distinguishes skipping every current group from finishing", async () => {
		const first = await get();
		const names = [...first.html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(
			(m) => m[1],
		);
		let path = "/transactions/organize";
		for (;;) {
			const page = await get(path);
			const name = page.html.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1];
			if (!name) {
				expect(page.html).toContain("You skipped the rest.");
				expect(page.html).toContain(">Start over</a>");
				break;
			}
			const url = new URL(BASE + path);
			url.searchParams.append("skip", name);
			path = url.pathname + url.search;
		}
		expect(names.length).toBeGreaterThan(0);
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
			group: "Local Bakery",
			raw_name: ["FORGED MERCHANT", ...rawNames],
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
		expect(res.headers.get("HX-Trigger")).toBeNull();
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
			group: "Local Bakery",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(
			/role="alert"[^>]*>Pick a category from the list\.<\/p>/,
		);
	});

	it("rejects a name over 80 characters with an alert and keeps the group", async () => {
		const { res, html } = await post({
			category: "2",
			name: "x".repeat(81),
			group: "Local Bakery",
		});
		expect(res.status).toBe(422);
		expect(html).toContain("Local Bakery");
		expect(html).toMatch(
			/role="alert"[^>]*>Name must be 80 characters or fewer\.<\/p>/,
		);
	});

	it("returns the next page and feedback for htmx", async () => {
		const { res, html } = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
	});

	it("shows a fresh form for the next merchant when the submitted one is already done", async () => {
		const { res, html } = await post(
			{ category: "2", name: "Stale name", group: "Gone merchant" },
			"/transactions/organize",
			true,
		);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "info" },
		});
		expect(html).not.toContain("Stale name");
		expect(html).not.toMatch(/value="2"[^>]*checked|checked[^>]*value="2"/);
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		const plain = await post({
			category: "2",
			name: "",
			group: "Gone merchant",
		});
		expect(plain.res.status).toBe(303);
	});

	it("handles 150 raw names in one shown merchant without exceeding D1 limits", async () => {
		const statements = [];
		for (let i = 0; i < 150; i++) {
			const raw = `BULK MERCHANT*CODE${i}`;
			statements.push(
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Bulk merchant')",
				).bind(raw),
				env.DB.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100000, ?)",
				).bind(todayUtc(), raw),
			);
		}
		await env.DB.batch(statements);
		const page = await get();
		expect(page.html).toMatch(/From BULK MERCHANT[^<]+ and 147 more/);
		const { res } = await post({
			category: "2",
			name: "",
			group: "Bulk merchant",
		});
		expect(res.status).toBe(303);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'BULK MERCHANT%' AND category_id = 2",
		).first<{ n: number }>();
		expect(count?.n).toBe(150);
	});

	it("does not show excluded, split-parent, income, or already categorized rows", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, excluded) VALUES (1, ?, 1, 'HIDDEN EXCLUDED', 1)",
			).bind(todayUtc()),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, is_split) VALUES (1, ?, 1, 'HIDDEN SPLIT', 1)",
			).bind(todayUtc()),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, flag_income) VALUES (1, ?, 1, 'HIDDEN INCOME', 1)",
			).bind(todayUtc()),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1, 'HIDDEN CATEGORIZED', 2, 'user')",
			).bind(todayUtc()),
		]);
		const { html } = await get();
		expect(html).not.toMatch(/HIDDEN (EXCLUDED|SPLIT|INCOME|CATEGORIZED)/);
	});

	it("keeps unreviewed credits out of merchant organization until reviewed", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, credit_reviewed) VALUES (1, ?, -1200, 'PENDING CREDIT', 0)",
		)
			.bind(todayUtc())
			.run();
		const { html } = await get();
		expect(html).not.toContain("PENDING CREDIT");
	});

	it("preserves skips through save and only counts skips that still exist", async () => {
		const page = await get();
		const first = page.html.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] ?? "";
		const secondPage = await get(
			`/transactions/organize?skip=${encodeURIComponent(first)}&skip=missing`,
		);
		const second = secondPage.html.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] ?? "";
		expect(secondPage.html).toMatch(/2 of \d+/);
		const { res: saved } = await post(
			{ category: "2", name: "", group: second },
			`/transactions/organize?skip=${encodeURIComponent(first)}`,
		);
		expect(saved.headers.get("Location")).toContain(
			`skip=${encodeURIComponent(first)}`,
		);
		const after = await get(saved.headers.get("Location") ?? "");
		expect(after.html).not.toMatch(new RegExp(`<h2[^>]*>${first}</h2>`));
	});
});

it("links to Organize from Home and the Needs category filter", async () => {
	expect((await get("/")).html).toContain('href="/transactions/organize"');
	expect((await get("/transactions?uncategorized=1")).html).toMatch(
		/<a[^>]*href="\/transactions\/organize"[^>]*>Organize by merchant<\/a>/,
	);
});
