import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { organizeGroups, storeChargeIds } from "../src/transactions/organize";
import { tidyName } from "../src/transactions/tidy-name";

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

/** The ids of Local Bakery's charges a person filed under category 2, in id order. */
const bakeryCharges = async () =>
	(
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432' AND category_id = 2 AND category_source = 'user' ORDER BY id",
		).all<{ id: number }>()
	).results.map((row) => row.id);
/** The question's hidden store and category, as its form posts them back (#532). */
const questionFields = (html: string) => ({
	store:
		html.match(/<input type="hidden" name="store" value="([^"]*)"/)?.[1] ?? "",
	category:
		html.match(/<input type="hidden" name="category" value="([^"]*)"/)?.[1] ??
		"",
});
/** The address's merchant row number, as Save names the store (#532). */
const storeOf = (location: string) =>
	new URL(BASE + location).searchParams.get("store") ?? "";

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

/** The page a no-JS save redirects to: the question, at its own address (#353). */
const followRedirect = (save: { res: Response }) =>
	get(save.res.headers.get("Location") ?? "");

/** Yes on the question in `html`, posted as its form posts it: the question's store and category (#532). */
const yesFrom = (
	html: string,
	path = "/transactions/organize/rule",
	htmx = false,
) => post({ answer: "yes", ...questionFields(html) }, path, htmx);

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
		const save = await post({
			category: "2",
			name: "The Bakery",
			group: "Local Bakery",
			raw_name: ["FORGED MERCHANT", ...rawNames],
		});
		// With JavaScript off the save redirects to the question's own address, which asks it.
		expect(save.res.status).toBe(303);
		const { html } = await followRedirect(save);
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
		const save = await post({
			category: "2",
			name: "The Bakery",
			group: "Local Bakery",
		});
		const { html: question } = await followRedirect(save);
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(rawNames),
				merchant: "The Bakery",
				category: "2",
				store: questionFields(question).store,
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
		const save = await post(
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
				store: questionFields(save.html).store,
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

	it("a Yes after a key of the group is renamed to another store makes the rule on the store's charges still named Target (htmx, #532)", async () => {
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
		const save = await post(
			{ category: "2", name: "Target", group: "Target" },
			undefined,
			true,
		);
		await env.DB.prepare(
			"UPDATE merchants SET display_name = 'Walmart' WHERE raw_name = 'RAW TWO'",
		).run();
		// The store is still Target's, and its charges still named Target are RAW ONE's, so the rule is RAW ONE's alone.
		const { res, html } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("RAW ONE")).toBe(2);
		expect(await ruleOf("RAW TWO")).toBeNull();
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Target is always ${await categoryName(2)} now.`,
				type: "success",
			},
		});
		expect(html).not.toContain("rule-offer-title");
	});

	it("a Yes after a key of the group has its name cleared to another store's tidied name makes the rule on the store's own key alone (htmx, #532)", async () => {
		// A cleared key shows its tidied key, so the store the question names must not be the one that key tidies to.
		expect(tidyName("RAW TWO")).not.toBe("Target");
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
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 30000, 'RAW ONE', 3, 'jev')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const save = await post(
			{ category: "2", name: "Target", group: "Target" },
			undefined,
			true,
		);
		await env.DB.prepare(
			"UPDATE merchants SET display_name = NULL WHERE raw_name = 'RAW TWO'",
		).run();
		// RAW TWO's cleared name tidies to its own key, so the store's charges named Target are RAW ONE's alone.
		const { res, html } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("RAW ONE")).toBe(2);
		expect(await ruleOf("RAW TWO")).toBeNull();
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Target is always ${await categoryName(2)} now.`,
			},
		});
		// The Jev charge of the rule's key is not a person's choice, so the rule applies to it.
		expect(
			await env.DB.prepare(
				"SELECT category_id AS category, category_source AS source FROM transactions WHERE raw_name = 'RAW ONE' AND category_source = 'merchant_rule'",
			).first(),
		).toEqual({ category: 2, source: "merchant_rule" });
		expect(html).not.toContain("rule-offer-title");
	});

	it("a Yes makes the rule on a key with no name that tidies to the store's name, beside a named key (htmx, #353)", async () => {
		// No merchants row for TARGET 5678, so it is named by tidyName, as the group is (organizeGroups).
		expect(tidyName("TARGET 5678")).toBe("Target");
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW ONE', 'Target')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 50000, 'RAW ONE')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 40000, 'TARGET 5678')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const save = await post(
			{ category: "2", name: "", group: "Target" },
			undefined,
			true,
		);
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["RAW ONE", "TARGET 5678"]),
				merchant: "Target",
				category: "2",
				store: questionFields(save.html).store,
			},
			"/transactions/organize/rule",
			true,
		);
		expect(await ruleOf("RAW ONE")).toBe(2);
		expect(await ruleOf("TARGET 5678")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Target is always ${await categoryName(2)} now.`,
				type: "success",
			},
			announce: `Target is always ${await categoryName(2)} now.`,
		});
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
			"/transactions/organize?skip=Other+store",
		);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
	});

	it("a Yes for a merchant with no charge filed in that category makes no rule for it", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const { html: question } = await followRedirect(save);
		expect(question).toContain("rule-offer-title");
		await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["FORGED MERCHANT"]),
				merchant: "Forged",
				category: "2",
				store: questionFields(question).store,
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
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const { res } = await post(
			{
				answer: "yes",
				store: storeOf(save.res.headers.get("Location") ?? ""),
				category: "999",
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
	});

	it("a Yes after the group's charges were filed elsewhere makes no rule, moves on silently and sends focus to the next store (htmx)", async () => {
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 3 WHERE raw_name = 'SQ *LOCAL BAKERY 4432' AND category_id = 2",
		).run();
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(save.html).store,
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
		expect(res.headers.get("HX-Trigger")).toBeNull();
		// The question is gone, and the next store's heading takes focus instead of the store that was answered.
		expect(html).not.toContain("rule-offer-title");
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
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
		expect(htmx.res.headers.get("HX-Push-Url")).toBeNull();
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

	it("an htmx Save that asks the question pushes the question's own address, so a reload asks it again (#353)", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW ONE', 'Other store')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 50000, 'RAW ONE')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize?skip=Other%20store",
			true,
		);
		const filed = await bakeryCharges();
		expect(filed.length).toBeGreaterThan(0);
		// The address names the store by one merchant row and the category, never the saved ids (#532).
		expect(save.res.headers.get("HX-Push-Url")).toMatch(
			/^\/transactions\/organize\?skip=Other\+store&category=2&store=\d+$/,
		);
		const reload = await get(save.res.headers.get("HX-Push-Url") ?? "");
		expect(reload.res.status).toBe(200);
		expect(reload.html).toContain("rule-offer-title");
		expect(reload.html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
		expect(questionFields(reload.html)).toEqual(questionFields(save.html));
		expect(
			await storeChargeIds(
				env.DB,
				Number(questionFields(reload.html).store),
				2,
			),
		).toEqual(filed);
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
		const save = await post({
			category: "2",
			name: "",
			group: "Bulk merchant",
		});
		const { html: question } = await followRedirect(save);
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(keys),
				merchant: "Bulk merchant",
				category: "2",
				store: questionFields(question).store,
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM merchants WHERE raw_name LIKE 'BULK MERCHANT%' AND default_category_id = 2",
		).first<{ n: number }>();
		expect(count?.n).toBe(150);
	});

	it("a Yes makes the rule from the charges Save filed, never from the merchant keys the request posts (#353)", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const { html: question } = await followRedirect(save);
		const merchantCount = () =>
			env.DB.prepare("SELECT COUNT(*) AS n FROM merchants").first<{
				n: number;
			}>();
		const before = await merchantCount();
		const madeUp = Array.from({ length: 3000 }, (_, i) => `MADE UP KEY ${i}`);
		const { res } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(madeUp),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(question).store,
			},
			"/transactions/organize/rule",
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE raw_name LIKE 'MADE UP KEY %'",
			).first<{ n: number }>(),
		).toEqual({ n: 0 });
		expect(await merchantCount()).toEqual(before);
	});

	it("a Yes after the charges Save filed were moved still makes the rule from the older charge the store keeps in the category (#532)", async () => {
		const older = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, '2026-08-01', 900, 'SQ *LOCAL BAKERY 4432', 2, 'user') RETURNING id",
		).first<{ id: number }>();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		// Every other bakery charge in the category moves on, so the older hand-filed charge is the store's one charge there.
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 3 WHERE raw_name = 'SQ *LOCAL BAKERY 4432' AND category_id = 2 AND id != ?",
		)
			.bind(older?.id)
			.run();
		const jev = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 700, 'SQ *LOCAL BAKERY 4432', 3, 'jev') RETURNING id",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<{ id: number }>();
		const { res, html } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
		expect(html).not.toContain("rule-offer-title");
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(jev?.id)
				.first(),
		).toEqual({ category_id: 2, category_source: "merchant_rule" });
	});

	it("a Yes makes the rule once one charge Save filed has moved, while the others still hold the category (#532)", async () => {
		const { save, saved } = await saveTwoBakeryCharges();
		await env.DB.prepare("UPDATE transactions SET category_id = 3 WHERE id = ?")
			.bind(saved[0])
			.run();
		const { res, html } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
	});

	/**
	 * Files Local Bakery's charges under category 2, with one more charge to file so Save files two or more. Returns the
	 * Save response and the store's charges a person filed there, read from the database.
	 */
	async function saveTwoBakeryCharges() {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1200, 'SQ *LOCAL BAKERY 4432')",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.run();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const saved = await bakeryCharges();
		expect(saved.length).toBeGreaterThan(1);
		return { save, saved };
	}

	it("a Yes makes the rule once a charge Save filed was deleted, while the others hold the category (#532)", async () => {
		const { save, saved } = await saveTwoBakeryCharges();
		await env.DB.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(saved[0])
			.run();
		const jev = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 700, 'SQ *LOCAL BAKERY 4432', 3, 'jev') RETURNING id",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<{ id: number }>();
		const { res, html } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
		// The rule reaches the store's charge a person did not choose, so the Jev charge takes it.
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(jev?.id)
				.first(),
		).toEqual({ category_id: 2, category_source: "merchant_rule" });
	});

	it("a Yes makes the rule while every charge Save filed still holds the category, with several of them (#532)", async () => {
		const { save } = await saveTwoBakeryCharges();
		const { res } = await yesFrom(save.html, undefined, true);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
	});

	it("a Yes takes the store and category from the question, and ignores a forged saved list and merchant (#532)", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('OTHER RAW', 'Other store')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 500, 'OTHER RAW', 2, 'user')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const other = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'OTHER RAW'",
		).first<{ id: number }>();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const madeUp = Array.from({ length: 3000 }, (_, i) => 900000 + i);
		const { res } = await post(
			{
				answer: "yes",
				...questionFields(save.html),
				saved: JSON.stringify([other?.id, ...madeUp]),
				merchant: "Other store",
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(await ruleOf("OTHER RAW")).toBeNull();
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Local Bakery is always ${await categoryName(2)} now.`,
			},
		});
	});

	it("a Yes applies the rule to the store's charges a person hasn't chosen, and leaves a person's choice alone (#353)", async () => {
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const today = todayIn(DEFAULT_TIME_ZONE);
		const uncategorized = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1200, 'SQ *LOCAL BAKERY 4432') RETURNING id",
		)
			.bind(today)
			.first<{ id: number }>();
		const jev = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1300, 'SQ *LOCAL BAKERY 4432', 3, 'jev') RETURNING id",
		)
			.bind(today)
			.first<{ id: number }>();
		const user = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1400, 'SQ *LOCAL BAKERY 4432', 4, 'user') RETURNING id",
		)
			.bind(today)
			.first<{ id: number }>();
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(save.html).store,
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: {
				message: `Local Bakery is always ${await categoryName(2)} now.`,
			},
		});
		expect(html).not.toContain("rule-offer-title");
		const charge = (id: number | undefined) =>
			env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first();
		expect(await charge(uncategorized?.id)).toEqual({
			category_id: 2,
			category_source: "merchant_rule",
		});
		expect(await charge(jev?.id)).toEqual({
			category_id: 2,
			category_source: "merchant_rule",
		});
		expect(await charge(user?.id)).toEqual({
			category_id: 4,
			category_source: "user",
		});
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
		// The Save before it pushed the question's address, so the answer replaces it with the skips-only address,
		// giving one history entry, not two.
		expect(res.headers.get("HX-Replace-Url")).toBe("/transactions/organize");
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toContain("rule-offer-title");
	});

	/** Files every other store's charges that need a category, so Local Bakery is the last store Organize shows. */
	async function leaveOnlyLocalBakery() {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 3, category_source = 'user' WHERE category_id IS NULL AND COALESCE(NULLIF(merchant_name, ''), raw_name) != 'SQ *LOCAL BAKERY 4432'",
		).run();
		const { html } = await get();
		expect(html).toMatch(/1 of 1 · \d+ left, all months/);
		expect(html).toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
	}

	it("Not now on the last store focuses the sentence that says every transaction has a category, and announces it (htmx)", async () => {
		await leaveOnlyLocalBakery();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const { res, html } = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(save.html).store,
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			announce: "Every transaction has a category.",
		});
		expect(html).toMatch(
			/<p(?=[^>]*tabindex="-1")(?=[^>]*autofocus)[^>]*>Every transaction has a category\.<\/p>/,
		);
		expect(html).not.toContain("rule-offer-title");
	});

	it("Yes on the last store writes the rule, announces the toast then the sentence, and focuses the sentence (htmx)", async () => {
		await leaveOnlyLocalBakery();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(save.html).store,
			},
			"/transactions/organize/rule",
			true,
		);
		const message = `Local Bakery is always ${await categoryName(2)} now.`;
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message, type: "success" },
			announce: `${message} Every transaction has a category.`,
		});
		expect(html).toMatch(
			/<p(?=[^>]*tabindex="-1")(?=[^>]*autofocus)[^>]*>Every transaction has a category\.<\/p>/,
		);
	});

	it("Not now on the last store after skips focuses 'You skipped the rest.' and announces it (htmx)", async () => {
		const others = (await organizeGroups(env.DB))
			.map((group) => group.name)
			.filter((name) => name !== "Local Bakery");
		expect(others.length).toBeGreaterThan(0);
		const skips = new URLSearchParams(
			others.map((name): [string, string] => ["skip", name]),
		).toString();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			`/transactions/organize?${skips}`,
			true,
		);
		const { res, html } = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(save.html).store,
			},
			`/transactions/organize/rule?${skips}`,
			true,
		);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			announce: "You skipped the rest.",
		});
		expect(html).toMatch(
			/<p(?=[^>]*tabindex="-1")(?=[^>]*autofocus)[^>]*>You skipped the rest\.<\/p>/,
		);
		expect(html).not.toContain("rule-offer-title");
	});

	it("a plain GET of an empty Organize keeps its sentence unfocused", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id IS NULL",
		).run();
		const { html } = await get();
		const sentence =
			html.match(/<p[^>]*>Every transaction has a category\.<\/p>/)?.[0] ?? "";
		expect(sentence).toMatch(/^<p/);
		expect(sentence).not.toContain("tabindex");
		expect(sentence).not.toContain("autofocus");
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
		expect(res.headers.get("HX-Push-Url")).toBeNull();
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
		const { res } = await post(
			{ category: "2", name: "", group: "Bulk merchant" },
			"/transactions/organize",
			true,
		);
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
		// The save redirects to the question, and the question's address keeps the skip.
		expect(saved.status).toBe(303);
		expect(
			new URL(BASE + (saved.headers.get("Location") ?? "")).searchParams.getAll(
				"skip",
			),
		).toEqual([first]);
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
		expect(
			new URL(BASE + (moved.headers.get("Location") ?? "")).searchParams.getAll(
				"skip",
			),
		).toEqual([first]);
		const after = await get(moved.headers.get("Location") ?? "");
		expect(after.html).not.toMatch(new RegExp(`<h2[^>]*>${first}</h2>`));
	});
});

