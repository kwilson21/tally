import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { saveAiSwitches } from "../src/db/ai-switches";
import { setArchived } from "../src/db/categories";
import { suggestionQueue } from "../src/db/suggestions-queue";
import { resetDemo } from "../src/demo/reset";
import { suggestions } from "../src/routes/suggestions";

// The one review screen for every "Maybe …" (issue #195, decisions 79 and 101): Settings' Band leads to
// it, one item at a time in the order money first, then categories, new categories and names. A Yes
// makes the change; a No on income, a transfer or a new category asks first before a "Never suggest"
// line is kept; Something else only answers this one; Skip moves on and comes back at the end.

const db = env.DB;
const BASE = "http://tally.test";
const VENMO = "VENMO PAYMENT";
const CHASE = "CHASE CARD PAYMENT";
const LUPITA = "SQ *LUPITAS TAQ 2210";
const BLUE = "BLUE BOTTLE COF";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(
	path: string,
	fields: Record<string, string | string[]>,
	htmx = false,
) {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(fields))
		for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: body.toString(),
	});
	return { res, html: await res.text() };
}

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, " ")
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&")
		.replace(/\s+/g, " ");

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

async function insertTx(fields: {
	raw: string;
	amount: number;
	date?: string;
	incomeConfidence?: number;
	transferConfidence?: number;
	categoryConfidence?: number;
	jevCategoryId?: number;
	suggestionId?: number;
	merchantName?: string;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name,
				income_confidence, transfer_confidence, category_confidence, jev_category_id, category_suggestion_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.date ?? "2026-10-02",
			fields.amount,
			fields.raw,
			fields.merchantName ?? null,
			fields.incomeConfidence ?? null,
			fields.transferConfidence ?? null,
			fields.categoryConfidence ?? null,
			fields.jevCategoryId ?? null,
			fields.suggestionId ?? null,
		)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

/** One of each kind, as the review screen asks them. Returns the ids the tests need. */
async function oneOfEach() {
	const eatingOut = await categoryId("Eating Out");
	const income = await insertTx({
		raw: VENMO,
		amount: -250000,
		incomeConfidence: 0.5,
		date: "2026-10-02",
	});
	const transfer = await insertTx({
		raw: CHASE,
		amount: 20000,
		transferConfidence: 0.5,
		date: "2026-10-02",
	});
	const category = await insertTx({
		raw: LUPITA,
		amount: 2300,
		jevCategoryId: eatingOut,
		categoryConfidence: 0.5,
		date: "2026-10-02",
	});
	await db
		.prepare(
			`INSERT INTO merchants (raw_name, display_name) VALUES (?, 'Venmo'), (?, 'Chase card payment'),
				(?, 'Lupita''s Taqueria'), ('CHEWY.COM 1', 'Chewy'), ('PETSMART 22', 'Petsmart'), ('BANFIELD 5', 'Banfield')`,
		)
		.bind(VENMO, CHASE, LUPITA)
		.run();
	const suggestion = await db
		.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		)
		.first<{ id: number }>();
	const pets = [
		await insertTx({
			raw: "CHEWY.COM 1",
			amount: 4500,
			suggestionId: suggestion?.id,
		}),
		await insertTx({
			raw: "PETSMART 22",
			amount: 3100,
			suggestionId: suggestion?.id,
		}),
		await insertTx({
			raw: "BANFIELD 5",
			amount: 8900,
			suggestionId: suggestion?.id,
		}),
	];
	await db
		.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Blue Bottle Coffee', 'pending')",
		)
		.bind(BLUE)
		.run();
	const named = await insertTx({ raw: BLUE, amount: 600 });
	return {
		income,
		transfer,
		category,
		suggestion: suggestion?.id ?? 0,
		pets,
		named,
		eatingOut,
	};
}

const row = (sql: string, ...binds: unknown[]) =>
	db
		.prepare(sql)
		.bind(...binds)
		.first<Record<string, unknown>>();

/** The fields a Never suggest Remove form posts for one line: its id, store and kind (decision 101). */
const removal = (line: Record<string, unknown> | null) => ({
	id: String(line?.id),
	merchant_key: String(line?.merchant_key),
	kind: String(line?.kind),
});

/** The flags a Maybe answer could change: a No must leave every one of them as it was (spec §8.6). */
const moneyState = (id: number) =>
	row(
		`SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by, excluded, excluded_source, flag_transfer
		FROM transactions WHERE id = ?`,
		id,
	);

/** Home for October, as text: what needs a category and what is spent (a No leaves both alone). */
const homeText = async () => textOf((await get("/?month=2026-10")).html);

/** The transactions list for October, as text: where a Maybe income chip would show on a row. */
const listText = async () =>
	textOf((await get("/transactions?month=2026-10")).html);

/** The Never suggest line whose Remove takes focus after a swap: the one drawn with autofocus. */
const focusedNeverLine = (html: string) =>
	html
		.split("<li ")
		.find(
			(item) =>
				item.includes("autofocus") && item.includes("never-suggest/remove"),
		) ?? "";

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM never_suggest_rules"),
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

describe("GET /settings/suggestions", () => {
	it("asks the first item of the queue, with its place and the one question", async () => {
		const ids = await oneOfEach();
		const { res, html } = await get("/settings/suggestions");
		expect(res.status).toBe(200);
		const text = textOf(html);
		expect(text).toContain("Suggestions · 1 of 5");
		expect(text).toContain("Count it as income, not spending?");
		expect(html).toContain(`value="income-${ids.income}"`);
		expect(text).toContain("Yes, it's income");
		// No screen names Jev, or the AI behind a suggestion (spec §8.6).
		expect(html).not.toMatch(/\bJev\b/);
	});

	it("shows Settings' Band with the count of every kind, and nothing else", async () => {
		await oneOfEach();
		const { html } = await get("/settings");
		expect(html).toContain('href="/settings/suggestions"');
		expect(textOf(html)).toContain("5 suggestions to check");
	});

	it("says nothing left when the queue is empty", async () => {
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).toContain("Nothing left to check.");
		expect(textOf(html)).toContain(
			"New suggestions show up as transactions arrive.",
		);
	});

	it("moves past skipped items", async () => {
		const ids = await oneOfEach();
		const skipped = await get(
			`/settings/suggestions?skip=income-${ids.income}`,
		);
		expect(textOf(skipped.html)).toContain("Suggestions · 2 of 5");
		expect(textOf(skipped.html)).toContain("Leave it out of the budget?");
	});

	it("shows the place of the item in the queue, not the number of skips", async () => {
		const ids = await oneOfEach();
		// The transfer is set aside, so the income is first in the queue: "1 of 5", not "2 of 5".
		const { html } = await get(
			`/settings/suggestions?skip=transfer-${ids.transfer}`,
		);
		expect(textOf(html)).toContain("Suggestions · 1 of 5");
		expect(textOf(html)).toContain("Count it as income, not spending?");
	});

	it("brings a skipped item back at the end once the others are answered", async () => {
		const ids = await oneOfEach();
		const name = await row(
			"SELECT rowid AS id FROM merchants WHERE raw_name = ?",
			BLUE,
		);
		const pets = ids.pets.map(String);
		const skipUrl = `/settings/suggestions?skip=income-${ids.income}`;
		await post(
			skipUrl,
			{ id: `transfer-${ids.transfer}`, answer: "yes" },
			true,
		);
		await post(
			skipUrl,
			{ id: `category-${ids.category}`, answer: "yes" },
			true,
		);
		await post(
			skipUrl,
			{ id: `new-${ids.suggestion}`, answer: "yes", shown: pets, ticked: pets },
			true,
		);
		const { res, html } = await post(
			skipUrl,
			{ id: `name-${name?.id}`, answer: "yes" },
			true,
		);
		expect(textOf(html)).toContain("Suggestions · 1 of 1");
		expect(textOf(html)).toContain("Count it as income, not spending?");
		expect(html).toContain(`value="income-${ids.income}"`);
		expect(trigger(res).announce).toContain("1 left to check.");
	});

	it("sets a returned item aside on a second Skip, and says so once all are set aside", async () => {
		const ids = await oneOfEach();
		const name = await row(
			"SELECT rowid AS id FROM merchants WHERE raw_name = ?",
			BLUE,
		);
		const all = [
			`income-${ids.income}`,
			`transfer-${ids.transfer}`,
			`category-${ids.category}`,
			`new-${ids.suggestion}`,
			`name-${name?.id}`,
		];
		const skips = all.map((id) => `skip=${id}`).join("&");
		// Every item is skipped once, so the first comes back, in queue order, and its Skip is a second one.
		const back = await get(`/settings/suggestions?${skips}`);
		expect(textOf(back.html)).toContain("Suggestions · 1 of 5");
		expect(textOf(back.html)).toContain("Count it as income, not spending?");
		expect(back.html).toContain(`again=income-${ids.income}`);
		const second = await get(
			`/settings/suggestions?${skips}&again=income-${ids.income}`,
		);
		expect(textOf(second.html)).toContain("Suggestions · 2 of 5");
		expect(textOf(second.html)).toContain("Leave it out of the budget?");
		const agains = all.map((id) => `again=${id}`).join("&");
		const { html } = await get(`/settings/suggestions?${skips}&${agains}`);
		expect(textOf(html)).toContain("You skipped the rest.");
		expect(html).toContain("Start over");
	});

	it("never shows bank text in an address (Skip uses the item's key)", async () => {
		const ids = await oneOfEach();
		const { html } = await get("/settings/suggestions");
		expect(html).toContain(`skip=income-${ids.income}`);
		expect(html).not.toContain("skip=VENMO");
	});

	it("answers the names route with a redirect to the screen", async () => {
		const res = await exports.default.fetch(`${BASE}/settings/names`, {
			redirect: "manual",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/suggestions");
	});
});

describe("income", () => {
	it("Yes makes the income the person's choice, announces it and moves on", async () => {
		const ids = await oneOfEach();
		const { res, html } = await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "yes" },
			true,
		);
		expect(res.status).toBe(200);
		const tx = await row(
			"SELECT flag_income, income_source FROM transactions WHERE id = ?",
			ids.income,
		);
		expect(tx).toMatchObject({ flag_income: 1, income_source: "user" });
		expect(trigger(res).toast?.message).toBe("Counted Venmo as income.");
		expect(trigger(res).announce).toContain("left to check");
		expect(textOf(html)).toContain("Suggestions · 1 of 4");
	});

	it("No changes nothing that counts, hides that Maybe, and asks first", async () => {
		const ids = await oneOfEach();
		const before = await moneyState(ids.income);
		const homeBefore = await homeText();
		expect(await listText()).toContain("Maybe income");
		const { res, html } = await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		expect(res.status).toBe(200);
		const text = textOf(html);
		expect(text).toContain("Not counted as income");
		expect(text).toContain("Don't suggest income again for Venmo?");
		expect(text).toContain("Say yes and Tally stops asking this for Venmo.");
		// The transaction keeps its flags and its review, and Home's counts and spending don't move.
		expect(await moneyState(ids.income)).toEqual(before);
		expect(await homeText()).toEqual(homeBefore);
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
		// The Maybe leaves the queue, the Band and the transaction's row.
		expect(textOf((await get("/settings/suggestions")).html)).toContain(
			"Suggestions · 1 of 4",
		);
		expect(textOf((await get("/settings")).html)).toContain(
			"4 suggestions to check",
		);
		expect(await listText()).not.toContain("Maybe income");
	});

	it("a later Jev answer can't raise the same income Maybe again", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		await db
			.prepare("UPDATE transactions SET income_confidence = 0.3 WHERE id = ?")
			.bind(ids.income)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).not.toContain("Count it as income, not spending?");
		expect(textOf(html)).toContain("Suggestions · 1 of 4");
	});

	it("the question after a No on the last item drops the count rather than saying 0 left", async () => {
		const id = await insertTx({
			raw: VENMO,
			amount: -250000,
			incomeConfidence: 0.5,
		});
		const { html } = await post(
			"/settings/suggestions",
			{ id: `income-${id}`, answer: "no" },
			true,
		);
		expect(textOf(html)).toContain("Don't suggest income again for");
		expect(textOf(html)).not.toMatch(/Suggestions · \d|\b0 left\b/);
	});

	it("Yes writes no line for a store the income is not from", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_yes",
				kind: "income",
				store: [LUPITA, "A STORE TYPED INTO THE FORM"],
			},
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
	});

	it("Not now after No adds no line", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_not_now",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		expect(res.status).toBe(200);
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
	});

	it("Yes on the question adds one Never suggest line and says so", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		expect(trigger(res).toast?.message).toBe(
			"Got it. Tally won't suggest income for Venmo again. Change it in Settings.",
		);
		expect(
			await row("SELECT merchant_key, kind FROM never_suggest_rules"),
		).toMatchObject({
			merchant_key: VENMO,
			kind: "income",
		});
	});

	it("Yes on the question counts the items left after the line hides the store's other credits", async () => {
		const ids = await oneOfEach();
		// A second Venmo credit: the Venmo line hides it too, so the count the announcer reads must drop
		// by it as well (the count is taken once the line is written, not before).
		await insertTx({
			raw: VENMO,
			amount: -180000,
			incomeConfidence: 0.5,
			date: "2026-10-01",
		});
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const { res, html } = await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		expect(textOf(html)).toContain("Suggestions · 1 of 4");
		expect(trigger(res).announce).toBe(
			"Got it. Tally won't suggest income for Venmo again. Change it in Settings. 4 left to check.",
		);
	});
});

