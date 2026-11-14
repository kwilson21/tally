import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import {
	categoryMaybeStatements,
	maybeFacts,
	moneyMaybeStatements,
} from "../src/db/suggestion-saves";
import { saveEdit, seenOf } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	type Eligibility,
	type EligibilityRow,
	eligibility,
	readEligibility,
	readEligibilityRows,
} from "../src/lookup/eligibility";
import { inputMark } from "../src/lookup/input-mark";
import { lookupTextOf } from "../src/lookup/lookup-text";

// The eligibility decision (src/lookup/eligibility.ts): for each lookup text, private, not_yet or may_search, decided from one
// row per transaction. The pure decision is tested first; then the database read, one test per input it depends on; then the
// real save paths; then the read's shape.

/** An ordinary row that has cleared the lookup: nothing holds its text back. Each test changes the one thing it is about. */
function row(overrides: Partial<EligibilityRow> = {}): EligibilityRow {
	return {
		id: 1,
		lookupText: "corner cafe",
		private: false,
		sign: true,
		jev: "answered",
		mark: "cleared",
		ruleSettled: false,
		...overrides,
	};
}

/** The decision for the one text the rows share. */
function decide(...rows: EligibilityRow[]): Eligibility | undefined {
	return eligibility(rows).get("corner cafe");
}