describe("Organize's question is one question (#532)", () => {
	/**
	 * Corner Kiosk's two merchant keys: KIOSK ONE has a charge Save files, and KIOSK TWO has one the person filed under
	 * category 2 by hand, which the question must also name.
	 */
	const kiosk = () =>
		env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('KIOSK ONE', 'Corner Kiosk')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('KIOSK TWO', 'Corner Kiosk')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 1000, 'KIOSK ONE')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1000, 'KIOSK TWO', 2, 'user')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);

	/** The rule and the toast Yes on Corner Kiosk's question makes, asserted the same whichever page answered it. */
	const expectKioskRuleMade = async (res: Response) => {
		expect(await ruleOf("KIOSK ONE")).toBe(2);
		expect(await ruleOf("KIOSK TWO")).toBe(2);
		const message = `Corner Kiosk is always ${await categoryName(2)} now.`;
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { message, type: "success" },
			announce: message,
		});
	};

	it("an htmx Save asks about the store's charges in the category, the hand-filed one included, at an address naming the same store (#532)", async () => {
		await kiosk();
		const save = await post(
			{ category: "2", name: "", group: "Corner Kiosk" },
			"/transactions/organize",
			true,
		);
		expect(save.html).toContain(
			`Always use ${await categoryName(2)} for Corner Kiosk?`,
		);
		const pushed = save.res.headers.get("HX-Push-Url") ?? "";
		expect(questionFields(save.html).store).toBe(storeOf(pushed));
		const reload = await get(pushed);
		expect(questionFields(reload.html)).toEqual(questionFields(save.html));
		expect(reload.html).toContain(
			`Always use ${await categoryName(2)} for Corner Kiosk?`,
		);
		const charges = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name IN ('KIOSK ONE', 'KIOSK TWO') AND category_id = 2 AND category_source = 'user' ORDER BY id",
		).all<{ id: number }>();
		expect(charges.results).toHaveLength(2);
		expect(
			await storeChargeIds(env.DB, Number(questionFields(save.html).store), 2),
		).toEqual(charges.results.map((row) => row.id));
	});

	it("Yes on Save's question makes the rule on both keys and names the store in the toast (htmx, #532)", async () => {
		await kiosk();
		const save = await post(
			{ category: "2", name: "", group: "Corner Kiosk" },
			undefined,
			true,
		);
		const { res } = await yesFrom(save.html, undefined, true);
		await expectKioskRuleMade(res);
	});

	it("Yes on the reloaded question makes the same rules and toast (htmx, #532)", async () => {
		await kiosk();
		const save = await post(
			{ category: "2", name: "", group: "Corner Kiosk" },
			"/transactions/organize",
			true,
		);
		const reload = await get(save.res.headers.get("HX-Push-Url") ?? "");
		const { res } = await yesFrom(reload.html, undefined, true);
		await expectKioskRuleMade(res);
	});

	it("with JavaScript off, Save's address asks the same question, and Yes from it makes the same rules (#532)", async () => {
		await kiosk();
		const save = await post({ category: "2", name: "", group: "Corner Kiosk" });
		expect(save.res.status).toBe(303);
		const location = save.res.headers.get("Location") ?? "";
		const { html } = await get(location);
		expect(questionFields(html)).toEqual({
			store: storeOf(location),
			category: "2",
		});
		expect(html).toContain(
			`Always use ${await categoryName(2)} for Corner Kiosk?`,
		);
		const { res } = await yesFrom(html);
		expect(res.status).toBe(303);
		expect(await ruleOf("KIOSK ONE")).toBe(2);
		expect(await ruleOf("KIOSK TWO")).toBe(2);
	});

	/** An older charge of Local Bakery that Jev says looks mixed, filed under category 2 by hand. */
	const mixedBakeryCharge = () =>
		env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, jev_mixed, jev_category_id, jev_also_category_id) VALUES (1, '2026-08-01', 900, 'SQ *LOCAL BAKERY 4432', 2, 'user', 0.9, 2, 3)",
		).run();

	it("an htmx Save of a store whose charges look mixed asks no question, and gives the save's toast alone (#532)", async () => {
		await mixedBakeryCharge();
		const { res, html } = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		expect(res.status).toBe(200);
		expect(html).not.toContain("rule-offer-title");
		expect(res.headers.get("HX-Push-Url")).toBeNull();
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
	});

	it("a no-JavaScript Save of a store whose charges look mixed redirects to the ordinary page (#532)", async () => {
		await mixedBakeryCharge();
		const { res } = await post({
			category: "2",
			name: "",
			group: "Local Bakery",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions/organize");
	});

	it("a Yes with no store or category, or junk in them, makes no rule and moves on to the next store (#532)", async () => {
		await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize",
			true,
		);
		const rules = () =>
			env.DB.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE default_category_id IS NOT NULL",
			).first<{ n: number }>();
		const before = await rules();
		const bare = await post(
			{ answer: "yes", merchant: "Local Bakery" },
			"/transactions/organize/rule",
		);
		expect(bare.res.status).toBe(303);
		expect(bare.res.headers.get("Location")).toBe("/transactions/organize");
		for (const fields of [
			{ store: "abc", category: "2" },
			{ store: "999999", category: "2" },
		]) {
			const { res, html } = await post(
				{ answer: "yes", ...fields },
				"/transactions/organize/rule",
				true,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).not.toContain("rule-offer-title");
			expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		}
		expect(await rules()).toEqual(before);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
	});
});

