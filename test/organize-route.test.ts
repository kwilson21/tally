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

/** The ids of the charges a save filed, as the question's hidden `saved` field carries them back (JSON). */
const savedIdsIn = (html: string) =>
	html.match(/name="saved" value="([^"]*)"/)?.[1] ?? "[]";

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
				saved: savedIdsIn(question),
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
				saved: savedIdsIn(save.html),
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
				saved: savedIdsIn(question),
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
				saved: savedIdsIn(save.html),
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
		const ids = JSON.parse(savedIdsIn(save.html)) as number[];
		expect(ids.length).toBeGreaterThan(0);
		expect(save.res.headers.get("HX-Push-Url")).toBe(
			`/transactions/organize?skip=Other+store&category=2&saved=${ids.join(".")}`,
		);
		const reload = await get(save.res.headers.get("HX-Push-Url") ?? "");
		expect(reload.res.status).toBe(200);
		expect(reload.html).toContain("rule-offer-title");
		expect(reload.html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
		expect(JSON.parse(savedIdsIn(reload.html))).toEqual(ids);
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
				saved: savedIdsIn(question),
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
				saved: savedIdsIn(question),
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

	it("a Yes after the charges Save filed were changed makes no rule, even with an older charge filed in that category (#353)", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, '2026-08-01', 900, 'SQ *LOCAL BAKERY 4432', 2, 'user')",
		).run();
		const save = await post(
			{ category: "2", name: "", group: "Local Bakery" },
			undefined,
			true,
		);
		const saved = savedIdsIn(save.html);
		expect(JSON.parse(saved).length).toBeGreaterThan(0);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 3 WHERE id IN (SELECT value FROM json_each(?))",
		)
			.bind(saved)
			.run();
		const jev = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 700, 'SQ *LOCAL BAKERY 4432', 3, 'jev') RETURNING id",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<{ id: number }>();
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				saved,
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(html).not.toContain("rule-offer-title");
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
		// A stale Yes applies nothing, so a charge of the store that a person did not choose keeps its category.
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(jev?.id)
				.first(),
		).toEqual({ category_id: 3, category_source: "jev" });
	});

	it("a Yes makes no rule once any charge Save filed has changed, even while the others still hold the category (#353)", async () => {
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
		const saved = JSON.parse(savedIdsIn(save.html)) as number[];
		expect(saved.length).toBeGreaterThan(1);
		await env.DB.prepare("UPDATE transactions SET category_id = 3 WHERE id = ?")
			.bind(saved[0])
			.run();
		const { res, html } = await post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				saved: JSON.stringify(saved),
			},
			"/transactions/organize/rule",
			true,
		);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
	});

	/** Files Local Bakery's charges under category 2, with one more charge to file so Save files two or more. */
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
		const saved = JSON.parse(savedIdsIn(save.html)) as number[];
		expect(saved.length).toBeGreaterThan(1);
		return saved;
	}
	/** Yes on the question for Local Bakery, with the saved list it carries. */
	const yesForBakery = (saved: number[]) =>
		post(
			{
				answer: "yes",
				merchant_keys: JSON.stringify(["SQ *LOCAL BAKERY 4432"]),
				merchant: "Local Bakery",
				category: "2",
				saved: JSON.stringify(saved),
			},
			"/transactions/organize/rule",
			true,
		);

	it("a Yes makes no rule once a charge Save filed was deleted, even while the others hold the category (#353)", async () => {
		const saved = await saveTwoBakeryCharges();
		await env.DB.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(saved[0])
			.run();
		const jev = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 700, 'SQ *LOCAL BAKERY 4432', 3, 'jev') RETURNING id",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.first<{ id: number }>();
		const { res, html } = await yesForBakery(saved);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBeNull();
		expect(res.headers.get("HX-Trigger")).toBeNull();
		expect(html).not.toContain("rule-offer-title");
		expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*autofocus/);
		expect(html).not.toMatch(/<h2[^>]*>Local Bakery<\/h2>/);
		// A stale Yes applies nothing, so the store's charge a person did not choose keeps its category.
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(jev?.id)
				.first(),
		).toEqual({ category_id: 3, category_source: "jev" });
	});

	it("a Yes makes the rule while every charge Save filed still holds the category, with several of them (#353)", async () => {
		const saved = await saveTwoBakeryCharges();
		const { res } = await yesForBakery(saved);
		expect(res.status).toBe(200);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { type: "success" },
		});
	});

	it("a Yes whose saved list repeats an id still makes the rule (#353)", async () => {
		const saved = await saveTwoBakeryCharges();
		await yesForBakery([...saved, saved[0] ?? 0]);
		expect(await ruleOf("SQ *LOCAL BAKERY 4432")).toBe(2);
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
				saved: savedIdsIn(save.html),
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

describe("Organize's question with JavaScript off (#353)", () => {
	it("a Save redirects to the question's own address, where a reload asks the same question", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		expect(save.res.status).toBe(303);
		const location = save.res.headers.get("Location") ?? "";
		const url = new URL(BASE + location);
		expect(url.pathname).toBe("/transactions/organize");
		expect(url.searchParams.get("category")).toBe("2");
		const filed = (url.searchParams.get("saved") ?? "").split(".").map(Number);
		expect(filed.length).toBeGreaterThan(0);

		const first = await get(location);
		expect(first.res.status).toBe(200);
		expect(first.html).toMatch(
			/<h2[^>]*id="rule-offer-title"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		expect(first.html).toContain(
			`Always use ${await categoryName(2)} for Local Bakery?`,
		);
		expect(JSON.parse(savedIdsIn(first.html))).toEqual(filed);

		const reload = await get(location);
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
				saved: savedIdsIn(html),
			},
			"/transactions/organize/rule?skip=Other+store",
		);
		expect(notNow.res.status).toBe(303);
		const next = new URL(BASE + (notNow.res.headers.get("Location") ?? ""));
		expect(next.pathname).toBe("/transactions/organize");
		expect(next.searchParams.getAll("skip")).toEqual(["Other store"]);
		expect(next.searchParams.has("category")).toBe(false);
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
				saved: savedIdsIn(html),
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

	it("an address whose charges no longer hold the category shows no question, and never an error", async () => {
		const save = await post({ category: "2", name: "", group: "Local Bakery" });
		const saved =
			new URL(BASE + (save.res.headers.get("Location") ?? "")).searchParams.get(
				"saved",
			) ?? "";
		const crafted: Record<string, string> = {
			"another category": `/transactions/organize?category=3&saved=${saved}`,
			"a charge that does not exist": `/transactions/organize?category=2&saved=${saved}.999999`,
			junk: "/transactions/organize?category=x&saved=abc",
			"a missing category": `/transactions/organize?category=999&saved=${saved}`,
			"no charges": "/transactions/organize?category=2&saved=",
		};
		for (const [name, path] of Object.entries(crafted)) {
			const { res, html } = await get(path);
			expect(res.status, name).toBe(200);
			expect(html, name).not.toContain("rule-offer-title");
		}
		// The same address with its own charges asks, so the checks above fail for the reason they name.
		const { html } = await get(
			`/transactions/organize?category=2&saved=${saved}`,
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

	it("ids from two differently named stores show no question, though both hold the category", async () => {
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
		const saved =
			new URL(BASE + (save.res.headers.get("Location") ?? "")).searchParams.get(
				"saved",
			) ?? "";
		const alone = await get(`/transactions/organize?category=2&saved=${saved}`);
		expect(alone.html).toContain("rule-offer-title");
		const both = await get(
			`/transactions/organize?category=2&saved=${saved}.${other?.id}`,
		);
		expect(both.res.status).toBe(200);
		expect(both.html).not.toContain("rule-offer-title");
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
