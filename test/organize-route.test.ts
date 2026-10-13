import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");
const categoryName = async (id: number) =>
	(
		await env.DB.prepare("SELECT name FROM categories WHERE id = ?")
			.bind(id)
			.first<{ name: string }>()
	)?.name;
/** The merchant rule's category for a merchant key, or null when it has none (or no row). */
const ruleOf = async (key: string) =>
	(
		await env.DB.prepare(
			"SELECT default_category_id AS category FROM merchants WHERE raw_name = ?",
		)
			.bind(key)
			.first<{ category: number | null }>()
	)?.category ?? null;

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
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
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
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 40000, 'RAW TWO')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
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
		// The name arrives filled in, so the hint says what changing it does, not "leave it empty".
		expect(html).toContain(
			"Change it to rename every transaction from this merchant.",
		);
		expect(html).not.toContain("Leave empty to keep it");
		// Save only files the transactions on screen: no line promises the store's future ones (#353).
		expect(html).not.toContain("get this category too");
	});

	it("shows one merchant's bank texts on its group, so one choice's reach is visible", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('Comcast', 'Comcast Cable')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 900000, 'COMCAST CABLE', 'Comcast'), (1, ?, 800000, 'COMCAST CABLE 2', 'Comcast')",
			).bind(todayIn(DEFAULT_TIME_ZONE), todayIn(DEFAULT_TIME_ZONE)),
		]);

		const { html } = await get();

		expect(html).toMatch(/<h2[^>]*>Comcast Cable<\/h2>/);
		expect(html).toContain("2 transactions · $17,000.00");
		expect(html).toContain("From COMCAST CABLE, COMCAST CABLE 2");
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
	it("clears the bill names of a purchase the bank took out of its split when it is set a category", async () => {
		const rawName = "SQ *LOCAL BAKERY 4432";
		await env.DB.prepare(
			"UPDATE transactions SET category_id = NULL, category_source = NULL, split_removed_from_cents = 5000, split_removed_bills = ? WHERE raw_name = ?",
		)
			.bind('[{"name":"Water","period":"2026-09"}]', rawName)
			.run();

		await post({ category: "2", group: "Local Bakery", raw_name: [rawName] });

		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ? AND split_removed_bills IS NOT NULL",
			)
				.bind(rawName)
				.first<{ n: number }>(),
		).toEqual({ n: 0 });
	});

	it("files every charge with the category and renames the store, makes no rule, and asks Always use … ?", async () => {
		const rawNames = ["SQ *LOCAL BAKERY 4432"];
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ? AND category_id IS NULL",
		)
			.bind(rawNames[0])
			.first<{ n: number }>();
		const { res, html } = await post({
			category: "2",
			name: "The Bakery",
			group: "Local Bakery",
			raw_name: ["FORGED MERCHANT", ...rawNames],
		});
		// With JavaScript off the question is a page of its own, so the save answers 200, not a redirect.
		expect(res.status).toBe(200);
		expect(html).toContain(
			`Always use ${await categoryName(2)} for The Bakery?`,
		);
		expect(html).toContain("Say yes and Tally sorts the next one for you.");
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
		).toEqual({ name: "The Bakery", category: null });
	});

	it("Yes makes the rule on the group's merchant, then redirects to the next store (JavaScript off)", async () => {
		const rawNames = ["SQ *LOCAL BAKERY 4432"];
		await post({ category: "2", name: "The Bakery", group: "Local Bakery" });
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(rawNames),
				merchant: "The Bakery",
				category: "2",
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		const settingsHtml = await (
			await exports.default.fetch("http://tally.test/settings")
		).text();
		const rules = settingsHtml.slice(
			settingsHtml.indexOf('id="merchant-rules"'),
		);
		const bakery = rules.match(
			/<li[^>]*>[\s\S]*?The Bakery[\s\S]*?<\/li>/,
		)?.[0];
		expect(bakery).toBeDefined();
		expect(textOf(bakery ?? "")).toMatch(
			/The Bakery.*Always .* · \d+ transactions?/,
		);
	});

	it("Yes makes the rule on every merchant key in the group, and says so with the next store (htmx)", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW ONE', 'Target')",
			),
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW TWO', 'Target')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 50000, 'RAW ONE')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 40000, 'RAW TWO')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		await post(
			{ category: "2", name: "Target", group: "Target" },
			undefined,
			true,
		);
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["RAW ONE", "RAW TWO"]),
				merchant: "Target",
				category: "2",
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("RAW ONE")).toBe(2);
		expect(await ruleOf("RAW TWO")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Target is always ${await categoryName(2)} now.`,
				type: "success",
			},
			announce: `Target is always ${await categoryName(2)} now.`,
		});
		expect(html).not.toContain("rule-offer-title");
	});

	it("Not now makes no rule and moves to the next store, keeping the skips", async () => {
		const rawNames = ["SQ *LOCAL BAKERY 4432"];
		await post({ category: "2", name: "", group: "Local Bakery" });
		const { res } = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(rawNames),
				merchant: "Local Bakery",
				category: "2",
			},
			"/transactions/organize/rule?skip=Other%20store",
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(
			"/transactions/organize?skip=Other%20store",
		);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
	});

	it("a Yes for a merchant with no charge filed in that category makes no rule for it", async () => {
		await post({ category: "2", name: "", group: "Local Bakery" });
		await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["FORGED MERCHANT"]),
				merchant: "Forged",
				category: "2",
			},
			"/transactions/organize/rule",
		);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE raw_name = 'FORGED MERCHANT'",
			).first<{ n: number }>(),
		).toEqual({ n: 0 });
	});

	it("a Yes for a category that is archived or missing makes no rule", async () => {
		await post({ category: "2", name: "", group: "Local Bakery" });
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "999",
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
	});

	it("skips the question when every merchant of the group already has that rule, and moves on as before (JavaScript off)", async () => {
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = 2 WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).run();
		const plain = await post({
			category: "2",
			name: "",
			group: "Local Bakery",
		});
		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("Location")).toBe("/transactions/organize");
	});

	it("skips the question when every merchant of the group already has that rule, with the save's toast (htmx)", async () => {
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = 2 WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).run();
		const htmx = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		expect(htmx.html).not.toContain("rule-offer-title");
		expect(
			JSON.parse(htmx.res.headers.get("HX-Trigger") ?? "{}"),
		).toMatchObject({
			toast: { type: "success" },
		});
	});

	it("answers an htmx save with the question, the save's words as the announcement, and focus on the question", async () => {
		const { res, html } = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
			announce: expect.stringMatching(/^1 transaction set to /),
		});
		expect(html).toMatch(
			/<h2[^>]*id="rule-offer-title"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		expect(html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
		expect(html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
	});

	it("the question's Yes sets the rule for 150 merchant keys in one request", async () => {
		const statements = [];
		const keys = [];
		for (let i = 0; i < 150; i++) {
			const raw = `BULK MERCHANT*CODE${i}`;
			keys.push(raw);
			statements.push(
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Bulk merchant')",
				).bind(raw),
				env.DB.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 100000, ?)",
				).bind(todayIn(DEFAULT_TIME_ZONE), raw),
			);
		}
		await env.DB.batch(statements);
		await post({ category: "2", name: "", group: "Bulk merchant" });
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(keys),
				merchant: "Bulk merchant",
				category: "2",
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM merchants WHERE raw_name LIKE 'BULK MERCHANT%' AND default_category_id = 2",
		).first<{ n: number }>();
		expect(count?.n).toBe(150);
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

	it("moves on to the next store after Not now, with its heading focused", async () => {
		await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		const { res, html } = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toBeNull();
		// The save before it pushed this address, so the answer replaces it: one history entry, not two.
		expect(res.headers.get("HX-Replace-Url")).toBe("/transactions/organize");
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toContain("rule-offer-title");
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
				).bind(todayIn(DEFAULT_TIME_ZONE), raw),
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
		// The save files all 150 charges, then asks the question (no rule yet).
		expect(res.status).toBe(200);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'BULK MERCHANT%' AND category_id = 2",
		).first<{ n: number }>();
		expect(count?.n).toBe(150);
	});

	it("does not show excluded, split-parent, income, or already categorized rows", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, excluded) VALUES (1, ?, 1, 'HIDDEN EXCLUDED', 1)",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, is_split) VALUES (1, ?, 1, 'HIDDEN SPLIT', 1)",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, flag_income) VALUES (1, ?, 1, 'HIDDEN INCOME', 1)",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1, 'HIDDEN CATEGORIZED', 2, 'user')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const { html } = await get();
		expect(html).not.toMatch(/HIDDEN (EXCLUDED|SPLIT|INCOME|CATEGORIZED)/);
	});

	it("keeps unreviewed credits out of merchant organization until reviewed", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, credit_reviewed) VALUES (1, ?, -1200, 'PENDING CREDIT', 0)",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
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
		expect(saved.status).toBe(200);
		// Not now carries the skips on to the next store.
		const { res: moved } = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: second,
				category: "2",
			},
			`/transactions/organize/rule?skip=${encodeURIComponent(first)}`,
		);
		expect(moved.headers.get("Location")).toContain(
			`skip=${encodeURIComponent(first)}`,
		);
		const after = await get(moved.headers.get("Location") ?? "");
		expect(after.html).not.toMatch(new RegExp(`<h2[^>]*>${first}</h2>`));
	});
});

it("links to Organize from Home and the Needs category filter", async () => {
	expect((await get("/")).html).toContain('href="/transactions/organize"');
	expect((await get("/transactions?uncategorized=1")).html).toMatch(
		/<a[^>]*href="\/transactions\/organize"[^>]*>Organize by merchant<\/a>/,
	);
});

describe("the Organize by merchant link follows the Needs category filter", () => {
	const htmxGet = async (path: string) => {
		const res = await exports.default.fetch(BASE + path, {
			headers: { "HX-Request": "true" },
		});
		return res.text();
	};
	/** What sits inside the link's always-present wrapper. */
	const wrapper = (html: string) =>
		html.match(/<div id="organize-link">([\s\S]*?)<\/div>/)?.[1];

	it("keeps a wrapper on every list, filled only when Needs category is on", async () => {
		const filtered = wrapper((await get("/transactions?uncategorized=1")).html);
		expect(filtered).toMatch(
			/<a[^>]*href="\/transactions\/organize"[^>]*>Organize by merchant<\/a>/,
		);
		expect(wrapper((await get("/transactions")).html)).toBe("");
	});

	it("is swapped in with the list, so ticking or unticking the filter adds or removes it", async () => {
		const page = (await get("/transactions")).html;
		expect(page).toMatch(/hx-select-oob="[^"]*#organize-link:innerHTML/);
		expect(wrapper(await htmxGet("/transactions?uncategorized=1"))).toContain(
			"Organize by merchant",
		);
		expect(wrapper(await htmxGet("/transactions"))).toBe("");
	});
});