describe("transfers", () => {
	it("Yes leaves the transaction out of the budget as the person's choice", async () => {
		const ids = await oneOfEach();
		const { res } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
				ids.transfer,
			),
		).toMatchObject({ excluded: 1, excluded_source: "user" });
		expect(trigger(res).toast?.message).toBe(
			"Left Chase card payment out of the budget.",
		);
	});

	it("No changes nothing that counts, hides that Maybe, and asks first", async () => {
		const ids = await oneOfEach();
		const before = await moneyState(ids.transfer);
		const homeBefore = await homeText();
		const { html } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "no" },
			true,
		);
		expect(textOf(html)).toContain("Kept in the budget");
		expect(textOf(html)).toContain(
			"Don't suggest a transfer again for Chase card payment?",
		);
		expect(await moneyState(ids.transfer)).toEqual(before);
		expect(await homeText()).toEqual(homeBefore);
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
		expect(textOf((await get("/settings/suggestions")).html)).not.toContain(
			"Leave it out of the budget?",
		);
	});

	it("a later Jev answer can't raise the same transfer Maybe again", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "no" },
			true,
		);
		await db
			.prepare("UPDATE transactions SET transfer_confidence = 0.4 WHERE id = ?")
			.bind(ids.transfer)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).not.toContain("Leave it out of the budget?");
		expect(textOf(html)).toContain("Suggestions · 1 of 4");
	});

	it("doesn't ask a transfer about a payment linked to a bill, and a stale Yes for it leaves it as it was", async () => {
		const ids = await oneOfEach();
		const bill = await row(
			"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 20000, 1, 'monthly', ?) RETURNING id",
			CHASE,
		);
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, ids.transfer)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(html).not.toContain(`value="transfer-${ids.transfer}"`);
		expect(textOf((await get("/settings")).html)).toContain(
			"4 suggestions to check",
		);
		const before = await row(
			"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
			ids.transfer,
		);
		const { res } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "yes" },
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(
			await row(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
				ids.transfer,
			),
		).toEqual(before);
	});

	it("a person's explicit include settles the transfer Maybe: a Yes for it leaves it in the budget", async () => {
		const ids = await oneOfEach();
		await db
			.prepare("UPDATE transactions SET excluded_source = 'user' WHERE id = ?")
			.bind(ids.transfer)
			.run();
		const { res } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "yes" },
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(
			await row(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
				ids.transfer,
			),
		).toMatchObject({ excluded: 0, excluded_source: "user" });
	});

	it("a held credit (not reviewed yet, so not spending) is never asked as a transfer, and its stale answers change nothing", async () => {
		const held = await insertTx({
			raw: "HELD TRANSFER CREDIT",
			amount: -20000,
			transferConfidence: 0.5,
		});
		const reviewed = await insertTx({
			raw: "REVIEWED TRANSFER CREDIT",
			amount: -20000,
			transferConfidence: 0.5,
		});
		await db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
			)
			.bind(reviewed)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(html).not.toContain(`value="transfer-${held}"`);
		expect(html).toContain(`value="transfer-${reviewed}"`);
		const before = await moneyState(held);
		const yes = await post(
			"/settings/suggestions",
			{ id: `transfer-${held}`, answer: "yes" },
			true,
		);
		expect(trigger(yes.res).toast?.message).toBe(
			"That one was already answered.",
		);
		const no = await post(
			"/settings/suggestions",
			{ id: `transfer-${held}`, answer: "no" },
			true,
		);
		expect(trigger(no.res).toast?.message).toBe(
			"That one was already answered.",
		);
		expect(
			await row(
				"SELECT transfer_maybe_declined, excluded, excluded_source FROM transactions WHERE id = ?",
				held,
			),
		).toMatchObject({
			transfer_maybe_declined: 0,
			excluded: 0,
			excluded_source: null,
		});
		expect(await moneyState(held)).toEqual(before);
		const kept = await post(
			"/settings/suggestions",
			{ id: `transfer-${reviewed}`, answer: "no" },
			true,
		);
		expect(textOf(kept.html)).toContain("Kept in the budget");
	});
});

