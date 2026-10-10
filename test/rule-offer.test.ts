import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { removeMerchantRule } from "../src/db/merchant-rules";
import { resetDemo } from "../src/demo/reset";
import { firstRuleOfferAmong } from "../src/transactions/rule-offer";

const BASE = "http://tally.test";
const QUESTION = "Always use Groceries for rule-offer-store?";

async function send(
	path: string,
	fields: Record<string, string>,
	headers: Record<string, string>,
) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...headers,
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

/** A save the way htmx sends it. */
function post(path: string, fields: Record<string, string>) {
	return send(path, fields, { "HX-Request": "true" });
}

/** A save with JavaScript off: no HX-Request header, so the reply is a redirect or a whole page. */
function postPlain(path: string, fields: Record<string, string>) {
	return send(path, fields, {});
}

/** The screen reader's words for a reply, from its HX-Trigger header. */
function announced(res: Response): string {
	return JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce as string;
}

/** The hidden fields of the rule offer's own form, as the page posts them back. */
function offerFields(html: string): Record<string, string> {
	return [
		...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g),
	]
		.filter((match) =>
			["merchant_key", "merchant", "category", "count", "back"].includes(
				match[1] ?? "",
			),
		)
		.reduce<Record<string, string>>((fields, match) => {
			fields[match[1] ?? ""] = match[2] ?? "";
			return fields;
		}, {});
}

async function setCategory(
	picked: (number | undefined)[],
	category: number | null,
	source: string | null,
) {
	const ids = picked.filter((id): id is number => id !== undefined);
	const placeholders = ids.map(() => "?").join(", ");
	await env.DB.prepare(
		`UPDATE transactions SET category_id = ?, category_source = ? WHERE id IN (${placeholders})`,
	)
		.bind(category, source, ...ids)
		.run();
}

/** Adds `count` Groceries picks for a new merchant, and returns their ids in order. */
async function addPicks(name: string, count: number, category: number) {
	await env.DB.prepare(
		`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES ${Array.from({ length: count }, () => "(1, ?, 1000, ?, ?, ?, 'user')").join(", ")}`,
	)
		.bind(
			...Array.from({ length: count }, () => [
				todayIn(DEFAULT_TIME_ZONE),
				name,
				name,
				category,
			]).flat(),
		)
		.run();
	const rows = await env.DB.prepare(
		"SELECT id FROM transactions WHERE merchant_name = ? ORDER BY id",
	)
		.bind(name)
		.all<{ id: number }>();
	return rows.results.map((row) => row.id);
}

let merchant: string;
let groceries: number;
let household: number;
let ids: number[];

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	merchant = "rule-offer-store";
	const categories = await env.DB.prepare(
		"SELECT id, name FROM categories WHERE name IN ('Groceries', 'Household')",
	).all<{ id: number; name: string }>();
	groceries = categories.results.find((c) => c.name === "Groceries")?.id ?? 0;
	household = categories.results.find((c) => c.name === "Household")?.id ?? 0;
	await env.DB.prepare("INSERT INTO merchants (raw_name) VALUES (?)")
		.bind(merchant)
		.run();
	await env.DB.prepare(
		"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?), (1, ?, 1000, ?, ?)",
	)
		.bind(
			...Array.from({ length: 4 }, () => [
				todayIn(DEFAULT_TIME_ZONE),
				merchant,
				merchant,
			]).flat(),
		)
		.run();
	ids = await env.DB.prepare(
		"SELECT id FROM transactions WHERE merchant_name = ? ORDER BY id",
	)
		.bind(merchant)
		.all<{ id: number }>()
		.then((r) => r.results.map((row) => row.id));
});

const edit = (category: number) => ({
	category: String(category),
	merchant: "",
	merchant_was: "",
	name_pick: "",
	note: "",
	excluded: "0",
	income: "0",
	creditReviewed: "0",
	back: "/transactions",
});

