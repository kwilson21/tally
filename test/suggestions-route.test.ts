import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";

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

	it("No records it as not income and asks first, adding no line until Yes", async () => {
		const ids = await oneOfEach();
		const { html } = await post(
			"/settings/suggestions",
			{ id: `income-${ids.income}`, answer: "no" },
			true,
		);
		const text = textOf(html);
		expect(text).toContain("Not counted as income");
		expect(text).toContain("Don't suggest income again for Venmo?");
		expect(text).toContain("Say yes and Tally stops asking this for Venmo.");
		const tx = await row(
			"SELECT flag_income, credit_reviewed_by FROM transactions WHERE id = ?",
			ids.income,
		);
		expect(tx).toMatchObject({ flag_income: 0, credit_reviewed_by: "user" });
		expect(
			await row("SELECT COUNT(*) AS n FROM never_suggest_rules"),
		).toMatchObject({ n: 0 });
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

	it("No keeps it in the budget and asks first", async () => {
		const ids = await oneOfEach();
		const { html } = await post(
			"/settings/suggestions",
			{ id: `transfer-${ids.transfer}`, answer: "no" },
			true,
		);
		expect(textOf(html)).toContain("Kept in the budget");
		expect(textOf(html)).toContain(
			"Don't suggest a transfer again for Chase card payment?",
		);
		expect(
			await row(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
				ids.transfer,
			),
		).toMatchObject({ excluded: 0, excluded_source: "user" });
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

	it("a category set here clears a split's removed-amount mark, as the edit panel does", async () => {
		const ids = await oneOfEach();
		await db
			.prepare(
				"UPDATE transactions SET split_removed_from_cents = 500 WHERE id = ?",
			)
			.bind(ids.category)
			.run();
		await post(
			"/settings/suggestions",
			{ id: `category-${ids.category}`, answer: "yes" },
			true,
		);
		expect(
			await row(
				"SELECT split_removed_from_cents FROM transactions WHERE id = ?",
				ids.category,
			),
		).toMatchObject({ split_removed_from_cents: null });
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
			{ id: await nameId(), answer: "else", merchant: "Blue Bottle" },
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
			{ id: await nameId(), answer: "else", name_pick: "keep" },
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
			{ id: await nameId(), answer: "else", merchant: "x".repeat(81) },
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

	it("answering the last item shows Nothing left to check", async () => {
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
		const rule = await row("SELECT id FROM never_suggest_rules");
		const removed = await post(
			"/settings/never-suggest/remove",
			{ id: String(rule?.id) },
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
		const rule = await row("SELECT id FROM never_suggest_rules");
		const search = await get("/settings?rules_search=Match");
		expect(search.html).toMatch(
			/never-suggest\/remove"[\s\S]*?name="rules_search" value="Match"/,
		);
		const scripted = await post(
			"/settings/never-suggest/remove",
			{ id: String(rule?.id), rules_search: "Match" },
			true,
		);
		expect(textOf(scripted.html)).toContain("merchants matching “Match”");
		await db
			.prepare(
				"INSERT INTO never_suggest_rules (merchant_key, kind, decided_on) VALUES (?, 'income', '2026-10-03')",
			)
			.bind(VENMO)
			.run();
		const again = await row("SELECT id FROM never_suggest_rules");
		const plain = await post("/settings/never-suggest/remove", {
			id: String(again?.id),
			rules_search: "Match",
		});
		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("location")).toBe(
			"/settings?rules_search=Match#merchant-rules",
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