describe("categories", () => {
	it("Yes sets Jev's guess as the person's category", async () => {
		const ids = await oneOfEach();
		const { res } = await post(
			"/settings/suggestions",
			{ id: `category-${ids.category}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
				ids.category,
			),
		).toMatchObject({ category_id: ids.eatingOut, category_source: "user" });
		expect(trigger(res).toast?.message).toBe(
			"Set Lupita's Taqueria to Eating Out.",
		);
	});

	it("Something else saves the chosen category instead, and makes no rule", async () => {
		const ids = await oneOfEach();
		const groceries = await categoryId("Groceries");
		await post(
			"/settings/suggestions",
			{
				id: `category-${ids.category}`,
				answer: "else",
				category: String(groceries),
			},
			true,
		);
		expect(
			await row(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
				ids.category,
			),
		).toMatchObject({ category_id: groceries, category_source: "user" });
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
		expect(
			await row(
				"SELECT COUNT(*) AS n FROM merchants WHERE default_category_id IS NOT NULL",
			),
		).toMatchObject({ n: 0 });
	});

	it("a category set here clears a split's removed-amount mark and its removed bills, as the edit panel does", async () => {
		const ids = await oneOfEach();
		await db
			.prepare(
				"UPDATE transactions SET split_removed_from_cents = 500, split_removed_bills = ? WHERE id = ?",
			)
			.bind('[{"billId":1,"name":"Rent","period":"2026-10"}]', ids.category)
			.run();
		await post(
			"/settings/suggestions",
			{ id: `category-${ids.category}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT split_removed_from_cents, split_removed_bills FROM transactions WHERE id = ?",
				ids.category,
			),
		).toMatchObject({
			split_removed_from_cents: null,
			split_removed_bills: null,
		});
	});

	it("Something else clears a split's removed-amount mark and its removed bills too", async () => {
		const ids = await oneOfEach();
		const groceries = await categoryId("Groceries");
		await db
			.prepare(
				"UPDATE transactions SET split_removed_from_cents = 500, split_removed_bills = ? WHERE id = ?",
			)
			.bind('[{"billId":1,"name":"Rent","period":"2026-10"}]', ids.category)
			.run();
		await post(
			"/settings/suggestions",
			{
				id: `category-${ids.category}`,
				answer: "else",
				category: String(groceries),
			},
			true,
		);
		expect(
			await row(
				"SELECT category_id, split_removed_from_cents, split_removed_bills FROM transactions WHERE id = ?",
				ids.category,
			),
		).toMatchObject({
			category_id: groceries,
			split_removed_from_cents: null,
			split_removed_bills: null,
		});
	});

	it("never excludes a refund linked to a purchase, even when a stale answer arrives for it", async () => {
		const ids = await oneOfEach();
		const purchase = await insertTx({ raw: "SHOP PURCHASE", amount: 9000 });
		await db
			.prepare(
				"UPDATE transactions SET refund_of_id = ?, transfer_confidence = 0.5 WHERE id = ?",
			)
			.bind(purchase, ids.transfer)
			.run();
		const { res } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "yes" },
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(
			await row("SELECT excluded FROM transactions WHERE id = ?", ids.transfer),
		).toMatchObject({ excluded: 0 });
	});

	it("Something else with no chip asks for one", async () => {
		const ids = await oneOfEach();
		const { res, html } = await post(
			"/settings/suggestions",
			{ id: `category-${ids.category}`, answer: "else" },
			true,
		);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain("Pick a category.");
		// The error points at the chips, so Something else is open with them in it.
		expect(html).toMatch(/<details[^>]*\bopen/);
	});

	it("Yes on an excluded bill payment's category sets it as the person's", async () => {
		const eatingOut = await categoryId("Eating Out");
		const paying = await insertTx({
			raw: "GYM MEMBERSHIP",
			amount: 2300,
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		await db
			.prepare("UPDATE transactions SET excluded = 1 WHERE id = ?")
			.bind(paying)
			.run();
		const bill = await row(
			"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Gym', 2300, 1, 'monthly', 'GYM MEMBERSHIP') RETURNING id",
		);
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paying)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(html).toContain(`value="category-${paying}"`);
		expect(textOf((await get("/settings")).html)).toContain(
			"1 suggestion to check",
		);
		await post(
			"/settings/suggestions",
			{ id: `category-${paying}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT category_id, category_source, excluded FROM transactions WHERE id = ?",
				paying,
			),
		).toMatchObject({
			category_id: eatingOut,
			category_source: "user",
			excluded: 1,
		});
	});
});

describe("a held credit's category answer waits until the credit is reviewed (decision 70)", () => {
	it("is in the queue once reviewed, and a stale answer to it sets no category until it is", async () => {
		const eatingOut = await categoryId("Eating Out");
		const groceries = await categoryId("Groceries");
		const credit = await insertTx({
			raw: "ZELLE PAYMENT",
			amount: -2500,
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		const setReview = (reviewed: number) =>
			db
				.prepare("UPDATE transactions SET credit_reviewed = ? WHERE id = ?")
				.bind(reviewed, credit)
				.run();
		await setReview(1);
		expect((await get("/settings/suggestions")).html).toContain(
			`value="category-${credit}"`,
		);
		await setReview(0);
		const yes = await post(
			"/settings/suggestions",
			{ id: `category-${credit}`, answer: "yes" },
			true,
		);
		expect(trigger(yes.res).toast?.message).toBe(
			"That one was already answered.",
		);
		const picked = await post(
			"/settings/suggestions",
			{
				id: `category-${credit}`,
				answer: "else",
				category: String(groceries),
			},
			true,
		);
		expect(trigger(picked.res).toast?.message).toBe(
			"That one was already answered.",
		);
		expect(
			await row("SELECT category_id FROM transactions WHERE id = ?", credit),
		).toMatchObject({ category_id: null });
		await setReview(1);
		await post(
			"/settings/suggestions",
			{ id: `category-${credit}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
				credit,
			),
		).toMatchObject({ category_id: eatingOut, category_source: "user" });
	});
});

describe("new categories", () => {
	it("Yes creates the category with its ticked purchases", async () => {
		const ids = await oneOfEach();
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: ids.pets.map(String),
			},
			true,
		);
		expect(res.status).toBe(200);
		expect(
			await row("SELECT COUNT(*) AS n FROM categories WHERE name = 'Pet Care'"),
		).toMatchObject({ n: 1 });
		expect(trigger(res).toast?.message).toBe(
			"Made Pet Care with 3 transactions.",
		);
	});

	it("No dismisses the suggestion and asks, naming each store, before one line per store", async () => {
		const ids = await oneOfEach();
		const { html } = await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		expect(textOf(html)).toContain(
			"Don't suggest Pet Care again for Chewy, Petsmart and Banfield?",
		);
		expect(
			await row(
				"SELECT status FROM category_suggestions WHERE id = ?",
				ids.suggestion,
			),
		).toMatchObject({ status: "dismissed" });
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
	});

	it("Yes on the question writes a line only for the stores the suggestion has", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "ask_yes",
				kind: "new_category",
				store: ["CHEWY.COM 1", "NOT A STORE OF THIS SUGGESTION"],
			},
			true,
		);
		const lines = await db
			.prepare(
				"SELECT merchant_key AS key FROM never_suggest_rules WHERE kind = 'new_category' ORDER BY key",
			)
			.all<{ key: string }>();
		expect(lines.results.map((line) => line.key)).toEqual(["CHEWY.COM 1"]);
	});

	it("asks a new category with Tally's guess and a Why? to How Tally works", async () => {
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		for (const raw of ["CHEWY.COM 1", "PETSMART 22", "BANFIELD 5"])
			await insertTx({ raw, amount: 4500, suggestionId: suggestion?.id });
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).toContain("Maybe new: Pet Care");
		expect(textOf(html)).toContain("Tally's guess");
		expect(html).toContain('data-icon="sparkles"');
		expect(html).toContain('href="/how-it-works#categorization"');
		expect(html).toContain('aria-label="Why? Tally&#39;s guess"');
	});
});

describe("a Never suggest Yes writes each store once, in one statement (#440)", () => {
	const CHEWY = "CHEWY.COM 1";
	const PETSMART = "PETSMART 22";

	/** The D1 statements one request prepares, counted on the database the route reads. */
	async function statementsFor(
		fields: Record<string, string | string[]>,
	): Promise<number> {
		const prepare = vi.spyOn(db, "prepare");
		try {
			await post("/settings/suggestions", fields, true);
			return prepare.mock.calls.length;
		} finally {
			prepare.mockRestore();
		}
	}

	const yesFor = (suggestion: number, store: string | string[]) => ({
		id: `new-${suggestion}`,
		answer: "ask_yes",
		kind: "new_category",
		store,
	});

	const lines = async () =>
		(
			await db
				.prepare(
					"SELECT merchant_key AS key FROM never_suggest_rules ORDER BY merchant_key",
				)
				.all<{ key: string }>()
		).results.map((line) => line.key);

	it("a form repeating one store 1,200 times writes one line, in as many statements as one store", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		const one = await statementsFor(yesFor(ids.suggestion, CHEWY));
		await db.prepare("DELETE FROM never_suggest_rules").run();
		const copies = await statementsFor(
			yesFor(ids.suggestion, Array(1200).fill(CHEWY)),
		);
		expect(copies).toBe(one);
		expect(await lines()).toEqual([CHEWY]);
	});

	it("two distinct stores of a multi-store question write two lines, in the statements one store takes", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		const one = await statementsFor(yesFor(ids.suggestion, CHEWY));
		await db.prepare("DELETE FROM never_suggest_rules").run();
		const two = await statementsFor(
			yesFor(ids.suggestion, [CHEWY, PETSMART, CHEWY]),
		);
		expect(two).toBe(one);
		expect(await lines()).toEqual([CHEWY, PETSMART]);
	});

	it("a Yes with no No before it writes no line, whatever stores it names", async () => {
		const ids = await oneOfEach();
		const { res } = await post(
			"/settings/suggestions",
			yesFor(ids.suggestion, CHEWY),
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([]);
	});

	it("a Yes on an income or transfer question writes its line once the No stands, and none before it", async () => {
		const ids = await oneOfEach();
		const answer = (id: string, kind: string, store: string) => ({
			id,
			answer: "ask_yes",
			kind,
			store,
		});
		await post(
			"/settings/suggestions",
			answer(`transfer-${ids.transfer}`, "transfer", CHASE),
			true,
		);
		expect(await lines()).toEqual([]);
		await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "no" },
			true,
		);
		await post(
			"/settings/suggestions",
			answer(`transfer-${ids.transfer}`, "transfer", CHASE),
			true,
		);
		expect(
			await row("SELECT merchant_key, kind FROM never_suggest_rules"),
		).toMatchObject({ merchant_key: CHASE, kind: "transfer" });
		await db.prepare("DELETE FROM never_suggest_rules").run();
		await post(
			"/settings/suggestions",
			answer(`income-${ids.income}`, "income", VENMO),
			true,
		);
		expect(await lines()).toEqual([]);
	});

	it("a Yes is refused once the No that asked it no longer stands", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		await db
			.prepare(
				"UPDATE category_suggestions SET status = 'pending' WHERE id = ?",
			)
			.bind(ids.suggestion)
			.run();
		const { res } = await post(
			"/settings/suggestions",
			yesFor(ids.suggestion, CHEWY),
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([]);
	});

	it("a Yes after the edit panel counts the credit as income writes no line", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		await post(`/transactions/${ids.income}`, {
			merchant: "Venmo",
			back: "/transactions",
			income: "1",
			income_was: "0",
			creditReviewedVisible: "1",
		});
		expect(
			await row(
				"SELECT flag_income FROM transactions WHERE id = ?",
				ids.income,
			),
		).toMatchObject({ flag_income: 1 });
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([]);
	});

	it("a Yes after the edit panel leaves the transfer out of the budget writes no line", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "no" },
			true,
		);
		await post(`/transactions/${ids.transfer}`, {
			merchant: "Chase card payment",
			back: "/transactions",
			excluded: "1",
		});
		expect(
			await row(
				"SELECT excluded, transfer_maybe_declined FROM transactions WHERE id = ?",
				ids.transfer,
			),
		).toMatchObject({ excluded: 1, transfer_maybe_declined: 1 });
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `transfer-${ids.transfer}`,
				answer: "ask_yes",
				kind: "transfer",
				store: CHASE,
			},
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([]);
	});

	/** Files the Chewy purchase under a category by hand, so Chewy is no longer in the question. */
	async function fileChewy(chewy: number) {
		const eatingOut = await categoryId("Eating Out");
		await post(`/transactions/${chewy}`, {
			merchant: "Chewy",
			back: "/transactions",
			category: String(eatingOut),
		});
		expect(
			await row("SELECT category_id FROM transactions WHERE id = ?", chewy),
		).toMatchObject({ category_id: eatingOut });
	}

	it("a Yes writes a line only for the stores that still have a purchase in the question", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		await fileChewy(ids.pets[0] ?? 0);
		const { res } = await post(
			"/settings/suggestions",
			yesFor(ids.suggestion, [CHEWY, PETSMART]),
			true,
		);
		expect(trigger(res).toast?.message).toBe(
			"Got it. Tally won't suggest a new category for Petsmart again. Change it in Settings.",
		);
		expect(await lines()).toEqual([PETSMART]);
	});

	it("a Yes naming only a store whose purchases are all filed is refused", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `new-${ids.suggestion}`, answer: "no" },
			true,
		);
		await fileChewy(ids.pets[0] ?? 0);
		const { res } = await post(
			"/settings/suggestions",
			yesFor(ids.suggestion, CHEWY),
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([]);
	});

	it("a repeat Yes on the same question says it was already answered and keeps one line", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const yes = {
			id: `income-${ids.income}`,
			answer: "ask_yes",
			kind: "income",
			store: VENMO,
		};
		await post("/settings/suggestions", yes, true);
		const { res } = await post("/settings/suggestions", yes, true);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(await lines()).toEqual([VENMO]);
	});
});