describe("Organize's question with JavaScript off (#353)", () => {
	it("a Save redirects to the question's own address, where a reload asks the same question", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		expect(save.res.status).toBe(303);
		const location = save.res.headers.get("Location") ?? "";
		const url = new URL(BASE + location);
		expect(url.pathname).toBe("/transactions/organize");
		expect(url.searchParams.get("category")).toBe("2");
		expect(url.searchParams.has("saved")).toBe(false);
		expect(storeOf(location)).toMatch(/^\d+$/);

		const first = await get(location);
		expect(first.res.status).toBe(200);
		expect(first.html).toMatch(
			/<h2[^>]*id="rule-offer-title"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		expect(first.html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
		expect(questionFields(first.html).store).toBe(storeOf(location));
		expect(questionFields(first.html).category).toBe("2");

		const reload = await get(location);
		expect(questionFields(reload.html)).toEqual(questionFields(first.html));
		expect(reload.html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
	});

	it("the question names the store as the save typed it", async () => {
		const save = await post({
			category: "2",
			name: "The Bakery",
			group: "Local Bakery",
		});
		const { html } = await followRedirect(save);
		expect(html).toContain(
			`Always use ${await categoryName(2)} for The Bakery?`,
		);
	});

	it("the question's form posts to the rule route with the skips only, and Not now moves on with the skips", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT OR REPLACE INTO merchants (raw_name, display_name) VALUES ('RAW ONE', 'Other store')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (1, ?, 50000, 'RAW ONE')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			"/transactions/organize?skip=Other%20store",
		);
		const { html } = await followRedirect(save);
		expect(html).toContain(
			'action="/transactions/organize/rule?skip=Other+store"',
		);
		const notNow = await post(
			{
				answer: "no",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(html).store,
			},
			"/transactions/organize/rule?skip=Other+store",
		);
		expect(notNow.res.status).toBe(303);
		const next = new URL(BASE + (notNow.res.headers.get("Location") ?? ""));
		expect(next.pathname).toBe("/transactions/organize");
		expect(next.searchParams.getAll("skip")).toEqual(["Other store"]);
		expect(next.searchParams.has("category")).toBe(false);
		expect(next.searchParams.has("store")).toBe(false);
		expect(next.searchParams.has("saved")).toBe(false);
		const page = await get(next.pathname + next.search);
		expect(page.html).not.toContain("rule-offer-title");
		expect(page.html).not.toMatch(/<h2[^>]*>Other store<\/h2>/);
	});

	it("after Yes, the question's address asks nothing more and shows the next store", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const questionPath = save.res.headers.get("Location") ?? "";
		const { html } = await get(questionPath);
		const yes = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				store: questionFields(html).store,
			},
			"/transactions/organize/rule",
		);
		expect(yes.res.status).toBe(303);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		const back = await get(questionPath);
		expect(back.res.status).toBe(200);
		expect(back.html).not.toContain("rule-offer-title");
		expect(back.html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
	});

	it("an address whose store or category holds no question shows no question, and never an error", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const store = storeOf(save.res.headers.get("Location") ?? "");
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('OTHER RAW', 'Other store')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 500, 'OTHER RAW', 3, 'user')",
			).bind(todayIn(DEFAULT_TIME_ZONE)),
		]);
		const otherStore = await env.DB.prepare(
			"SELECT rowid AS id FROM merchants WHERE raw_name = 'OTHER RAW'",
		).first<{ id: number }>();
		const crafted: Record<string, string> = {
			"another category": `/transactions/organize?category=3&store=${store}`,
			"a store that does not exist":
				"/transactions/organize?category=2&store=999999",
			"a store with no charges in this category": `/transactions/organize?category=2&store=${otherStore?.id}`,
			junk: "/transactions/organize?category=x&store=abc",
			"a missing category": `/transactions/organize?category=999&store=${store}`,
			"no store": "/transactions/organize?category=2",
			"an address from before #532, with saved ids":
				"/transactions/organize?category=2&saved=1.2",
		};
		for (const [name, path] of Object.entries(crafted)) {
			const { res, html } = await get(path);
			expect(res.status, name).toBe(200);
			expect(html, name).not.toContain("rule-offer-title");
		}
		// The same store and category asks, so the checks above fail for the reason they name.
		const { html } = await get(
			`/transactions/organize?category=2&store=${store}`,
		);
		expect(html).toContain("rule-offer-title");
	});

	it("an archived category shows no question", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const path = save.res.headers.get("Location") ?? "";
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 2",
		).run();
		const { res, html } = await get(path);
		expect(res.status).toBe(200);
		expect(html).not.toContain("rule-offer-title");
	});

	it("a store's address asks about that store alone, though another store holds the category", async () => {
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('STORE TWO RAW', 'Store two')",
		).run();
		const other = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 500, 'STORE TWO RAW', 2, 'user') RETURNING id",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<{ id: number }>();
		expect(other?.id).toBeDefined();
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const store = storeOf(save.res.headers.get("Location") ?? "");
		const storeTwo = await env.DB.prepare(
			"SELECT rowid AS id FROM merchants WHERE raw_name = 'STORE TWO RAW'",
		).first<{ id: number }>();
		const bakery = await get(
			`/transactions/organize?category=2&store=${store}`,
		);
		expect(bakery.html).toContain("rule-offer-title");
		expect(questionFields(bakery.html).store).toBe(store);
		expect(await storeChargeIds(env.DB, Number(store), 2)).not.toContain(
			other?.id,
		);
		const two = await get(
			`/transactions/organize?category=2&store=${storeTwo?.id}`,
		);
		expect(two.html).toContain(
			`Always use ${await categoryName(2)} for Store two?`,
		);
		expect(questionFields(two.html).store).toBe(String(storeTwo?.id));
		expect(await storeChargeIds(env.DB, storeTwo?.id ?? 0, 2)).toEqual([
			other?.id,
		]);
	});
});

