import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanBankText } from "../src/clean-bank-text";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	applyBankTextRules,
	bankTextRuleStatements,
	changeBankTextRule,
	saveBankTextRule,
} from "../src/db/bank-text-rules";
import { unmakeCategory } from "../src/db/categories";
import {
	forgetText,
	loadLearnedLines,
	undoForget,
	withBankTextRules,
} from "../src/db/learned-lines";
import { applyMerchantRules } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { afterSync } from "../src/plaid/after-sync";
import { runSortInstance } from "../src/sort-instance";
import { fakeSteps } from "./fake-sort-steps";

// Change on a learned line (decision 163): a rule on the cleaned bank text files a matching transaction in a chosen
// category before Jev is asked. It fills only what nothing has filled (or a bill's category), like a merchant rule,
// and a merchant rule wins when both apply.

const db = env.DB;
const RAW_A = "SQ *LOCAL BAKERY 4432";
const RAW_B = "SQ *LOCAL BAKERY 0917";
const CLEANED = "local bakery";
const OTHER = "SQ *BLUE BOTTLE 0412";
const KEY = "jev-key";

const categoryId = async (name: string) =>
	(
		await db
			.prepare("SELECT id FROM categories WHERE name = ?")
			.bind(name)
			.first<{ id: number }>()
	)?.id ?? 0;

/** A money-out row (positive cents), with whatever the test needs; the account is the first non-cash one. */
async function txn(
	raw: string,
	options: {
		category?: number | null;
		source?: string | null;
		isSplit?: number;
		splitRemoved?: number | null;
		date?: string;
		/** Positive is money out (Plaid's sign), negative a credit. */
		amount?: number;
	} = {},
): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, split_removed_from_cents)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			options.date ?? "2026-10-02",
			options.amount ?? 1499,
			raw,
			options.category ?? null,
			options.source ?? null,
			options.isSplit ?? 0,
			options.splitRemoved ?? null,
		)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

const stateOf = (id: number) =>
	db
		.prepare(
			"SELECT category_id AS categoryId, category_source AS source, category_confidence AS confidence, updated_at AS updatedAt FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			source: string | null;
			confidence: number | null;
			updatedAt: string;
		}>();

const ruleCount = async (text = CLEANED) =>
	(
		await db
			.prepare(
				"SELECT COUNT(*) AS n FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(text)
			.first<{ n: number }>()
	)?.n ?? 0;

async function addRule(text: string, category: number) {
	await db
		.prepare(
			"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)",
		)
		.bind(text, category)
		.run();
}

// Jev's answer in the shape the sort step reads: Eating Out at 95%, no flags, nothing else worth asking.
const reply = () =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence: 0.95 },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
			kind: { type: "choice", choice: "one_off", confidence: 0.99 },
			for_person: { type: "choice", choice: "none", confidence: 0.99 },
			note_worth_writing: { type: "noul", noul: 0.95 },
		},
	});

/** A fake Jev that records each request's body, so a test can read what Jev was told. */
function fakeJev() {
	const sent: { description: string; state: Record<string, unknown> }[] = [];

	const fetchImpl = async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		sent.push({
			description: body.state.bank_description,
			state: body.state,
		});

		return reply();
	};

	return { sent, fetchImpl };
}

beforeEach(async () => {
	await resetDemo(db, "2026-10-15");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Books & audio', 'books & audio', 'books', 'cat-plum', 95)",
		),
	]);
});