describe("merchant category rule offer", () => {
	it("offers on the third matching save with the real count, then again on the fourth", async () => {
		await post(`/transactions/${ids[0]}`, edit(groceries));
		const second = await post(`/transactions/${ids[1]}`, edit(groceries));
		expect(second.html).not.toContain(QUESTION);
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		expect(third.html).toContain(QUESTION);
		expect(third.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
		expect(
			JSON.parse(third.res.headers.get("HX-Trigger") ?? "{}").announce,
		).toContain(QUESTION);
		const fourth = await post(`/transactions/${ids[3]}`, edit(groceries));
		expect(fourth.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 4 times.",
		);
	});

	it("still offers when the store also has another category's picks (decision 90: nothing counts a store's categories)", async () => {
		await setCategory([ids[0]], household, "user");
		await setCategory([ids[1], ids[2]], groceries, "user");
		await setCategory([ids[3]], null, null);
		// Two Groceries picks and one Household pick: the third Groceries pick is asked.
		const third = await post(`/transactions/${ids[3]}`, edit(groceries));
		expect(third.html).toContain(QUESTION);
		expect(third.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
	});

	it("counts a pick on a row Jev flagged as a transfer once the person includes it", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		await env.DB.prepare(
			"UPDATE transactions SET flag_transfer = 1, excluded = 1, excluded_source = 'jev' WHERE id = ?",
		)
			.bind(ids[2])
			.run();
		// The person unticks Excluded and picks Groceries: that is a third pick, so it is asked.
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		expect(third.html).toContain(QUESTION);
		expect(third.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
	});

	it("does not offer for a merchant that already has a rule, even on a third save", async () => {
		await setCategory(ids.slice(0, 3), groceries, "user");
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
		)
			.bind(groceries, merchant)
			.run();
		// Four Groceries picks now: without the rule check this save would be asked.
		const ruled = await post(`/transactions/${ids[3]}`, edit(groceries));
		expect(ruled.html).not.toContain(QUESTION);
	});

	it("Select offers only for the merchant whose selected category reaches three", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other')",
		)
			.bind(
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
			)
			.run();
		const other = await env.DB.prepare(
			"SELECT id FROM transactions WHERE merchant_name = 'other' ORDER BY id",
		).all<{ id: number }>();
		const otherIds = other.results.map((row) => row.id);
		await setCategory(otherIds.slice(0, 2), household, "user");
		const selected = await post("/transactions/select/category/save", {
			ids: `${ids[2]},${otherIds[2] ?? 0}`,
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(
			selected.html.match(/Always use Groceries for rule-offer-store\?/g),
		).toHaveLength(1);
		expect(selected.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
		expect(selected.html).not.toContain("Always use Groceries for other?");
	});

	it("Select with no merchant at three says what it set and asks nothing", async () => {
		const selected = await post("/transactions/select/category/save", {
			ids: `${ids[0]},${ids[1]}`,
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(selected.html).not.toContain(QUESTION);
		expect(
			JSON.parse(selected.res.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Set 2 transactions to Groceries.");
	});

	it("announces each save's own words before the question, on every path that asks", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const edited = await post(`/transactions/${ids[2]}`, edit(groceries));
		expect(announced(edited.res)).toBe(
			"Saved. rule-offer-store is now Groceries. Always use Groceries for rule-offer-store? You've picked Groceries for rule-offer-store 3 times.",
		);
		await setCategory([ids[2]], null, null);
		const selected = await post("/transactions/select/category/save", {
			ids: String(ids[2]),
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(announced(selected.res)).toBe(
			"Set 1 transaction to Groceries. Always use Groceries for rule-offer-store? You've picked Groceries for rule-offer-store 3 times.",
		);
		await setCategory([ids[3]], null, null);
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant,
			category: String(groceries),
			note: "",
			back: "/transactions",
		});
		// The cash entry is a fourth Groceries pick, so the count is four.
		expect(announced(cash.res)).toBe(
			"Added $10.00 cash spending at rule-offer-store. Always use Groceries for rule-offer-store? You've picked Groceries for rule-offer-store 4 times.",
		);
	});

	it("without JavaScript, a second save redirects and a third save shows the question", async () => {
		const first = await postPlain(`/transactions/${ids[0]}`, edit(groceries));
		expect(first.res.status).toBe(303);
		const second = await postPlain(`/transactions/${ids[1]}`, edit(groceries));
		expect(second.res.status).toBe(303);
		const third = await postPlain(`/transactions/${ids[2]}`, edit(groceries));
		expect(third.res.status).toBe(200);
		expect(third.html).toContain(QUESTION);
	});

	it("without JavaScript, a third cash save with an entry key shows the question", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const cash = await postPlain("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant,
			category: String(groceries),
			note: "",
			back: "/transactions",
			entry_key: "123e4567-e89b-42d3-a456-426614174001",
		});
		expect(cash.res.status).toBe(200);
		expect(cash.html).toContain(QUESTION);
	});

	it("without JavaScript, Yes still makes the rule and redirects back", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		const yes = await postPlain(
			"/transactions/rule-offer",
			offerFields(third.html),
		);
		expect(yes.res.status).toBe(303);
		expect(yes.res.headers.get("Location")).toBe("/transactions");
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number | null }>();
		expect(rule?.default_category_id).toBe(groceries);
	});

	it("Yes makes the rule and recategorizes other rows, but not a person's own choice", async () => {
		await setCategory(ids.slice(0, 3), groceries, "user");
		await setCategory([ids[3]], null, null);
		// A Tally guess is not a person's choice, so Yes replaces it.
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, 1000, ?, ?, ?, 'jev')",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE), merchant, merchant, household)
			.run();
		// A refund a person put in Household is a choice Yes never overwrites, and it isn't counted.
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, ?, -1000, ?, ?, ?, 'user')",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE), merchant, merchant, household)
			.run();
		const guess = await env.DB.prepare(
			"SELECT id FROM transactions WHERE merchant_name = ? AND category_source = 'jev'",
		)
			.bind(merchant)
			.first<{ id: number }>();
		const refund = await env.DB.prepare(
			"SELECT id FROM transactions WHERE merchant_name = ? AND amount_cents < 0",
		)
			.bind(merchant)
			.first<{ id: number }>();
		const offer = await post(`/transactions/${ids[3]}`, edit(groceries));
		const yes = await post("/transactions/rule-offer", offerFields(offer.html));
		expect(yes.res.status).toBe(200);
		expect(
			JSON.parse(yes.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe(`Always use Groceries for ${merchant}.`);
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number }>();
		expect(rule?.default_category_id).toBe(groceries);
		const rows = await env.DB.prepare(
			"SELECT id, category_id, category_source FROM transactions WHERE merchant_name = ? ORDER BY id",
		)
			.bind(merchant)
			.all<{
				id: number;
				category_id: number | null;
				category_source: string | null;
			}>();
		const byId = new Map(rows.results.map((row) => [row.id, row]));
		for (const id of ids)
			expect(byId.get(id)).toMatchObject({
				category_id: groceries,
				category_source: "user",
			});
		expect(byId.get(guess?.id ?? 0)).toMatchObject({
			category_id: groceries,
			category_source: "merchant_rule",
		});
		expect(byId.get(refund?.id ?? 0)).toMatchObject({
			category_id: household,
			category_source: "user",
		});
	});

	it("the offer's two forms swap the whole main area, as the Set category sheet does", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		for (const action of [
			"/transactions/rule-offer/dismiss",
			"/transactions/rule-offer",
		]) {
			const form =
				third.html.match(
					new RegExp(`<form[^>]*action="${action}"[^>]*>`),
				)?.[0] ?? "";
			expect(form).toContain('hx-target="#main"');
			expect(form).toMatch(/hx-select="#main (>|&gt;) \*"/);
			expect(form).toContain('hx-swap="innerHTML"');
		}
	});

	it("Yes and Not now answer with the transactions heading focused", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		const yes = await post("/transactions/rule-offer", offerFields(third.html));
		const dismissed = await post(
			"/transactions/rule-offer/dismiss",
			offerFields(third.html),
		);
		for (const reply of [yes.html, dismissed.html])
			expect(reply).toMatch(
				/<h1[^>]*id="transactions-title"[^>]*tabindex="-1"[^>]*autofocus/,
			);
	});

	it("Yes refreshes the Needs category count, since the rule fills the merchant's uncategorized rows", async () => {
		const needsCount = (html: string) =>
			Number(html.match(/id="needs-count">(\d+)</)?.[1]);
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		const before = needsCount(third.html);
		const yes = await post("/transactions/rule-offer", offerFields(third.html));
		expect(needsCount(yes.html)).toBe(before - 1);
	});

	it("Not now closes the panel without making a rule, and a later matching save asks again", async () => {
		for (const id of ids.slice(0, 3))
			await post(`/transactions/${id}`, edit(groceries));
		const panel = await post(`/transactions/${ids[3]}`, edit(groceries));
		const ignored = await post(
			"/transactions/rule-offer/dismiss",
			offerFields(panel.html),
		);
		expect(ignored.res.status).toBe(200);
		expect(ignored.html).not.toContain(QUESTION);
		expect(
			JSON.parse(ignored.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Saved as Groceries.");
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number | null }>();
		expect(rule?.default_category_id).toBeNull();
		await setCategory([ids[0]], null, null);
		const fifth = await post(`/transactions/${ids[0]}`, edit(groceries));
		expect(fifth.html).toContain(QUESTION);
	});

	it("counts Organize and cash picks the same as panel picks", async () => {
		// Only ids[0] needs a category, so Organize picks just that row.
		await setCategory([ids[1], ids[2], ids[3]], household, "jev");
		const organized = await post("/transactions/organize", {
			category: String(groceries),
			group: merchant,
			name: merchant,
		});
		expect(organized.res.status).toBe(200);
		const picked = await env.DB.prepare(
			"SELECT category_id, category_source FROM transactions WHERE id = ?",
		)
			.bind(ids[0])
			.first<{ category_id: number; category_source: string }>();
		expect(picked).toMatchObject({
			category_id: groceries,
			category_source: "user",
		});
		// A rule made, then removed in Settings: the earlier picks still count.
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
		)
			.bind(groceries, merchant)
			.run();
		expect(await removeMerchantRule(env.DB, merchant)).toBe(merchant);
		const panel = await post(`/transactions/${ids[1]}`, edit(groceries));
		expect(panel.html).not.toContain(QUESTION);
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant,
			category: String(groceries),
			note: "",
			back: "/transactions",
			entry_key: "123e4567-e89b-42d3-a456-426614174000",
		});
		expect(cash.html).toContain(QUESTION);
		expect(cash.html).toContain(
			"You&#39;ve picked Groceries for rule-offer-store 3 times.",
		);
	});

	it("the Yes toast names the merchant the question named, when the bank's text differs from the merchant key", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		// The save gives no name, so the question names the tidied bank text, not the merchant key.
		await env.DB.prepare("UPDATE transactions SET raw_name = ? WHERE id = ?")
			.bind("SQ RULE OFFER STORE", ids[2])
			.run();
		const third = await post(`/transactions/${ids[2]}`, edit(groceries));
		const asked = third.html.match(/Always use Groceries for ([^?<]+)\?/)?.[1];
		expect(asked).toBeTruthy();
		const yes = await post("/transactions/rule-offer", offerFields(third.html));
		expect(
			JSON.parse(yes.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe(`Always use Groceries for ${asked}.`);
	});

	it("the Yes toast names the merchant as the save renamed it", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, {
			...edit(groceries),
			merchant: "Fresh Market",
		});
		const yes = await post("/transactions/rule-offer", offerFields(third.html));
		expect(
			JSON.parse(yes.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Always use Groceries for Fresh Market.");
	});

	it("announces an exclusion with the question on a third save that excludes the transaction", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, {
			...edit(groceries),
			excluded: "1",
		});
		const announce = JSON.parse(third.res.headers.get("HX-Trigger") ?? "{}")
			.announce as string;
		// The save's words, the exclusion and then the question, in that order.
		expect(announce).toBe(
			"Saved. rule-offer-store is now Groceries. It's excluded from the budget. Always use Groceries for rule-offer-store? You've picked Groceries for rule-offer-store 3 times.",
		);
	});

	it("asks after a cash entry saved without an entry key", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant,
			category: String(groceries),
			note: "",
			back: "/transactions",
		});
		expect(cash.html).toContain(QUESTION);
	});

	it("does not ask on a third save that also ticks Always for this merchant", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, {
			...edit(groceries),
			always: "1",
		});
		expect(third.html).not.toContain(QUESTION);
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = ?",
		)
			.bind(merchant)
			.first<{ default_category_id: number | null }>();
		expect(rule?.default_category_id).toBe(groceries);
	});

	it("names the merchant as the save renamed it on the third pick", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		const third = await post(`/transactions/${ids[2]}`, {
			...edit(groceries),
			merchant: "Fresh Market",
		});
		expect(third.html).toContain("Always use Groceries for Fresh Market?");
		expect(
			JSON.parse(third.res.headers.get("HX-Trigger") ?? "{}").announce,
		).toContain("Always use Groceries for Fresh Market?");
	});

	it("asks one merchant when a Select save takes two merchants to three, and the other on its next matching save", async () => {
		await setCategory([ids[0], ids[1]], groceries, "user");
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name) VALUES (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other'), (1, ?, 1000, 'other', 'other')",
		)
			.bind(
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
				todayIn(DEFAULT_TIME_ZONE),
			)
			.run();
		const otherIds = await env.DB.prepare(
			"SELECT id FROM transactions WHERE merchant_name = 'other' ORDER BY id",
		)
			.all<{ id: number }>()
			.then((r) => r.results.map((row) => row.id));
		await setCategory(otherIds.slice(0, 2), groceries, "user");
		const selected = await post("/transactions/select/category/save", {
			ids: `${ids[2]},${otherIds[2] ?? 0}`,
			category: String(groceries),
			back: "/transactions?select=1",
		});
		expect(
			selected.html.match(/Always use Groceries for [^?<]+\?/g),
		).toHaveLength(1);
		expect(selected.html).toContain(QUESTION);
		// The other merchant has three picks now, so its next matching save asks.
		await setCategory([otherIds[0]], null, null);
		const next = await post(`/transactions/${otherIds[0]}`, edit(groceries));
		expect(next.html).toContain("Always use Groceries for other?");
	});

	it("Yes makes the rule for a merchant with no settings row yet", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, ?, 1000, 'cash-only-store', ?, 'user'), (1, ?, 1000, 'cash-only-store', ?, 'user')",
		)
			.bind(
				todayIn(DEFAULT_TIME_ZONE),
				groceries,
				todayIn(DEFAULT_TIME_ZONE),
				groceries,
			)
			.run();
		const cash = await post("/transactions/cash", {
			date: todayIn(DEFAULT_TIME_ZONE),
			amount: "10.00",
			merchant: "cash-only-store",
			category: String(groceries),
			note: "",
			back: "/transactions",
		});
		expect(cash.html).toContain("Always use Groceries for cash-only-store?");
		const before = await env.DB.prepare(
			"SELECT raw_name FROM merchants WHERE raw_name = 'cash-only-store'",
		).first();
		expect(before).toBeNull();
		const yes = await post("/transactions/rule-offer", {
			merchant_key: "cash-only-store",
			category: String(groceries),
			count: "3",
			back: "/transactions",
		});
		expect(yes.res.status).toBe(200);
		const rule = await env.DB.prepare(
			"SELECT default_category_id FROM merchants WHERE raw_name = 'cash-only-store'",
		).first<{ default_category_id: number | null }>();
		expect(rule?.default_category_id).toBe(groceries);
	});
});