describe("eligibility: what a text's rows say", () => {
	it("a cleared row and a row Jev gave up on hold the text back, for its rows (BUG_GAVE_UP_OK)", () => {
		expect(
			decide(row({ id: 1 }), row({ id: 2, jev: "gave_up", mark: "owed" })),
		).toEqual({ kind: "not_yet", why: "rows", owed: [] });
	});

	it("a cleared row with a waiting row holds the text back, for its rows", () => {
		expect(decide(row({ id: 1 }), row({ id: 2, jev: "waiting" }))).toEqual({
			kind: "not_yet",
			why: "rows",
			owed: [],
		});
	});

	it("a cleared row with an asked row holds the text back, for its rows, and asks for nothing new", () => {
		expect(decide(row({ id: 1 }), row({ id: 2, mark: "asked" }))).toEqual({
			kind: "not_yet",
			why: "rows",
			owed: [],
		});
	});

	it("a cleared row with an owed row holds the text back, and lists only the owed row's id", () => {
		expect(decide(row({ id: 1 }), row({ id: 7, mark: "owed" }))).toEqual({
			kind: "not_yet",
			why: "rows",
			owed: [7],
		});
	});

	it("a cleared row and a never row may search: a row a person filed and Jev never asked blocks nothing", () => {
		expect(decide(row({ id: 1 }), row({ id: 2, jev: "never" }))).toEqual({
			kind: "may_search",
		});
	});

	it("only never rows: not yet, for want of a cleared row, and nothing owed", () => {
		expect(decide(row({ id: 1, jev: "never" }))).toEqual({
			kind: "not_yet",
			why: "no_cleared",
			owed: [],
		});
	});

	it("two keys sharing one text, one of them private, make the text private", () => {
		expect(decide(row({ id: 1 }), row({ id: 2, private: true }))).toEqual({
			kind: "private",
		});
	});

	it("every row rule-settled holds the text back as a rule; one row not settled does not", () => {
		expect(
			decide(
				row({ id: 1, ruleSettled: true }),
				row({ id: 2, ruleSettled: true }),
			),
		).toEqual({ kind: "not_yet", why: "rule", owed: [] });

		expect(
			decide(
				row({ id: 1, ruleSettled: true }),
				row({ id: 2, ruleSettled: false }),
			),
		).toEqual({ kind: "may_search" });
	});

	it("no row with a sign holds the text back as no_sign, even when a row is cleared", () => {
		expect(decide(row({ id: 1, sign: false }))).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("a text with a private row is private, whatever else its rows say", () => {
		expect(
			decide(row({ id: 1, private: true, sign: false, jev: "waiting" })),
		).toEqual({ kind: "private" });
	});

	it("a text with a cleared row and nothing against it may search", () => {
		expect(decide(row({ id: 1 }))).toEqual({ kind: "may_search" });
	});
});

// ---------------------------------------------------------------------------------------------------------------------------
// The database read. Every test starts from a text that reads may_search, changes one thing, and expects the answer to change,
// so removing any one input from the read or the decision fails at least one test.

const db = env.DB;
const TODAY = "2026-09-22";
const STORE = "Harbor Bakery";
const TEXT = "harbor bakery";
const WHO = "person@example.com";

/** Two active categories, the first filed on the store's rows and the second used by rules. Set in beforeEach. */
let food = 0;
let other = 0;

let plaidSeq = 0;

/** Inserts one purchase on the checking account and returns its id; the defaults are an ordinary, sign-bearing row. */
async function addRow(
	values: Record<string, string | number | null>,
): Promise<number> {
	plaidSeq += 1;

	const row = {
		account_id: 1,
		date: TODAY,
		amount_cents: -1200,
		raw_name: STORE,
		plaid_transaction_id: `eligibility-${plaidSeq}`,
		plaid_category: "FOOD_AND_DRINK",
		...values,
	};

	const columns = Object.keys(row);

	const inserted = await db
		.prepare(
			`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) RETURNING id`,
		)
		.bind(...Object.values(row))
		.first<{ id: number }>();

	return Number(inserted?.id);
}

/** Writes the row's lookup mark as the sort would: the fingerprint of what Jev is told, as it stands now. */
async function markCleared(id: number, cleared = 1) {
	const seen = (await seenOf(db, [id])).get(id);

	await db
		.prepare(
			"INSERT INTO lookup_cleared (transaction_id, input_mark, cleared) VALUES (?, ?, ?)",
		)
		.bind(id, seen ? await inputMark(seen) : "", cleared)
		.run();
}

/** A store's row Jev answered and cleared: filed on the first category by Jev, with its mark. Set the fields first. */
async function clearedRow(values: Record<string, string | number | null> = {}) {
	const id = await addRow({
		category_id: food,
		category_source: "jev",
		jev_category_id: food,
		...values,
	});

	await markCleared(id, 1);

	return id;
}

/** The decision for one lookup text, read over every row (no filter). */
const decided = async (text = TEXT): Promise<Eligibility | undefined> =>
	(await readEligibility(db)).get(text);

/** The store's text reads may_search; the check every input test starts from. */
async function expectMaySearch(text = TEXT) {
	expect(await decided(text)).toEqual({ kind: "may_search" });
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM merchant_lookup_texts").run();
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);

	const categories = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 2")
		.all<{ id: number }>();

	food = Number(categories.results[0]?.id);
	other = Number(categories.results[1]?.id);

	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("readEligibility: privacy facts a row carries", () => {
	it.each(["flag_transfer", "flag_income", "flag_reimbursement"])(
		"%s on a row makes its text private",
		async (flag) => {
			const id = await clearedRow();
			await expectMaySearch();

			await db
				.prepare(`UPDATE transactions SET ${flag} = 1 WHERE id = ?`)
				.bind(id)
				.run();

			expect(await decided()).toEqual({ kind: "private" });
		},
	);

	it("an excluded row makes its text private", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET excluded = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a row of the transfer kind makes its text private", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET kind = 'transfer' WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});

	it.each([{ transfer_confidence: 0.6 }, { income_confidence: 0.5 }])(
		"an unanswered Maybe in range %o makes its text private",
		async (guess) => {
			const id = await clearedRow();
			await expectMaySearch();

			const [column, confidence] = Object.entries(guess)[0] ?? [];

			await db
				.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ?`)
				.bind(confidence, id)
				.run();

			expect(await decided()).toEqual({ kind: "private" });
		},
	);

	it("a confidence below the Maybe range changes nothing", async () => {
		const id = await clearedRow();

		await db
			.prepare(
				"UPDATE transactions SET transfer_confidence = 0.2, income_confidence = 0.9 WHERE id = ?",
			)
			.bind(id)
			.run();

		await expectMaySearch();
	});

	it.each(["TRANSFER_OUT", "INCOME", "BANK_FEES"])(
		"the Plaid category %s makes its text private",
		async (category) => {
			const id = await clearedRow();
			await expectMaySearch();

			await db
				.prepare("UPDATE transactions SET plaid_category = ? WHERE id = ?")
				.bind(category, id)
				.run();

			expect(await decided()).toEqual({ kind: "private" });
		},
	);

	it("a payment app's name in the merchant key makes its text private", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		const key = "Venmo Harbor Bakery";

		await db
			.prepare("UPDATE transactions SET merchant_name = ? WHERE id = ?")
			.bind(key, id)
			.run();

		expect(await decided(lookupTextOf(key))).toEqual({ kind: "private" });
	});

	it("a bank rail in one row's raw text under a Plaid name makes its text private", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare(
				"UPDATE transactions SET merchant_name = ?, raw_name = ? WHERE id = ?",
			)
			.bind(STORE, "ACH DEBIT HARBOR BAKERY", id)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a second key sharing the text, private in merchant_lookup_texts and nothing else private, makes the text private", async () => {
		await clearedRow();
		await expectMaySearch();

		await addRow({
			raw_name: "HARBOR BAKERY",
			category_id: other,
			category_source: "user",
		});
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES ('HARBOR BAKERY', ?, 1)",
			)
			.bind(TEXT)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});
});

describe("readEligibility: whether a row is a sign of a store", () => {
	it("the only categorized row moved to a cash account has no sign", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		const cash = await db
			.prepare("SELECT id FROM accounts WHERE type = 'cash' LIMIT 1")
			.first<{ id: number }>();

		await db
			.prepare("UPDATE transactions SET account_id = ? WHERE id = ?")
			.bind(cash?.id, id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("the only categorized row on an Apple Card account has no sign", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		const apple = await db
			.prepare(
				"INSERT INTO accounts (name, type, subtype, balance_cents) VALUES ('Apple Card', 'credit', 'apple_card', 0) RETURNING id",
			)
			.first<{ id: number }>();

		await db
			.prepare("UPDATE transactions SET account_id = ? WHERE id = ?")
			.bind(apple?.id, id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("the only categorized row entered by hand (no Plaid transaction) has no sign", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare(
				"UPDATE transactions SET plaid_transaction_id = NULL WHERE id = ?",
			)
			.bind(id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("the only categorized row that is a split part has no sign", async () => {
		const parent = await addRow({ raw_name: "Split Parent Mart", is_split: 1 });
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET parent_id = ? WHERE id = ?")
			.bind(parent, id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("the only categorized row with its Plaid category removed has no sign", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET plaid_category = NULL WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "no_sign",
			owed: [],
		});
	});

	it("a pending row with an ordinary Plaid category is a sign", async () => {
		const id = await addRow({
			pending: 1,
			category_id: food,
			category_source: "jev",
			jev_category_id: food,
		});

		await markCleared(id, 1);

		expect(await decided()).toEqual({ kind: "may_search" });
	});
});

describe("readEligibility: what a row's Jev state holds back", () => {
	it("a second row Jev is still waiting on holds the text back, for its rows", async () => {
		await clearedRow();
		await expectMaySearch();

		await addRow({});

		expect(await decided()).toEqual({ kind: "not_yet", why: "rows", owed: [] });
	});

	it("a second row Jev gave up on (five failures) holds the text back, for its rows", async () => {
		await clearedRow();
		await expectMaySearch();

		await addRow({ jev_attempts: 5 });

		expect(await decided()).toEqual({ kind: "not_yet", why: "rows", owed: [] });
	});

	it("a second row Jev answered with no lookup mark is owed, and holds the text back", async () => {
		await clearedRow();
		await expectMaySearch();

		const id = await addRow({
			category_id: food,
			category_source: "jev",
			jev_category_id: food,
		});

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "rows",
			owed: [id],
		});
	});

	it("a row whose mark says Jev did not clear it holds the text back, as asked", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE lookup_cleared SET cleared = 0 WHERE transaction_id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({ kind: "not_yet", why: "rows", owed: [] });
	});

	it("a cleared row whose note is edited is owed, and its id is in owed", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET note = 'Birthday cake' WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({
			kind: "not_yet",
			why: "rows",
			owed: [id],
		});
	});

	it("a row filed by a person with a mark Jev did not clear is answered, not never, and holds the text back", async () => {
		await clearedRow();
		await expectMaySearch();

		const id = await addRow({ category_id: other, category_source: "user" });
		await markCleared(id, 0);

		expect(await decided()).toEqual({ kind: "not_yet", why: "rows", owed: [] });
	});
});

/** Each column Jev's answer writes (holdsJevAnswerSql), with a value that says Jev answered. FOOD stands for the store's category. */
const JEV_ANSWER_COLUMNS: [string, string | number][] = [
	["category_confidence", 0.1],
	["jev_category_id", "FOOD"],
	["jev_also_category_id", "FOOD"],
	["income_confidence", 0.1],
	["transfer_confidence", 0.1],
	["category_source", "jev"],
	["income_source", "jev"],
	["excluded_source", "jev"],
	["jev_none_fit", 1],
	["jev_mixed", 0.3],
	["details_asked", 1],
	["credit_reviewed", 1],
];

describe("readEligibility: each column Jev's answer writes counts as an answer", () => {
	it.each(JEV_ANSWER_COLUMNS)(
		"a row a person filed, with %s set by Jev and no mark, is answered and owed",
		async (column, value) => {
			await clearedRow();
			await expectMaySearch();

			const id = await addRow({ category_id: other, category_source: "user" });

			await db
				.prepare(`UPDATE transactions SET ${column} = ? WHERE id = ?`)
				.bind(value === "FOOD" ? food : value, id)
				.run();

			expect(await decided()).toEqual({
				kind: "not_yet",
				why: "rows",
				owed: [id],
			});
		},
	);
});

describe("readEligibility: rules that settle a text", () => {
	it("a merchant rule on the key settles the text", async () => {
		await clearedRow();
		await expectMaySearch();

		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
			)
			.bind(STORE, food)
			.run();

		expect(await decided()).toEqual({ kind: "not_yet", why: "rule", owed: [] });
	});

	it("a bank-text rule on the text settles it", async () => {
		await clearedRow();
		await expectMaySearch();

		await db
			.prepare(
				"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
			)
			.bind(cleanBankText(STORE), food)
			.run();

		expect(await decided()).toEqual({ kind: "not_yet", why: "rule", owed: [] });
	});

	it("a merchant rule and a bank-text rule whose category is archived settle nothing", async () => {
		// The rules are made before the row, so its mark is taken with them in place: a rule's row changes what the row's
		// suggestion status reads as, which is a fact Jev is told.
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
			)
			.bind(STORE, other)
			.run();
		await db
			.prepare(
				"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
			)
			.bind(cleanBankText(STORE), other)
			.run();
		await clearedRow();

		expect(await decided()).toEqual({ kind: "not_yet", why: "rule", owed: [] });

		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(other)
			.run();

		await expectMaySearch();
	});
});

describe("readEligibility: stale and missing marks", () => {
	it("a stored private = 0 does not make a flagged row public, with no fill run", async () => {
		const id = await clearedRow();

		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0)",
			)
			.bind(STORE, TEXT)
			.run();
		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a key with no merchant_lookup_texts row at all is decided by the full read", async () => {
		const id = await clearedRow();

		await expectMaySearch();

		await db
			.prepare("UPDATE transactions SET flag_transfer = 1 WHERE id = ?")
			.bind(id)
			.run();

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a key stored under a stale text is found by its live text", async () => {
		const key = "Stale Harbor Bakery";
		const live = lookupTextOf(key);

		await clearedRow({ raw_name: key });
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, 'old text', 1)",
			)
			.bind(key)
			.run();

		const only = await readEligibility(db, { lookupTexts: [live] });

		expect(only.get(live)).toEqual({ kind: "private" });
	});

	it("a cleared row that is still pending is a sign and decides like a posted one", async () => {
		await clearedRow({ pending: 1 });

		expect(await decided()).toEqual({ kind: "may_search" });
	});
});

describe("readEligibility: through the app's own save paths", () => {
	it("a person's Yes on a Maybe transfer makes the text private", async () => {
		const id = await clearedRow({ transfer_confidence: 0.6 });
		expect(await decided()).toEqual({ kind: "private" });

		const facts = await maybeFacts(db, "transfer", id);

		await db.batch(
			moneyMaybeStatements(db, {
				kind: "transfer",
				answer: "yes",
				transactionId: id,
				today: TODAY,
				who: WHO,
				confidence: facts.confidence ?? 0,
				expectedVersion: facts.version,
			}),
		);

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a person excluding the row in the edit panel makes the text private", async () => {
		const id = await clearedRow();
		await expectMaySearch();

		await saveEdit(
			db,
			id,
			{
				categoryId: food,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: true,
				income: false,
				creditReviewed: false,
			},
			WHO,
		);

		expect(await decided()).toEqual({ kind: "private" });
	});

	it("a person's Yes on a category Maybe for a cleared row still lets the text search (the owner's answer)", async () => {
		const id = await addRow({
			category_confidence: 0.6,
			jev_category_id: food,
		});

		await markCleared(id, 1);
		await expectMaySearch();

		const facts = await maybeFacts(db, "category", id, other);

		await db.batch(
			categoryMaybeStatements(db, {
				transactionId: id,
				categoryId: other,
				today: TODAY,
				who: WHO,
				record: "yes",
				confidence: facts.confidence ?? 0.6,
				expectedVersion: facts.version,
			}),
		);

		await expectMaySearch();
	});
});

describe("readEligibilityRows: shape", () => {
	it("with an only filter, a text's answer is the same as in the full read", async () => {
		await clearedRow();
		await clearedRow({ raw_name: "Second Bakery Shop" });

		const full = await readEligibility(db);
		const only = await readEligibility(db, { lookupTexts: [TEXT] });

		expect(only.get(TEXT)).toEqual(full.get(TEXT));
		expect(only.size).toBe(1);
	});

	it("reads 1,200 transactions in one batch and two statements", async () => {
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
				INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, plaid_category)
				SELECT 1, ?, -100, 'Bulk Store ' || (i % 50), 'bulk-' || i, 'FOOD_AND_DRINK' FROM n`,
			)
			.bind(TODAY)
			.run();

		const batch = vi.spyOn(db, "batch");
		const prepare = vi.spyOn(db, "prepare");

		const rows = await readEligibilityRows(db);

		expect(rows.length).toBeGreaterThanOrEqual(1200);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	it("logs nothing about a transaction", async () => {
		await clearedRow();

		const logs = [
			vi.spyOn(console, "log"),
			vi.spyOn(console, "info"),
			vi.spyOn(console, "warn"),
			vi.spyOn(console, "error"),
		];

		await readEligibility(db);

		for (const spy of logs) expect(spy).not.toHaveBeenCalled();
	});
});