describe("applyBankTextRules", () => {
	it("fills an unfilled row whose cleaned bank text matches, whatever its date and reference, and no other", async () => {
		expect(cleanBankText(RAW_A)).toBe(CLEANED);
		expect(cleanBankText(RAW_B)).toBe(CLEANED);
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);
		const b = await txn(RAW_B, { date: "2026-10-09" });
		const other = await txn(OTHER);
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
			confidence: null,
		});
		expect(await stateOf(b)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
		expect(await stateOf(other)).toMatchObject({
			categoryId: null,
			source: null,
		});
	});

	it("a merchant rule wins when both apply, and the rule fills what no merchant rule covers", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await addRule(CLEANED, books);
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?) ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id",
			)
			.bind(RAW_A, eating)
			.run();
		const a = await txn(RAW_A);
		const b = await txn(RAW_B);
		// The sync's order: merchant rules first, then the bank-text rules.
		await applyMerchantRules(db);
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({
			categoryId: eating,
			source: "merchant_rule",
		});
		expect(await stateOf(b)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("never replaces a person's choice, a Jev guess, a split parent, or a row of another text", async () => {
		const books = await categoryId("Books & audio");
		const groceries = await categoryId("Groceries");
		await addRule(CLEANED, books);
		const user = await txn(RAW_A, { category: groceries, source: "user" });
		const jev = await txn(RAW_B, { category: groceries, source: "jev" });
		const parent = await txn(RAW_A, { isSplit: 1 });

		const removed = await txn(RAW_A, {
			category: groceries,
			splitRemoved: 500,
		});

		const other = await txn(OTHER, { category: groceries, source: "user" });
		const unsorted = await txn(OTHER);

		const before = await Promise.all(
			[user, jev, parent, removed, other, unsorted].map(stateOf),
		);

		await applyBankTextRules(db);

		const after = await Promise.all(
			[user, jev, parent, removed, other, unsorted].map(stateOf),
		);

		expect(after).toEqual(before);
		expect(after[0]).toMatchObject({ categoryId: groceries, source: "user" });
		expect(after[1]).toMatchObject({ categoryId: groceries, source: "jev" });
	});

	it("skips a rule whose category is archived, and works again once it is restored", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(books)
			.run();
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
		await db
			.prepare("UPDATE categories SET archived = 0 WHERE id = ?")
			.bind(books)
			.run();
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("replaces a bill's category, as a merchant rule does", async () => {
		const books = await categoryId("Books & audio");
		const groceries = await categoryId("Groceries");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A, { category: groceries, source: "bill" });
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
			confidence: null,
		});
	});

	it("fills many rows in one pass, and a second pass changes nothing", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		// 250 different raw names (each with its own reference number) under one cleaned text: more than one chunk.
		const ids: number[] = [];

		for (let i = 0; i < 250; i++) {
			ids.push(await txn(`SQ *LOCAL BAKERY ${1000 + i}`));
		}

		await applyBankTextRules(db);

		const filled = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'merchant_rule' AND category_id = ?",
			)
			.bind(books)
			.first<{ n: number }>();

		expect(filled?.n).toBe(250);
		// Marked with an old time: a row the second pass rewrote would show it.
		await db
			.prepare("UPDATE transactions SET updated_at = '2000-01-01 00:00:00'")
			.run();
		await applyBankTextRules(db);

		const touched = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE updated_at != '2000-01-01 00:00:00'",
			)
			.first<{ n: number }>();

		expect(touched?.n).toBe(0);
		expect(ids).toHaveLength(250);
	});

	it("changes nothing when there is no rule", async () => {
		const a = await txn(RAW_A);
		await applyBankTextRules(db);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
	});
});