/** The purchases a new-category form ticks: the checkbox values that carry `checked`. */
const checkedTicks = (html: string) =>
	[...html.matchAll(/<input[^>]*name="ticked"[^>]*>/g)]
		.filter((input) => /\schecked(=|\s|\/|>)/.test(input[0]))
		.map((input) => Number(/value="(\d+)"/.exec(input[0])?.[1]));

describe("new category answers that are refused keep the ticks", () => {
	it("draws no tick after a refusal when none was ticked, rather than ticking them all again", async () => {
		const ids = await oneOfEach();
		const { res, html } = await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
			},
			true,
		);
		expect(res.status).toBe(422);
		expect(checkedTicks(html)).toEqual([]);
	});

	it("keeps only the ticks the person made after a refusal", async () => {
		const ids = await oneOfEach();
		await db
			.prepare(
				"INSERT INTO categories (name, icon, color, sort_order, archived) VALUES ('Pet Care', 'tag', 'cat-blue', 99, 1)",
			)
			.run();
		const active = (
			await db
				.prepare("SELECT COUNT(*) AS n FROM categories WHERE archived = 0")
				.first<{ n: number }>()
		)?.n as number;
		for (let i = active; i < 50; i++)
			await db
				.prepare(
					"INSERT INTO categories (name, icon, color, sort_order) VALUES (?, 'tag', 'cat-blue', ?)",
				)
				.bind(`Filler ${i}`, 200 + i)
				.run();
		const { res, html } = await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: [String(ids.pets[0])],
			},
			true,
		);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain(
			"Tally has room for 50 categories. Archive one to restore another.",
		);
		expect(checkedTicks(html)).toEqual([ids.pets[0]]);
	});
});

describe("a new category the family already has is added to, and the button says so (decision 101)", () => {
	/** The new-category question: the money and category items before it are set aside. */
	const newCategoryPage = async (ids: {
		income: number;
		transfer: number;
		category: number;
	}) =>
		get(
			`/settings/suggestions?skip=income-${ids.income}&skip=transfer-${ids.transfer}&skip=category-${ids.category}`,
		);

	it("reads 'Yes, add to' with the family's own name for it, and not 'Yes, create'", async () => {
		const ids = await oneOfEach();
		await db
			.prepare(
				"INSERT INTO categories (name, icon, color, sort_order) VALUES ('pet care', 'tag', 'cat-blue', 99)",
			)
			.run();
		const { html } = await newCategoryPage(ids);
		expect(textOf(html)).toContain("Maybe new: Pet Care");
		expect(textOf(html)).toContain("Yes, add to pet care");
		expect(textOf(html)).not.toContain("Yes, create");
	});

	it("reads 'Yes, create' with the suggested name when the family has no such category", async () => {
		const ids = await oneOfEach();
		const { html } = await newCategoryPage(ids);
		expect(textOf(html)).toContain("Maybe new: Pet Care");
		expect(textOf(html)).toContain("Yes, create Pet Care");
		expect(textOf(html)).not.toContain("Yes, add to");
	});

	it("reads 'Yes, restore' with the family's name for an archived category (decision 110)", async () => {
		const ids = await oneOfEach();
		const archived = (
			await db
				.prepare(
					"INSERT INTO categories (name, icon, color, sort_order) VALUES ('pet care', 'tag', 'cat-blue', 99) RETURNING id",
				)
				.first<{ id: number }>()
		)?.id as number;
		await setArchived(db, archived, true, "2026-07-15");
		const { html } = await newCategoryPage(ids);
		expect(textOf(html)).toContain("Maybe new: Pet Care");
		expect(textOf(html)).toContain("Yes, restore pet care");
		expect(textOf(html)).not.toContain("Yes, add to");
		expect(textOf(html)).not.toContain("Yes, create");
	});
});

describe("Yes on an archived category restores it, with the ticked purchases (decision 110)", () => {
	it("brings it back with the ticked purchases in it, and says how many", async () => {
		const ids = await oneOfEach();
		const archived = (
			await db
				.prepare(
					"INSERT INTO categories (name, icon, color, sort_order) VALUES ('pet care', 'tag', 'cat-blue', 99) RETURNING id",
				)
				.first<{ id: number }>()
		)?.id as number;
		await setArchived(db, archived, true, "2026-07-15");
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: ids.pets.map(String),
			},
			true,
		);
		expect(res.status).toBe(200);
		expect(trigger(res).toast?.message).toBe(
			"Restored pet care with 3 transactions.",
		);
		expect(
			await row("SELECT archived FROM categories WHERE id = ?", archived),
		).toMatchObject({ archived: 0 });
		expect(
			await row(
				"SELECT category_id FROM transactions WHERE id = ?",
				ids.pets[0],
			),
		).toMatchObject({ category_id: archived });
	});
});

describe("a Yes files only the rows its question still shows (decision 101)", () => {
	it("files the store's rows the question shows, and leaves a store that got a No line unfiled, even from a stale form", async () => {
		const ids = await oneOfEach();
		const [chewy, petsmart, banfield] = ids.pets;
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('PETSMART 22', 'new_category', '2026-10-03')",
			)
			.run();
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: ids.pets.map(String),
			},
			true,
		);
		expect(res.status).toBe(200);
		expect(
			await row("SELECT category_source FROM transactions WHERE id = ?", chewy),
		).toMatchObject({ category_source: "user" });
		expect(
			await row(
				"SELECT category_source FROM transactions WHERE id = ?",
				banfield,
			),
		).toMatchObject({ category_source: "user" });
		expect(
			await row(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
				petsmart,
			),
		).toMatchObject({ category_id: null, category_source: null });
	});
});

describe("Yes on a new category asks Jev again about the rows left out (decision 79)", () => {
	const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
	app.use("*", async (c, next) => {
		c.set("actor", "test@example.com");
		await next();
	});
	app.route("/", suggestions);
	let waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
	const ctx = () => ({ waitUntil, passThroughOnException() {}, props: {} });
	const background = () => Promise.all(waitUntil.mock.calls.map(([p]) => p));

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		waitUntil = vi.fn<(promise: Promise<unknown>) => void>((promise) => {
			void promise.catch(() => {});
		});
	});

	/** A fake Jev that answers Eating Out, and records the bank text of each transaction it is asked about. */
	function fakeJev() {
		const asked: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url) !== JEV_URL) throw new Error(`unexpected fetch ${url}`);
				const body = JSON.parse(String(init?.body)) as {
					state: { bank_description: string };
				};
				asked.push(body.state.bank_description);
				return Response.json({
					answers: {
						category: {
							type: "choice",
							choice: "Eating Out",
							confidence: 0.95,
						},
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: 0.01 },
					},
				});
			}),
		);
		return asked;
	}

	async function answerYes(
		fields: Record<string, string | string[]>,
		bindings: Record<string, unknown>,
	) {
		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(fields))
			for (const v of Array.isArray(value) ? value : [value])
				body.append(key, v);
		const res = await app.request(
			"/settings/suggestions",
			{
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			},
			{ ...env, ...bindings },
			ctx(),
		);
		return { res, html: await res.text() };
	}

	it("asks Jev about the unticked purchase once the page has answered, and says it goes back to sort again", async () => {
		const ids = await oneOfEach();
		const asked = fakeJev();
		const [first, second] = ids.pets;
		const { res } = await answerYes(
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: [String(first), String(second)],
			},
			{ JEV_API_KEY: "jev-key" },
		);
		expect(res.status).toBe(200);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		expect(asked).toEqual(["BANFIELD 5"]);
		expect(trigger(res).announce).toContain(
			"The 1 you left out goes back to Tally to sort again.",
		);
	});

	it("doesn't count or send to Jev a row a Never suggest line hides, though the suggestion still holds it", async () => {
		const ids = await oneOfEach();
		const asked = fakeJev();
		const [chewy] = ids.pets;
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('BANFIELD 5', 'new_category', '2026-10-03')",
			)
			.run();
		const { res } = await answerYes(
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: [String(chewy)],
			},
			{ JEV_API_KEY: "jev-key" },
		);
		expect(res.status).toBe(200);
		await background();
		expect(asked).toEqual(["PETSMART 22"]);
		expect(trigger(res).announce).toContain(
			"The 1 you left out goes back to Tally to sort again.",
		);
	});

	it("schedules nothing without a Jev key", async () => {
		const ids = await oneOfEach();
		const asked = fakeJev();
		await answerYes(
			{
				id: `new-${ids.suggestion}`,
				answer: "yes",
				shown: ids.pets.map(String),
				ticked: [String(ids.pets[0])],
			},
			{ JEV_API_KEY: undefined },
		);
		expect(waitUntil).not.toHaveBeenCalled();
		expect(asked).toEqual([]);
	});
});

