import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { removeMerchantRule } from "../src/db/merchant-rules";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const QUESTION = "Always use Groceries for rule-offer-store?";

async function post(path: string, fields: Record<string, string>) {
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
		expect(announce).toContain("It's excluded from the budget.");
		expect(announce).toContain(QUESTION);
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