describe("firstRuleOfferAmong", () => {
	it("returns the qualifying merchant whose selected row has the lower id, with its count and that row", async () => {
		// rule-offer-store has a rule, so it is never offered, even with the lowest ids.
		await setCategory(ids.slice(0, 3), groceries, "user");
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = ? WHERE raw_name = ?",
		)
			.bind(groceries, merchant)
			.run();
		// under-store has two picks, so it is under three; first-store and second-store each have three.
		const under = await addPicks("under-store", 2, groceries);
		const first = await addPicks("first-store", 3, groceries);
		const second = await addPicks("second-store", 3, groceries);
		// The selection lists second-store first, but first-store's selected row has the lower id.
		const offer = await firstRuleOfferAmong(
			env.DB,
			[second[0] ?? 0, first[0] ?? 0, under[0] ?? 0, ids[0] ?? 0],
			groceries,
		);
		expect(offer).toEqual({
			merchantKey: "first-store",
			categoryId: groceries,
			count: 3,
			transactionId: first[0],
		});
	});

	it("returns null when no selected merchant reaches three picks", async () => {
		const under = await addPicks("under-store", 2, groceries);
		const offer = await firstRuleOfferAmong(
			env.DB,
			[under[0] ?? 0, ids[0] ?? 0],
			groceries,
		);
		expect(offer).toBeNull();
	});
});