describe("Organize's question address stays bounded (#532)", () => {
	/** One store of 2,000 charges, each under its own bank text, so it is 2,000 merchant keys that tidy to one name. */
	const bigStore = () =>
		env.DB.prepare(
			"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO transactions (account_id, date, amount_cents, raw_name) SELECT 1, ?, 1000, 'STORE*' || printf('%04d', i) FROM n",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.run();

	it("an htmx Save of 2,000 charges pushes an address under 200 characters with no bank text, and a reload asks the same question", async () => {
		await bigStore();
		const save = await post(
			{ category: "2", name: "", group: "Store" },
			"/transactions/organize",
			true,
		);
		const pushed = save.res.headers.get("HX-Push-Url") ?? "";
		expect(pushed.length).toBeLessThan(200);
		expect(pushed).not.toContain("STORE*");
		const filed = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'STORE*%' AND category_id = 2 AND category_source = 'user'",
		).first<{ n: number }>();
		expect(filed?.n).toBe(2000);

		const reload = await get(pushed);
		expect(reload.res.status).toBe(200);
		expect(reload.html).toContain("rule-offer-title");
		expect(reload.html).toContain(
			`Always use ${await categoryName(2)} for Store?`,
		);
		expect(questionFields(reload.html).store).toBe(storeOf(pushed));
		expect(
			await storeChargeIds(env.DB, Number(storeOf(pushed)), 2),
		).toHaveLength(2000);
	});

	it("a no-JavaScript Save of 2,000 charges redirects to an address under 200 characters with no bank text", async () => {
		await bigStore();
		const save = await post({ category: "2", name: "", group: "Store" });
		const location = save.res.headers.get("Location") ?? "";
		expect(save.res.status).toBe(303);
		expect(location.length).toBeLessThan(200);
		expect(location).not.toContain("STORE*");
		const { html } = await get(location);
		expect(html).toContain("rule-offer-title");
		expect(
			await storeChargeIds(env.DB, Number(storeOf(location)), 2),
		).toHaveLength(2000);
	});

	it("a question whose store has no charges in the category shows the ordinary page", async () => {
		await bigStore();
		const save = await post({ category: "2", name: "", group: "Store" });
		const location = save.res.headers.get("Location") ?? "";
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id = 2 AND raw_name LIKE 'STORE*%'",
		).run();
		const { res, html } = await get(location);
		expect(res.status).toBe(200);
		expect(html).not.toContain("rule-offer-title");
	});

	it("a reload asks about the store's charges still in the category, once some have moved", async () => {
		await bigStore();
		const save = await post({ category: "2", name: "", group: "Store" });
		const location = save.res.headers.get("Location") ?? "";
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1 WHERE category_id = 2 AND raw_name = 'STORE*0001'",
		).run();
		const { html } = await get(location);
		expect(html).toContain("rule-offer-title");
		expect(
			await storeChargeIds(env.DB, Number(storeOf(location)), 2),
		).toHaveLength(1999);
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