describe("a stale answer that lands after the queue was read changes nothing (decision 96)", () => {
	const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
	app.use("*", async (c, next) => {
		c.set("actor", "test@example.com");
		await next();
	});
	app.route("/", suggestions);

	/**
	 * The DB, with `rival` run just before the first `run()` of a statement whose SQL starts with `prefix`:
	 * the change lands between the route's queue read and its write.
	 */
	function racing(prefix: string, rival: () => Promise<unknown>): D1Database {
		let raced = false;
		const guard = (statement: D1PreparedStatement): D1PreparedStatement =>
			new Proxy(statement, {
				get(target, prop) {
					if (prop === "bind")
						return (...values: unknown[]) => guard(target.bind(...values));
					if (prop === "run" || prop === "all")
						return async () => {
							if (!raced) {
								raced = true;
								await rival();
							}
							return prop === "run" ? target.run() : target.all();
						};
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		return new Proxy(db, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						const statement = target.prepare(sql);
						return sql.startsWith(prefix) ? guard(statement) : statement;
					};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	async function answer(
		fields: Record<string, string>,
		DB: D1Database,
	): Promise<Response> {
		const body = new URLSearchParams(fields);
		return app.request(
			"/settings/suggestions",
			{
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			},
			{ ...env, DB },
			{ waitUntil() {}, passThroughOnException() {}, props: {} },
		);
	}

	const reviewAsNotIncome = (id: number) =>
		db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
			)
			.bind(id)
			.run();

	const STALE = "That one was already answered.";

	it("a credit a person reviewed as not income after the queue was read stays not income after a Yes", async () => {
		const credit = await insertTx({
			raw: VENMO,
			amount: -250000,
			incomeConfidence: 0.6,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="income-${credit}"`,
		);
		const res = await answer(
			{ id: `income-${credit}`, answer: "yes" },
			racing("UPDATE transactions SET flag_income = 1", () =>
				reviewAsNotIncome(credit),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row(
				"SELECT flag_income, income_source FROM transactions WHERE id = ?",
				credit,
			),
		).toMatchObject({ flag_income: 0, income_source: null });
	});

	it("a credit a person reviewed as not income after the queue was read can't take a No either", async () => {
		const credit = await insertTx({
			raw: VENMO,
			amount: -250000,
			incomeConfidence: 0.6,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="income-${credit}"`,
		);
		const res = await answer(
			{ id: `income-${credit}`, answer: "no" },
			racing("UPDATE transactions SET income_maybe_declined = 1", () =>
				reviewAsNotIncome(credit),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row(
				"SELECT income_maybe_declined FROM transactions WHERE id = ?",
				credit,
			),
		).toMatchObject({ income_maybe_declined: 0 });
	});

	it("a credit a person left out of the budget after the queue was read is not counted as income by a Yes", async () => {
		const credit = await insertTx({
			raw: VENMO,
			amount: -250000,
			incomeConfidence: 0.6,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="income-${credit}"`,
		);
		const res = await answer(
			{ id: `income-${credit}`, answer: "yes" },
			racing("UPDATE transactions SET flag_income = 1", () =>
				db
					.prepare(
						"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
					)
					.bind(credit)
					.run(),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row("SELECT flag_income FROM transactions WHERE id = ?", credit),
		).toMatchObject({ flag_income: 0 });
	});

	it("a category Jev changed after the queue was read is not set to the new category by a Yes", async () => {
		const eatingOut = await categoryId("Eating Out");
		const groceries = await categoryId("Groceries");
		const spent = await insertTx({
			raw: LUPITA,
			amount: 2300,
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="category-${spent}"`,
		);
		const res = await answer(
			{ id: `category-${spent}`, answer: "yes" },
			racing("UPDATE transactions SET category_id", () =>
				db
					.prepare("UPDATE transactions SET jev_category_id = ? WHERE id = ?")
					.bind(groceries, spent)
					.run(),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row("SELECT category_id FROM transactions WHERE id = ?", spent),
		).toMatchObject({ category_id: null });
	});

	it("a reviewed credit held again after the queue was read gets no category from a Something else", async () => {
		const eatingOut = await categoryId("Eating Out");
		const groceries = await categoryId("Groceries");
		const credit = await insertTx({
			raw: "ZELLE PAYMENT",
			amount: -2500,
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		await db
			.prepare("UPDATE transactions SET credit_reviewed = 1 WHERE id = ?")
			.bind(credit)
			.run();
		expect((await get("/settings/suggestions")).html).toContain(
			`value="category-${credit}"`,
		);
		const res = await answer(
			{
				id: `category-${credit}`,
				answer: "else",
				category: String(groceries),
			},
			racing("UPDATE transactions SET category_id", () =>
				db
					.prepare("UPDATE transactions SET credit_reviewed = 0 WHERE id = ?")
					.bind(credit)
					.run(),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row("SELECT category_id FROM transactions WHERE id = ?", credit),
		).toMatchObject({ category_id: null });
	});

	it("a Something else whose category was archived after the queue was read sets no category", async () => {
		const eatingOut = await categoryId("Eating Out");
		const groceries = await categoryId("Groceries");
		const spent = await insertTx({
			raw: LUPITA,
			amount: 2300,
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="category-${spent}"`,
		);
		const res = await answer(
			{
				id: `category-${spent}`,
				answer: "else",
				category: String(groceries),
			},
			racing("UPDATE transactions SET category_id", () =>
				db
					.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
					.bind(groceries)
					.run(),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
				spent,
			),
		).toMatchObject({ category_id: null, category_source: null });
	});

	/** Another person says Never suggest a transfer for a store, after the queue was read (decision 101). */
	const neverTransfer = (merchantKey: string) =>
		db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'transfer', '2026-10-03')",
			)
			.bind(merchantKey)
			.run();

	it("a transfer whose store got a Never suggest line after the queue was read is not left out by a Yes", async () => {
		const transfer = await insertTx({
			raw: CHASE,
			amount: 20000,
			transferConfidence: 0.5,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="transfer-${transfer}"`,
		);
		const res = await answer(
			{ id: `transfer-${transfer}`, answer: "yes" },
			racing("UPDATE transactions SET excluded = 1", () =>
				neverTransfer(CHASE),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
				transfer,
			),
		).toMatchObject({ excluded: 0, excluded_source: null });
	});

	it("a transfer whose store got a Never suggest line after the queue was read can't take a No either", async () => {
		const transfer = await insertTx({
			raw: CHASE,
			amount: 20000,
			transferConfidence: 0.5,
		});
		expect((await get("/settings/suggestions")).html).toContain(
			`value="transfer-${transfer}"`,
		);
		const res = await answer(
			{ id: `transfer-${transfer}`, answer: "no" },
			racing("UPDATE transactions SET transfer_maybe_declined = 1", () =>
				neverTransfer(CHASE),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row(
				"SELECT transfer_maybe_declined FROM transactions WHERE id = ?",
				transfer,
			),
		).toMatchObject({ transfer_maybe_declined: 0 });
	});

	// Tally's guess moved after the queue was read: to a sure value, or below the Maybe range. Either way the
	// answer is stale, and its write changes nothing, since the write checks the same range the queue shows.
	const GUESS_MOVED = [
		{ moved: "became sure", confidence: 0.95 },
		{ moved: "fell below the Maybe range", confidence: 0.1 },
	];

	const moveGuess = (
		column: "income_confidence" | "transfer_confidence",
		id: number,
		confidence: number,
	) =>
		db
			.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ?`)
			.bind(confidence, id)
			.run();

	it.each(GUESS_MOVED)(
		"an income Yes after Tally's guess $moved changes nothing",
		async ({ confidence }) => {
			const credit = await insertTx({
				raw: VENMO,
				amount: -250000,
				incomeConfidence: 0.6,
			});
			expect((await get("/settings/suggestions")).html).toContain(
				`value="income-${credit}"`,
			);
			const res = await answer(
				{ id: `income-${credit}`, answer: "yes" },
				racing("UPDATE transactions SET flag_income = 1", () =>
					moveGuess("income_confidence", credit, confidence),
				),
			);
			expect(trigger(res).toast?.message).toBe(STALE);
			expect(
				await row(
					"SELECT flag_income, income_source, income_confidence FROM transactions WHERE id = ?",
					credit,
				),
			).toMatchObject({
				flag_income: 0,
				income_source: null,
				income_confidence: confidence,
			});
		},
	);

	it.each(GUESS_MOVED)(
		"an income No after Tally's guess $moved changes nothing",
		async ({ confidence }) => {
			const credit = await insertTx({
				raw: VENMO,
				amount: -250000,
				incomeConfidence: 0.6,
			});
			expect((await get("/settings/suggestions")).html).toContain(
				`value="income-${credit}"`,
			);
			const res = await answer(
				{ id: `income-${credit}`, answer: "no" },
				racing("UPDATE transactions SET income_maybe_declined = 1", () =>
					moveGuess("income_confidence", credit, confidence),
				),
			);
			expect(trigger(res).toast?.message).toBe(STALE);
			expect(
				await row(
					"SELECT income_maybe_declined, income_confidence FROM transactions WHERE id = ?",
					credit,
				),
			).toMatchObject({
				income_maybe_declined: 0,
				income_confidence: confidence,
			});
		},
	);

	it.each(GUESS_MOVED)(
		"a transfer Yes after Tally's guess $moved changes nothing",
		async ({ confidence }) => {
			const transfer = await insertTx({
				raw: CHASE,
				amount: 20000,
				transferConfidence: 0.6,
			});
			expect((await get("/settings/suggestions")).html).toContain(
				`value="transfer-${transfer}"`,
			);
			const res = await answer(
				{ id: `transfer-${transfer}`, answer: "yes" },
				racing("UPDATE transactions SET excluded = 1", () =>
					moveGuess("transfer_confidence", transfer, confidence),
				),
			);
			expect(trigger(res).toast?.message).toBe(STALE);
			expect(
				await row(
					"SELECT excluded, excluded_source, transfer_confidence FROM transactions WHERE id = ?",
					transfer,
				),
			).toMatchObject({
				excluded: 0,
				excluded_source: null,
				transfer_confidence: confidence,
			});
		},
	);

	it.each(GUESS_MOVED)(
		"a transfer No after Tally's guess $moved changes nothing",
		async ({ confidence }) => {
			const transfer = await insertTx({
				raw: CHASE,
				amount: 20000,
				transferConfidence: 0.6,
			});
			expect((await get("/settings/suggestions")).html).toContain(
				`value="transfer-${transfer}"`,
			);
			const res = await answer(
				{ id: `transfer-${transfer}`, answer: "no" },
				racing("UPDATE transactions SET transfer_maybe_declined = 1", () =>
					moveGuess("transfer_confidence", transfer, confidence),
				),
			);
			expect(trigger(res).toast?.message).toBe(STALE);
			expect(
				await row(
					"SELECT transfer_maybe_declined, transfer_confidence FROM transactions WHERE id = ?",
					transfer,
				),
			).toMatchObject({
				transfer_maybe_declined: 0,
				transfer_confidence: confidence,
			});
		},
	);

	it("a Yes whose income is counted by a rival write as its line is written adds no line (#440)", async () => {
		const credit = await insertTx({
			raw: VENMO,
			amount: -250000,
			incomeConfidence: 0.6,
		});
		await answer({ id: `income-${credit}`, answer: "no" }, db);
		expect(
			await row(
				"SELECT income_maybe_declined FROM transactions WHERE id = ?",
				credit,
			),
		).toMatchObject({ income_maybe_declined: 1 });
		const res = await answer(
			{
				id: `income-${credit}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			racing("INSERT OR IGNORE INTO never_suggest_rules", () =>
				db
					.prepare(
						"UPDATE transactions SET flag_income = 1, income_source = 'user' WHERE id = ?",
					)
					.bind(credit)
					.run(),
			),
		);
		expect(trigger(res).toast?.message).toBe(STALE);
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
	});
});

describe("a card calls a transaction by its own name, else by its store's (spec §5)", () => {
	/** Amazon, a store the family knows as "Amazon" (its display name), for the purchases below. */
	async function amazon() {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('AMAZON', 'Amazon')",
			)
			.run();
	}

	/** Gives one transaction a name of its own ("This one only", decision 101). */
	async function ownName(id: number, name: string) {
		await db
			.prepare("UPDATE transactions SET own_name = ? WHERE id = ?")
			.bind(name, id)
			.run();
	}

	/** The heading's words, as the person reads them. */
	const titleOf = (html: string) =>
		textOf(
			html.match(/<h2 id="suggestion-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "",
		).trim();

	it("titles the card with the own name, not the store's", async () => {
		await amazon();
		const gift = await insertTx({
			raw: "AMAZON",
			amount: -250000,
			incomeConfidence: 0.5,
		});
		await ownName(gift, "Birthday gift");
		const { html } = await get("/settings/suggestions");
		expect(titleOf(html)).toBe("Birthday gift");
	});

	it("says the own name in the Yes toasts of income and of a transfer", async () => {
		await amazon();
		const income = await insertTx({
			raw: "AMAZON",
			amount: -250000,
			incomeConfidence: 0.5,
		});
		const transfer = await insertTx({
			raw: "AMAZON",
			amount: 20000,
			transferConfidence: 0.5,
		});
		await ownName(income, "Birthday gift");
		await ownName(transfer, "Birthday gift");
		const counted = await post(
			"/settings/suggestions",
			{ id: `income-${income}`, answer: "yes" },
			true,
		);
		expect(trigger(counted.res).toast?.message).toBe(
			"Counted Birthday gift as income.",
		);
		const left = await post(
			"/settings/suggestions",
			{ id: `transfer-${transfer}`, answer: "yes" },
			true,
		);
		expect(trigger(left.res).toast?.message).toBe(
			"Left Birthday gift out of the budget.",
		);
	});

	it.each([
		["income", "Don't suggest income again for Amazon?"],
		["transfer", "Don't suggest a transfer again for Amazon?"],
	])(
		"asks a No on %s about the store, not the own name",
		async (kind, question) => {
			await amazon();
			const id =
				kind === "income"
					? await insertTx({
							raw: "AMAZON",
							amount: -250000,
							incomeConfidence: 0.5,
						})
					: await insertTx({
							raw: "AMAZON",
							amount: 20000,
							transferConfidence: 0.5,
						});
			await ownName(id, "Birthday gift");
			const { html } = await post(
				"/settings/suggestions",
				{ id: `${kind}-${id}`, answer: "no" },
				true,
			);
			expect(titleOf(html)).toBe(question);
			expect(textOf(html)).not.toContain("Birthday gift");
		},
	);

	it("names one purchase of a new category by its own name, as typed, while the heading still joins the stores", async () => {
		const ids = await oneOfEach();
		await ownName(ids.pets[0] ?? 0, "Pup's kibble");
		const { html } = await get(
			`/settings/suggestions?skip=income-${ids.income}&skip=transfer-${ids.transfer}&skip=category-${ids.category}`,
		);
		expect(titleOf(html)).toBe("Chewy, Petsmart and Banfield");
		expect(textOf(html)).toContain("Pup's kibble · $45.00 ·");
		expect(textOf(html)).not.toContain("Chewy · $45.00");
	});
});

describe("the primary Yes sits on its own full-width row, No under it (P42 A)", () => {
	/**
	 * The element holding a card's Yes and No: its form, or the div a new category's form puts the two
	 * buttons in. It runs from the nearest open tag before Yes to the close after No.
	 */
	function answerGroup(html: string): string {
		const yes = html.indexOf('name="answer" value="yes"');
		const no = html.indexOf('name="answer" value="no"', yes);
		const start = Math.max(
			html.lastIndexOf("<form", yes),
			html.lastIndexOf("<div", yes),
		);
		const end = Math.min(
			...[html.indexOf("</div>", no), html.indexOf("</form>", no)].filter(
				(at) => at !== -1,
			),
		);
		return html.slice(start, end);
	}

	it.each([
		["income", []],
		["transfer", ["income"]],
		["new category", ["income", "transfer", "category"]],
	])(
		"draws the %s card's Yes first in a full-width column, with No under it",
		async (_card, earlier) => {
			const ids = await oneOfEach();
			const keys: Record<string, number> = {
				income: ids.income,
				transfer: ids.transfer,
				category: ids.category,
			};
			const skip = earlier
				.map((kind) => `skip=${kind}-${keys[kind]}`)
				.join("&");
			const { html } = await get(
				`/settings/suggestions${skip ? `?${skip}` : ""}`,
			);
			const group = answerGroup(html);
			expect(group).toContain('value="yes"');
			expect(group).toContain('value="no"');
			expect(group).toContain("flex flex-col");
			expect(group).not.toContain("grid-cols-2");
			expect(group.indexOf('value="yes"')).toBeLessThan(
				group.indexOf('value="no"'),
			);
		},
	);
});

describe("names", () => {
	it("Yes names the merchant with its first suggested name", async () => {
		const ids = await oneOfEach();
		const { res } = await post(
			"/settings/suggestions",
			{ id: await nameId(), answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
				BLUE,
			),
		).toMatchObject({
			display_name: "Blue Bottle Coffee",
			suggestion_status: "accepted",
		});
		expect(trigger(res).announce).toBeTruthy();
		expect(ids.named).toBeGreaterThan(0);
	});

	it("Something else with a typed name saves that name", async () => {
		await oneOfEach();
		await post(
			"/settings/suggestions",
			{
				id: await nameId(),
				answer: "else",
				name_pick: "own",
				merchant: "Blue Bottle",
			},
			true,
		);
		expect(
			await row("SELECT display_name FROM merchants WHERE raw_name = ?", BLUE),
		).toMatchObject({ display_name: "Blue Bottle" });
	});

	it("Something else can keep the bank's name, which turns the suggestion down", async () => {
		await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: await nameId(), answer: "else", name_pick: "store" },
			true,
		);
		expect(
			await row(
				"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
				BLUE,
			),
		).toMatchObject({ display_name: null, suggestion_status: "rejected" });
	});

	it("refuses a chip that isn't one of the names shown, and a name that is too long", async () => {
		await oneOfEach();
		const chip = await post(
			"/settings/suggestions",
			{ id: await nameId(), answer: "else", name_pick: "s:Somebody Else" },
			true,
		);
		expect(chip.res.status).toBe(422);
		expect(textOf(chip.html)).toContain("Pick one of the names shown.");
		const long = await post(
			"/settings/suggestions",
			{
				id: await nameId(),
				answer: "else",
				name_pick: "own",
				merchant: "x".repeat(81),
			},
			true,
		);
		expect(long.res.status).toBe(422);
		expect(textOf(long.html)).toContain("Keep the name under 80 characters.");
		expect(
			await row("SELECT display_name FROM merchants WHERE raw_name = ?", BLUE),
		).toMatchObject({ display_name: null });
	});

	it("Something else with no choice asks for one", async () => {
		await oneOfEach();
		const { res, html } = await post(
			"/settings/suggestions",
			{ id: await nameId(), answer: "else" },
			true,
		);
		expect(res.status).toBe(422);
		expect(textOf(html)).toContain(
			"Pick a name, keep the bank's, or type your own.",
		);
		expect(html).toMatch(/<details[^>]*\bopen/);
	});

	it("says a name the bank sent is From your bank, with no sparkles icon and no Why?, with the names switch on and off", async () => {
		await insertTx({
			raw: "SQ *COMCAST 99",
			amount: 4000,
			merchantName: "Comcast",
		});
		await insertTx({
			raw: "SQ *COMCAST 99",
			amount: 4000,
			merchantName: "Comcast",
		});
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Comcast', 'Comcast', 'pending')",
			)
			.run();
		for (const names of [true, false]) {
			await saveAiSwitches(db, { names });
			const { html } = await get("/settings/suggestions");
			expect(textOf(html)).toContain("From your bank");
			expect(textOf(html)).toContain("Yes, Comcast");
			expect(html).not.toContain('data-icon="sparkles"');
			expect(textOf(html)).not.toContain("Tally's guess");
			expect(html).not.toContain("/how-it-works#names");
		}
	});

	it("draws a long bank text in the review heading, wrapping it inside the column", async () => {
		const raw = `SQ *${"x".repeat(48)}`;
		await insertTx({ raw, amount: 1200 });
		await insertTx({ raw, amount: 1200 });
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Long Store Name', 'pending')",
			)
			.bind(raw)
			.run();
		const { html } = await get("/settings/suggestions");
		expect(html).toContain(raw);
		const heading = html.split("<h2").find((part) => part.includes(raw)) ?? "";
		expect(heading.slice(0, heading.indexOf(">"))).toContain("wrap-anywhere");
	});
});

describe("names: the toast counts only the transactions whose shown name changes (decision 101)", () => {
	const NAMES = "Blue Bottle Coffee\nBlue Bottle\nBlue Bottle Cafe";

	/** Blue Bottle's charges, with a name waiting for them, as the screen asks it. */
	async function blueCharges(count = 3) {
		for (let i = 0; i < count; i += 1)
			await insertTx({ raw: BLUE, amount: 650 });
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			)
			.bind(BLUE, NAMES)
			.run();
	}

	/** Gives the first `count` top-level charges of Blue Bottle a name of their own. */
	async function ownNames(count: number) {
		const { results } = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = ? AND parent_id IS NULL ORDER BY id LIMIT ?",
			)
			.bind(BLUE, count)
			.all<{ id: number }>();
		for (const { id } of results)
			await db
				.prepare("UPDATE transactions SET own_name = 'Dog bed' WHERE id = ?")
				.bind(id)
				.run();
	}

	const answer = async (fields: Record<string, string>) =>
		post("/settings/suggestions", { id: await nameId(), ...fields }, true);

	it("leaves out a charge with its own name, so one of three is kept and two are renamed", async () => {
		await blueCharges();
		await ownNames(1);
		const { res } = await answer({
			answer: "else",
			name_pick: "s:Blue Bottle",
		});
		expect(trigger(res)).toEqual({
			toast: {
				message: "Renamed 2 transactions to Blue Bottle",
				type: "success",
			},
			announce: "Renamed 2 transactions to Blue Bottle. Nothing left to check.",
		});
	});

	it("says one transaction, not transactions, when a single charge changes", async () => {
		await blueCharges();
		await ownNames(2);
		const { res } = await answer({
			answer: "else",
			name_pick: "s:Blue Bottle",
		});
		expect(trigger(res).toast?.message).toBe(
			"Renamed 1 transaction to Blue Bottle",
		);
	});

	it("counts only the charges the bank's name changes for, when a person keeps it", async () => {
		await blueCharges();
		await ownNames(1);
		const { res } = await answer({ answer: "else", name_pick: "store" });
		expect(trigger(res).toast?.message).toBe(
			"Kept the bank's name for 2 transactions",
		);
	});

	it("says what was saved, with no count, when every charge keeps its own name", async () => {
		await blueCharges();
		await ownNames(3);
		const { res } = await answer({
			answer: "else",
			name_pick: "s:Blue Bottle",
		});
		expect(trigger(res)).toEqual({
			toast: {
				message: "Saved Blue Bottle for the transactions that come later",
				type: "success",
			},
			announce:
				"Saved Blue Bottle for the transactions that come later. Nothing left to check.",
		});
	});

	it("says the bank's name is kept for the transactions that come later, when every charge keeps its own name", async () => {
		await blueCharges();
		await ownNames(3);
		const { res } = await answer({ answer: "else", name_pick: "store" });
		expect(trigger(res).toast?.message).toBe(
			"Kept the bank's name for the transactions that come later",
		);
	});

	it("does not count a split part's own name: its purchase is the charge that counts", async () => {
		await blueCharges();
		const purchase = await row(
			"SELECT id FROM transactions WHERE raw_name = ? AND parent_id IS NULL ORDER BY id LIMIT 1",
			BLUE,
		);
		await db
			.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?")
			.bind(purchase?.id)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, parent_id, own_name) VALUES (?, 1, '2026-09-20', 300, ?, ?, 'Part')",
			)
			.bind(`part-${crypto.randomUUID()}`, BLUE, purchase?.id)
			.run();
		const { res } = await answer({
			answer: "else",
			name_pick: "s:Blue Bottle",
		});
		expect(trigger(res).toast?.message).toBe(
			"Renamed 3 transactions to Blue Bottle",
		);
	});

	it("counts a split as renamed, even when every part has its own name", async () => {
		await blueCharges(2);
		const purchase = await row(
			"SELECT id FROM transactions WHERE raw_name = ? AND parent_id IS NULL ORDER BY id LIMIT 1",
			BLUE,
		);
		await db
			.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?")
			.bind(purchase?.id)
			.run();
		for (const part of ["Part A", "Part B"])
			await db
				.prepare(
					"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, parent_id, own_name) VALUES (?, 1, '2026-09-20', 300, ?, ?, ?)",
				)
				.bind(`part-${crypto.randomUUID()}`, BLUE, purchase?.id, part)
				.run();
		const { res } = await answer({
			answer: "else",
			name_pick: "s:Blue Bottle",
		});
		expect(trigger(res).toast?.message).toBe(
			"Renamed 2 transactions to Blue Bottle",
		);
	});

	it("keeps the header counting every charge, whatever keeps its own name", async () => {
		await blueCharges();
		await ownNames(1);
		const { html } = await get("/settings/suggestions");
		expect(textOf(html)).toContain("3 transactions");
	});

	it("a typed name counts only under Type your own, and turns the suggestions down", async () => {
		await blueCharges();
		const alone = await answer({ answer: "else", merchant: "Typed" });
		expect(alone.res.status).toBe(422);
		expect(textOf(alone.html)).toContain(
			"Pick a name, keep the bank's, or type your own.",
		);
		expect(
			await row(
				"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
				BLUE,
			),
		).toMatchObject({ display_name: null, suggestion_status: "pending" });
		await answer({ answer: "else", name_pick: "own", merchant: "The Bottle" });
		expect(
			await row(
				"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
				BLUE,
			),
		).toMatchObject({
			display_name: "The Bottle",
			suggestion_status: "rejected",
		});
	});

	it("an empty typed name's error sits in the field under Type your own, which stays ticked", async () => {
		await blueCharges();
		const { res, html } = await answer({
			answer: "else",
			name_pick: "own",
			merchant: "",
		});
		expect(res.status).toBe(422);
		const id = (await nameId()).slice("name-".length);
		expect(html).toMatch(
			new RegExp(`<p id="suggestion-${id}-own-error" role="alert"`),
		);
		expect(html).not.toMatch(new RegExp(`<p id="suggestion-${id}-error"`));
		expect(html.indexOf(`id="suggestion-${id}-own-error"`)).toBeGreaterThan(
			html.indexOf("group-has-[.name-own:checked]:block"),
		);
		expect(html).toMatch(/<input[^>]*value="own"[^>]*name-own/);
	});
});

describe("the answered", () => {
	it("says so when an item was answered elsewhere, and moves on", async () => {
		const ids = await oneOfEach();
		await db
			.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = 'user' WHERE id = ?",
			)
			.bind(ids.income)
			.run();
		const { res, html } = await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "yes" },
			true,
		);
		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(textOf(html)).toContain("Suggestions · 1 of 4");
	});

	it("answering the last item shows Nothing left to check, and focus moves to it", async () => {
		const ids = await oneOfEach();
		const answers: [string, Record<string, string | string[]>][] = [
			[`income-${ids.income}`, { answer: "yes" }],
			[`transfer-${ids.transfer}`, { answer: "yes" }],
			[`category-${ids.category}`, { answer: "yes" }],
			[
				`new-${ids.suggestion}`,
				{
					answer: "yes",
					shown: ids.pets.map(String),
					ticked: ids.pets.map(String),
				},
			],
		];
		for (const [id, fields] of answers)
			await post("/settings/suggestions", { id, ...fields }, true);
		const { html } = await post(
			"/settings/suggestions",
			{ id: await nameId(), answer: "yes" },
			true,
		);
		expect(textOf(html)).toContain("Nothing left to check.");
		// The swapped-out Yes took focus with it, so the sentence takes it (as the question heading does).
		expect(html).toMatch(
			/<div tabindex="-1" autofocus[^>]*>[\s\S]*Nothing left to check\./,
		);
	});

	it("when the last answer leaves only items set aside for good, You skipped the rest takes focus", async () => {
		const ids = await oneOfEach();
		const others = [
			`income-${ids.income}`,
			`transfer-${ids.transfer}`,
			`category-${ids.category}`,
			`new-${ids.suggestion}`,
		];
		const query = [
			...others.map((id) => `skip=${id}`),
			...others.map((id) => `again=${id}`),
		].join("&");
		const { html } = await post(
			`/settings/suggestions?${query}`,
			{ id: await nameId(), answer: "yes" },
			true,
		);
		expect(textOf(html)).toContain("You skipped the rest.");
		expect(html).toMatch(
			/<div tabindex="-1" autofocus[^>]*>[\s\S]*You skipped the rest\./,
		);
	});

	it("a plain form post redirects back to the screen", async () => {
		const ids = await oneOfEach();
		const { res } = await post("/settings/suggestions", {
			id: `income-${ids.income}`,
			answer: "yes",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toMatch(/^\/settings\/suggestions/);
	});
});