describe("the sync and the sort step", () => {
	it("fills the row in the sync's own steps, after the merchant rules", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);
		await afterSync(db);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("fills an unsorted purchase before the sort asks Jev, so Jev is never asked about it", async () => {
		await saveAiSwitches(db, { details: false });
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);
		const jev = fakeJev();
		await runSortInstance(
			{ DB: db, JEV_API_KEY: KEY, DEMO: "false" },
			fakeSteps().runStep,
			{ bySync: false, rulesApplied: false, night: "2026-10-13" },
			{ runId: crypto.randomUUID(), fetchImpl: jev.fetchImpl },
		);
		// Without the rule Jev would have been asked about this row and answered Eating Out.
		expect(jev.sent.map((request) => request.description)).not.toContain(RAW_A);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("keeps a rule-filled credit's category when Jev answers its income review", async () => {
		await saveAiSwitches(db, { details: false });
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		// A credit is still asked for its income review, as a merchant rule's credit is (decision 79).
		const credit = await txn(RAW_B, { amount: -1499 });
		const jev = fakeJev();
		await runSortInstance(
			{ DB: db, JEV_API_KEY: KEY, DEMO: "false" },
			fakeSteps().runStep,
			{ bySync: false, rulesApplied: false, night: "2026-10-13" },
			{ runId: crypto.randomUUID(), fetchImpl: jev.fetchImpl },
		);
		expect(jev.sent.map((request) => request.description)).toContain(RAW_B);
		// Jev's answer would have been Eating Out; the rule's category stays, as a merchant rule's row does.
		expect(await stateOf(credit)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("tells Jev the rule's category as a rule, with no answer count", async () => {
		await saveAiSwitches(db, { details: false });
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await addRule(CLEANED, books);

		for (const day of ["2026-10-01", "2026-10-02"]) {
			await db
				.prepare(
					"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, 1499, ?, ?, 'user')",
				)
				.bind(`plaid-${crypto.randomUUID()}`, day, RAW_A, eating)
				.run();
		}

		await txn(RAW_B, { amount: -1499 });
		const jev = fakeJev();
		await runSortInstance(
			{ DB: db, JEV_API_KEY: KEY, DEMO: "false" },
			fakeSteps().runStep,
			{ bySync: false, rulesApplied: false, night: "2026-10-13" },
			{ runId: crypto.randomUUID(), fetchImpl: jev.fetchImpl },
		);
		const asked = jev.sent.find((request) => request.description === RAW_B);
		expect(asked?.state.learned_category).toEqual({
			category: "Books & audio",
			rule: true,
		});
	});
});

describe("the learned lines", () => {
	it("counts a row a rule filled as one of the answers, and shows the rule's category", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		await txn(RAW_A);
		await txn(RAW_B);
		await applyBankTextRules(db);

		const line = (await loadLearnedLines(db)).find(
			(l) => l.cleanedText === CLEANED,
		);

		expect(line).toMatchObject({
			categoryName: "Books & audio",
			answers: 2,
			rule: true,
		});
	});

	it("gives a rule with no answers a line of its own", async () => {
		const books = await categoryId("Books & audio");
		await addRule("blue bottle", books);
		expect(
			(await loadLearnedLines(db)).find((l) => l.cleanedText === "blue bottle"),
		).toMatchObject({
			name: "Blue Bottle",
			categoryName: "Books & audio",
			answers: 0,
			rule: true,
		});
	});

	it("makes no line from a rule whose category is archived", async () => {
		const books = await categoryId("Books & audio");
		await addRule("blue bottle", books);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(books)
			.run();
		expect(
			(await loadLearnedLines(db)).find((l) => l.cleanedText === "blue bottle"),
		).toBeUndefined();
	});
});

describe("Forget and its Undo with a rule", () => {
	it("Forget removes the rule, and Undo puts it back with its category", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		await txn(RAW_A);
		const id = await forgetText(db, CLEANED);
		expect(await ruleCount()).toBe(0);
		expect(await undoForget(db, id)).toBe("undone");

		const back = await db
			.prepare(
				"SELECT category_id AS categoryId FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(CLEANED)
			.first<{ categoryId: number }>();

		expect(back?.categoryId).toBe(books);

		const forgotten = await db
			.prepare("SELECT rule_category_id AS r FROM forgotten_texts")
			.first<{ r: number | null }>();

		expect(forgotten).toBeNull();
	});

	it("Undo never overwrites a newer rule on the same text", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await addRule(CLEANED, books);
		const id = await forgetText(db, CLEANED);
		await addRule(CLEANED, eating);
		expect(await undoForget(db, id)).toBe("undone");

		const rule = await db
			.prepare(
				"SELECT category_id AS categoryId FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(CLEANED)
			.first<{ categoryId: number }>();

		expect(rule?.categoryId).toBe(eating);
	});

	it("a Forget without a rule records none, so its Undo adds none", async () => {
		await txn(RAW_A, {
			category: await categoryId("Groceries"),
			source: "user",
		});
		const id = await forgetText(db, CLEANED);
		expect(await undoForget(db, id)).toBe("undone");
		expect(await ruleCount()).toBe(0);
	});
});

describe("saving a rule", () => {
	it("keeps one row per text when it is saved twice, with the latest category", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await saveBankTextRule(db, CLEANED, books);
		await saveBankTextRule(db, CLEANED, eating);
		expect(await ruleCount()).toBe(1);

		const row = await db
			.prepare(
				"SELECT category_id AS categoryId FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(CLEANED)
			.first<{ categoryId: number }>();

		expect(row?.categoryId).toBe(eating);
	});
});

describe("a Change is one atomic batch, and its apply is guarded (review of #838)", () => {
	// A trigger that makes any update of a row's category fail, standing in for an apply that errors mid-batch.
	const failApply = () =>
		db
			.prepare(
				"CREATE TRIGGER fail_bank_apply BEFORE UPDATE OF category_id ON transactions BEGIN SELECT RAISE(ABORT, 'apply nope'); END",
			)
			.run();

	afterEach(async () => {
		await db.prepare("DROP TRIGGER IF EXISTS fail_bank_apply").run();
	});

	it("a failed apply leaves no rule row: the upsert and the apply are one batch", async () => {
		const books = await categoryId("Books & audio");
		await txn(RAW_A);
		await failApply();
		await expect(changeBankTextRule(db, CLEANED, books)).rejects.toThrow();
		expect(await ruleCount()).toBe(0);
	});

	it("a Change saves the rule and fills what it matches in one go", async () => {
		const books = await categoryId("Books & audio");
		const a = await txn(RAW_A);
		await changeBankTextRule(db, CLEANED, books);
		expect(await ruleCount()).toBe(1);
		expect(await stateOf(a)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("a Change applies the merchant rules first, so a row both rules match gets the merchant rule's category", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?) ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id",
			)
			.bind(RAW_A, eating)
			.run();
		const both = await txn(RAW_A);
		const bankOnly = await txn(RAW_B);
		await changeBankTextRule(db, CLEANED, books);
		expect(await stateOf(both)).toMatchObject({
			categoryId: eating,
			source: "merchant_rule",
		});
		expect(await stateOf(bankOnly)).toMatchObject({
			categoryId: books,
			source: "merchant_rule",
		});
	});

	it("a statement built for a rule fills nothing once that rule is deleted", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);

		const statements = await bankTextRuleStatements(db, [
			{ cleanedText: CLEANED, categoryId: books },
		]);

		await db.prepare("DELETE FROM bank_text_rules").run();
		await db.batch(statements);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
	});

	it("a statement built for a rule fills nothing once that rule has another category", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await addRule(CLEANED, books);
		const a = await txn(RAW_A);

		const statements = await bankTextRuleStatements(db, [
			{ cleanedText: CLEANED, categoryId: books },
		]);

		await db
			.prepare(
				"UPDATE bank_text_rules SET category_id = ? WHERE cleaned_text = ?",
			)
			.bind(eating, CLEANED)
			.run();
		await db.batch(statements);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
	});
});