describe("Settings' Never suggest list", () => {
	it("says Tally hasn't been told No yet when the list is empty", async () => {
		const { html } = await get("/settings");
		expect(textOf(html)).toContain("Tally hasn't been told No yet.");
	});

	it("lists each line with the day of the No, and Remove takes it away with a toast", async () => {
		const ids = await oneOfEach();
		await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		await post(
			"/settings/suggestions",
			{
				id: `income-${ids.income}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		const { html } = await get("/settings");
		expect(textOf(html)).toContain("Never suggest income for Venmo");
		expect(textOf(html)).toMatch(/You said No on [A-Z][a-z]{2} \d{1,2}/);
		const rule = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules",
		);
		const removed = await post(
			"/settings/never-suggest/remove",
			removal(rule),
			true,
		);
		expect(trigger(removed.res).toast?.message).toBe(
			"Removed. Tally can suggest that again.",
		);
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
	});

	it("says the year of a No from an earlier year", async () => {
		const year = new Date().getUTCFullYear();
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', ?)",
			)
			.bind(VENMO, `${year - 1}-12-31`)
			.run();
		const { html } = await get("/settings");
		expect(textOf(html)).toContain(`You said No on Dec 31, ${year - 1}`);
	});

	it("keeps the Always search through a Remove, both with and without script", async () => {
		const eatingOut = await categoryId("Eating Out");
		for (let i = 0; i < 21; i++)
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES (?, ?, ?)",
				)
				.bind(`MATCH ${i}`, `Match ${i}`, eatingOut)
				.run();
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', '2026-10-03')",
			)
			.bind(VENMO)
			.run();
		const rule = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules",
		);
		const search = await get("/settings?rules_search=Match");
		expect(search.html).toMatch(
			/never-suggest\/remove"[\s\S]*?name="rules_search" value="Match"/,
		);
		const scripted = await post(
			"/settings/never-suggest/remove",
			{ ...removal(rule), rules_search: "Match" },
			true,
		);
		expect(textOf(scripted.html)).toContain("merchants matching “Match”");
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', '2026-10-03')",
			)
			.bind(VENMO)
			.run();
		const again = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules",
		);
		const plain = await post("/settings/never-suggest/remove", {
			...removal(again),
			rules_search: "Match",
		});
		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("location")).toBe(
			"/settings?rules_search=Match#merchant-rules",
		);
	});

	it("a plain Remove of a line already gone goes back to Settings' rules, not to the form's own address", async () => {
		const { res } = await post("/settings/never-suggest/remove", {
			id: "999999",
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings#merchant-rules");
	});

	it("after Remove, focus moves to the next line's Remove, or to the heading when none is left", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('VENMO', 'income', '2026-10-03')",
			),
			db.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('CHEWY.COM 1', 'new_category', '2026-10-09')",
			),
		]);
		// Newest first: Chewy is the first line, so its Remove is the first; Venmo's comes after it.
		const chewy = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules WHERE merchant_key = 'CHEWY.COM 1'",
		);
		const first = await post(
			"/settings/never-suggest/remove",
			removal(chewy),
			true,
		);
		expect(focusedNeverLine(first.html)).toContain(
			"Never suggest income for Venmo",
		);
		const venmo = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules WHERE merchant_key = 'VENMO'",
		);
		const last = await post(
			"/settings/never-suggest/remove",
			removal(venmo),
			true,
		);
		expect(last.html).toMatch(
			/<h3[^>]*tabindex="-1"[^>]*autofocus[^>]*>Never suggest<\/h3>/,
		);
	});

	it("a Remove of a line already gone moves focus to the first line's Remove, or to the heading when none is left", async () => {
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES ('VENMO', 'income', '2026-10-03')",
			)
			.run();
		// The focused Remove was taken away by another tab, so this one asks again for a line that is gone.
		const stale = await post(
			"/settings/never-suggest/remove",
			{ id: "999999" },
			true,
		);
		expect(stale.res.status).toBe(200);
		expect(focusedNeverLine(stale.html)).toContain(
			"Never suggest income for Venmo",
		);
		const venmo = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules WHERE merchant_key = 'VENMO'",
		);
		await post("/settings/never-suggest/remove", removal(venmo), true);
		const empty = await post(
			"/settings/never-suggest/remove",
			{ id: "999999" },
			true,
		);
		expect(empty.html).toMatch(
			/<h3[^>]*tabindex="-1"[^>]*autofocus[^>]*>Never suggest<\/h3>/,
		);
	});
});

/** The merchant row's skip key, which the name item uses. */
async function nameId() {
	const r = await row(
		"SELECT rowid AS id FROM merchants WHERE raw_name = ?",
		BLUE,
	);
	return `name-${r?.id}`;
}

describe("a Yes on a Maybe keeps one line under the store it was asked about (decision 101, #459)", () => {
	/** The income Maybes the queue still asks, by their suggestion ids. */
	const incomeAsked = async () =>
		(await suggestionQueue(db))
			.filter((item) => item.kind === "income")
			.map((item) => item.id)
			.sort();
	/** How many "Never suggest" lines Settings draws: one Remove form per line. */
	const neverLineForms = (html: string) =>
		(html.match(/action="\/settings\/never-suggest\/remove"/g) ?? []).length;
	/** The stored lines, as "key:kind", whatever Settings hides. */
	const stored = async () =>
		(
			await db
				.prepare("SELECT merchant_key AS key, kind FROM never_suggest_rules")
				.all<{ key: string; kind: string }>()
		).results
			.map((line) => `${line.key}:${line.kind}`)
			.sort();

	it("a Yes on the store's name keeps one line, which also covers its bank text's older charge, and one Remove takes it", async () => {
		const named = await insertTx({
			raw: VENMO,
			merchantName: "Venmo",
			amount: -250000,
			incomeConfidence: 0.5,
		});
		const older = await insertTx({
			raw: VENMO,
			amount: -2500,
			date: "2026-09-01",
			incomeConfidence: 0.5,
		});
		expect(await incomeAsked()).toEqual(
			[`income-${named}`, `income-${older}`].sort(),
		);
		await post(
			"/settings/suggestions",
			{ id: `income-${named}`, answer: "no" },
			true,
		);
		const { res } = await post(
			"/settings/suggestions",
			{
				id: `income-${named}`,
				answer: "ask_yes",
				kind: "income",
				store: "Venmo",
			},
			true,
		);
		expect(trigger(res).toast?.message).toBe(
			"Got it. Tally won't suggest income for Venmo again. Change it in Settings.",
		);
		expect(await stored()).toEqual(["Venmo:income"]);
		expect(await incomeAsked()).toEqual([]);
		// Settings shows the store's one line, under its name.
		const { html } = await get("/settings");
		expect(neverLineForms(html)).toBe(1);
		expect(textOf(html)).toContain("Never suggest income for Venmo");
		const line = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules WHERE merchant_key = 'Venmo'",
		);
		await post("/settings/never-suggest/remove", removal(line), true);
		expect(await stored()).toEqual([]);
		// The No already took the named charge out of the queue, so only the bank text's charge comes back.
		expect(await incomeAsked()).toEqual([`income-${older}`]);
	});

	it("a Yes on a bank text's Maybe keeps one line under the bank text, and one Remove takes it", async () => {
		// The store's own charge has no Maybe, so only the bank text's older charge is asked.
		await insertTx({ raw: VENMO, merchantName: "Venmo", amount: -250000 });
		const bank = await insertTx({
			raw: VENMO,
			amount: -2500,
			date: "2026-09-01",
			incomeConfidence: 0.5,
		});
		await post(
			"/settings/suggestions",
			{ id: `income-${bank}`, answer: "no" },
			true,
		);
		await post(
			"/settings/suggestions",
			{
				id: `income-${bank}`,
				answer: "ask_yes",
				kind: "income",
				store: VENMO,
			},
			true,
		);
		expect(await stored()).toEqual([`${VENMO}:income`]);
		expect(await incomeAsked()).toEqual([]);
		expect(neverLineForms((await get("/settings")).html)).toBe(1);
		const line = await row(
			"SELECT id, merchant_key, kind FROM never_suggest_rules WHERE merchant_key = ?",
			VENMO,
		);
		await post("/settings/never-suggest/remove", removal(line), true);
		expect(await stored()).toEqual([]);
	});
});