describe("a Change to a category archived before its batch (review of #838, round 2)", () => {
	it("writes no rule, fills nothing, and reports that nothing changed", async () => {
		const books = await categoryId("Books & audio");
		const a = await txn(RAW_A);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(books)
			.run();
		expect(await changeBankTextRule(db, CLEANED, books)).toBe(false);
		expect(await ruleCount()).toBe(0);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
	});

	it("leaves an older rule as it was, and fills nothing with the refused category", async () => {
		const books = await categoryId("Books & audio");
		const eating = await categoryId("Eating Out");
		await addRule(CLEANED, eating);
		const a = await txn(RAW_A);
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(books)
			.run();
		expect(await changeBankTextRule(db, CLEANED, books)).toBe(false);

		const rule = await db
			.prepare(
				"SELECT category_id AS categoryId FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(CLEANED)
			.first<{ categoryId: number }>();

		expect(rule?.categoryId).toBe(eating);
		expect(await stateOf(a)).toMatchObject({ categoryId: null, source: null });
	});

	it("a Change to an active category reports that it was written", async () => {
		const books = await categoryId("Books & audio");
		expect(await changeBankTextRule(db, CLEANED, books)).toBe(true);
		expect(await ruleCount()).toBe(1);
	});
});

describe("withBankTextRules (pure)", () => {
	const line = {
		cleanedText: "netflix.com",
		name: "Netflix.com",
		categoryId: 11,
		categoryName: "Entertainment",
		icon: "entertainment",
		color: "cat-blue",
		answers: 3,
		vague: false,
	};

	const rule = {
		cleanedText: "netflix.com",
		categoryId: 40,
		categoryName: "Books & audio",
		icon: "books",
		color: "cat-plum",
	};

	it("shows a rule's category on its text's line, and marks it a rule, keeping the answers' count", () => {
		expect(withBankTextRules([line], [rule])).toEqual([
			{
				...line,
				categoryId: 40,
				categoryName: "Books & audio",
				icon: "books",
				color: "cat-plum",
				rule: true,
			},
		]);
	});

	it("gives a rule with no line a line of its own, with no answers", () => {
		const other = { ...rule, cleanedText: "blue bottle" };
		const lines = withBankTextRules([line], [other]);
		expect(lines.map((l) => l.cleanedText)).toEqual([
			"blue bottle",
			"netflix.com",
		]);
		expect(lines[0]).toMatchObject({
			name: "Blue Bottle",
			answers: 0,
			vague: false,
			rule: true,
		});
	});

	it("never gives a vague text a rule", () => {
		const vague = { ...line, cleanedText: "apple.com/bill", vague: true };
		const apple = { ...rule, cleanedText: "apple.com/bill" };
		expect(withBankTextRules([vague], [apple])).toEqual([vague]);
		expect(withBankTextRules([], [apple])).toEqual([]);
	});

	it("leaves lines alone when there are no rules", () => {
		expect(withBankTextRules([line], [])).toEqual([line]);
	});
});

describe("schema", () => {
	it("a rule goes with its category when the category is removed, and a Forget's rule link is cleared", async () => {
		const temp = await db
			.prepare(
				"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES ('Temporary', 'temporary', 'books', 'cat-plum', 99) RETURNING id",
			)
			.first<{ id: number }>();

		const tempId = temp?.id ?? 0;
		await addRule("temp text", tempId);
		await db
			.prepare(
				"INSERT INTO forgotten_texts (cleaned_text, rule_category_id) VALUES ('old text', ?)",
			)
			.bind(tempId)
			.run();
		await db.prepare("DELETE FROM categories WHERE id = ?").bind(tempId).run();
		expect(await ruleCount("temp text")).toBe(0);

		const forgotten = await db
			.prepare(
				"SELECT rule_category_id AS r FROM forgotten_texts WHERE cleaned_text = 'old text'",
			)
			.first<{ r: number | null }>();

		expect(forgotten?.r).toBeNull();
	});

	it("unmakeCategory keeps a category a rule uses", async () => {
		const books = await categoryId("Books & audio");
		await addRule(CLEANED, books);
		await unmakeCategory(db, books);
		expect(await categoryId("Books & audio")).toBe(books);
	});
});
