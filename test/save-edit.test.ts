import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import {
	excludedBreakdown,
	getTransaction,
	listTransactions,
	monthCounts,
	needsCategoryCount,
	saveEdit,
	saveJevDetailsStatement,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { classify, type Row } from "../src/transactions/classify";
import { parseEdit } from "../src/transactions/edit";
import { parseFilters } from "../src/transactions/filters";
import { itemAt, present } from "./helpers/present";

const db = env.DB;
const TODAY = "2026-09-22";
const EATING_OUT = 2;
const GAS = 3;

const idOf = async (rawName: string) =>
	present(
		(
			await db
				.prepare(
					"SELECT id FROM transactions WHERE raw_name = ? ORDER BY date DESC LIMIT 1",
				)
				.bind(rawName)
				.first<{ id: number }>()
		)?.id,
	);

/** The columns the row helper reads back, as the transactions table stores them. */
type TransactionRow = {
	category_id: number | null;
	category_source: string | null;
	category_confidence: number | null;
	note: string | null;
	excluded: number;
	excluded_source: string | null;
	updated_by: string | null;
};

const row = (id: number) =>
	db
		.prepare(
			"SELECT category_id, category_source, category_confidence, note, excluded, excluded_source, updated_by FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<TransactionRow>();

const edit = (over: Partial<Parameters<typeof saveEdit>[2]> = {}) => ({
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	...over,
});

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("getTransaction", () => {
	it("returns the row with its account and merchant details", async () => {
		const t = await getTransaction(db, await idOf("SQ *LOCAL BAKERY 4432"));
		expect(t).toMatchObject({
			rawName: "SQ *LOCAL BAKERY 4432",
			displayName: "Local Bakery",
			merchantName: "Local Bakery",
			amountCents: 1200,
			accountName: "Credit card",
			accountMask: "9012",
			categoryId: null,
			categorySource: null,
		});
		expect(await getTransaction(db, 999999)).toBeNull();
	});
});

describe("saveEdit", () => {
	it("records and can reverse a person's income choice", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(db, id, edit({ income: true }), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ flag_income: 1, income_source: "user" });
		await saveEdit(db, id, edit(), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ flag_income: 0, income_source: "user" });
	});

	it("preserves a person's non-income refund review when Jev later flags income", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveEdit(db, id, edit({ creditReviewed: true }), "demo");
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed_by: "user",
		});
		await saveJevResult(db, id, {
			categoryId: null,
			suggestedCategoryId: null,
			confidence: 0.4,
			flags: { transfer: false, reimbursement: false, income: true },
		});
		expect(
			await db
				.prepare(
					"SELECT flag_income, income_source, credit_reviewed_by FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed_by: "user",
		});
	});

	it("marks a changed category as a person's choice, and Home follows", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(
			db,
			id,
			edit({ categoryId: EATING_OUT, displayName: "Local Bakery" }),
			"demo",
		);
		expect(await row(id)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "user",
			category_confidence: null,
			updated_by: "demo",
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);

		const summary = summarizeMonth({
			month: "2026-09",
			...(await loadMonth(db, "2026-09")),
			unpaidDueBillsCents: 0,
		});

		// Eating Out's rows dated up to the 22nd are $336, and the Bakery's $12 makes $348 (the demo's paced spending, #322).
		expect(
			summary.categories.find((c) => c.id === EATING_OUT)?.spentCents,
		).toBe(34800);
	});

	it("excludes a transaction, which leaves Needs category and spending (spec §6, #27)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		const before = await loadMonth(db, "2026-09");
		await saveEdit(db, id, edit({ excluded: true }), "demo");
		expect(await row(id)).toMatchObject({ excluded: 1, updated_by: "demo" });
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
		const after = await loadMonth(db, "2026-09");
		expect(after.transactions.length).toBe(before.transactions.length - 1);
	});

	it("includes an excluded transaction again, which then counts", async () => {
		const id = await idOf("ONLINE TRANSFER TO SAV ...5678");
		expect(await row(id)).toMatchObject({ excluded: 1 });
		await saveEdit(db, id, edit({ excluded: false }), "demo");
		expect(await row(id)).toMatchObject({
			excluded: 0,
			excluded_source: "user",
		});
	});

	it("leaves who decided the exclusion alone when a save doesn't change it", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await saveEdit(db, id, edit({ note: "hi" }), "demo");
		expect(await row(id)).toMatchObject({ excluded: 0, excluded_source: null });
	});

	it("updates split children only when their exclusion changes", async () => {
		const parent = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
			)
			.first<{ id: number }>();

		await db
			.prepare(
				"UPDATE transactions SET updated_by = 'earlier' WHERE parent_id = ?",
			)
			.bind(parent?.id)
			.run();

		await saveEdit(db, present(parent?.id), edit(), "unchanged");
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "earlier" }]);

		await saveEdit(
			db,
			present(parent?.id),
			edit({ excluded: true }),
			"changed",
		);
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "changed" }]);
		await saveEdit(
			db,
			present(parent?.id),
			edit({ excluded: true }),
			"unchanged-again",
		);
		expect(
			(
				await db
					.prepare(
						"SELECT DISTINCT updated_by FROM transactions WHERE parent_id = ?",
					)
					.bind(parent?.id)
					.all<{ updated_by: string }>()
			).results,
		).toEqual([{ updated_by: "changed" }]);
	});

	it("excludes the whole split when one part is excluded, and includes it back", async () => {
		const parent = await db
			.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'COSTCO WHSE #0431' AND is_split = 1",
			)
			.first<{ id: number }>();

		const child = await db
			.prepare("SELECT id FROM transactions WHERE parent_id = ? LIMIT 1")
			.bind(parent?.id)
			.first<{ id: number }>();

		const states = async () =>
			(
				await db
					.prepare(
						"SELECT DISTINCT excluded FROM transactions WHERE id = ?1 OR parent_id = ?1",
					)
					.bind(parent?.id)
					.all<{ excluded: number }>()
			).results;

		await saveEdit(db, present(child?.id), edit({ excluded: true }), "part");
		expect(await states()).toEqual([{ excluded: 1 }]);
		await saveEdit(db, present(child?.id), edit({ excluded: false }), "part");
		expect(await states()).toEqual([{ excluded: 0 }]);
	});

	it("leaves the source alone when only the note changes", async () => {
		const id = await idOf("CHIPOTLE 2291");
		await saveEdit(
			db,
			id,
			edit({
				categoryId: EATING_OUT,
				displayName: "Chipotle",
				note: "team lunch",
			}),
			"demo",
		);
		expect(await row(id)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
			note: "team lunch",
		});
	});

	it("applies a merchant rule to the merchant's other rows, except a person's choices", async () => {
		const ids = (
			await db
				.prepare("SELECT id FROM transactions WHERE raw_name = ? ORDER BY id")
				.bind("TRADER JOE'S #552")
				.all<{ id: number }>()
		).results.map((r) => r.id);

		expect(ids.length).toBeGreaterThan(3);
		const edited = itemAt(ids, 0);
		const personal = itemAt(ids, 1);
		const others = ids.slice(2);
		await db
			.prepare("UPDATE transactions SET category_source = 'user' WHERE id = ?")
			.bind(personal)
			.run();

		await saveEdit(
			db,
			edited,
			edit({
				categoryId: GAS,
				alwaysForMerchant: true,
				displayName: "Trader Joe's",
			}),
			"demo",
		);

		const merchant = await db
			.prepare("SELECT default_category_id FROM merchants WHERE raw_name = ?")
			.bind("TRADER JOE'S #552")
			.first<{ default_category_id: number }>();

		expect(merchant?.default_category_id).toBe(GAS);
		expect(await row(edited)).toMatchObject({
			category_id: GAS,
			category_source: "user",
		});
		expect(await row(personal)).toMatchObject({
			category_id: 1,
			category_source: "user",
		});

		for (const id of others) {
			expect(await row(id)).toMatchObject({
				category_id: GAS,
				category_source: "merchant_rule",
			});
		}
	});

	it("renames the merchant everywhere, creating its merchant row if needed", async () => {
		await db
			.prepare(
				"DELETE FROM merchant_suggested_names WHERE merchant_key IN (SELECT raw_name FROM merchants WHERE raw_name = 'PAYPAL *XYZSHOP')",
			)
			.run();
		await db
			.prepare("DELETE FROM merchants WHERE raw_name = 'PAYPAL *XYZSHOP'")
			.run();
		const id = await idOf("PAYPAL *XYZSHOP");
		await saveEdit(db, id, edit({ displayName: "XYZ Shop" }), "demo");

		const { rows } = await listTransactions(
			db,
			parseFilters(new URLSearchParams("q=paypal"), "2026-09"),
		);

		expect(rows.map((r) => r.displayName)).toEqual(["XYZ Shop"]);
	});

	it("saves nothing when any part fails", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await expect(
			saveEdit(
				db,
				id,
				edit({
					categoryId: 999,
					alwaysForMerchant: true,
					note: "should not stick",
				}),
				"demo",
			),
		).rejects.toThrow();
		expect(await row(id)).toMatchObject({ category_id: null, note: null });
	});

	it("keeps a Kind and For a person cleared, when Jev answers later (#304)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");

		const untouched = present(
			(
				await db
					.prepare(
						"SELECT id FROM transactions WHERE id != ? ORDER BY id LIMIT 1",
					)
					.bind(id)
					.first<{ id: number }>()
			)?.id,
		);

		await db.batch([
			db
				.prepare(
					"UPDATE transactions SET kind = 'bill', kind_guessed = 0, for_person_id = 1, for_person_guessed = 0, details_asked = 0 WHERE id = ?",
				)
				.bind(id),
			db
				.prepare(
					"UPDATE transactions SET kind = NULL, kind_guessed = 0, for_person_id = NULL, for_person_guessed = 0, details_asked = 0 WHERE id = ?",
				)
				.bind(untouched),
		]);

		await saveEdit(
			db,
			id,
			edit({ kind: null, forPersonId: null, noteProvided: false }),
			"demo",
		);
		expect(
			await db
				.prepare(
					"SELECT kind_cleared, for_person_cleared FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ kind_cleared: 1, for_person_cleared: 1 });

		await saveJevDetailsStatement(db, [
			{ id, kind: "subscription", forPersonId: 1, noteWorthWriting: null },
			{
				id: untouched,
				kind: "subscription",
				forPersonId: 1,
				noteWorthWriting: null,
			},
		])?.run();

		const details =
			"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?";

		expect(await db.prepare(details).bind(id).first()).toEqual({
			kind: null,
			kind_guessed: 0,
			for_person_id: null,
			for_person_guessed: 0,
		});
		expect(await db.prepare(details).bind(untouched).first()).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a note saved with Details hidden keeps Jev's guessed Kind, which the form posts as Not known (#304)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// With the Details switch off the guess is drawn as Not known, so the form posts Kind empty both ways.
		const posted = new FormData();

		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "",
			for_person_id_was: "",
			for_person_id: "",
			note_was: "",
			note: "Office lunch",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);

		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT note, kind, kind_guessed, kind_cleared FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			note: "Office lunch",
			kind: "subscription",
			kind_guessed: 1,
			kind_cleared: 0,
		});
	});

	it("a Kind picked with Details hidden is the person's, even when it is the hidden guess (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// The guess is drawn as Not known, so picking Subscription posts against an empty kind_was.
		const posted = new FormData();

		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "subscription",
			for_person_id_was: "",
			for_person_id: "",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);

		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 0,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a For picked with Details hidden is the person's, even when it is the hidden guess (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// The guess is drawn as No one, so picking Person 1 posts against an empty for_person_id_was.
		const posted = new FormData();

		for (const [key, value] of Object.entries({
			details_visible: "0",
			kind_was: "",
			kind: "",
			for_person_id_was: "",
			for_person_id: "1",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);

		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 0,
		});
	});

	it("a save with Details shown that leaves a guessed Kind and For alone keeps them guesses (#377)", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'subscription', kind_guessed = 1, for_person_id = 1, for_person_guessed = 1, details_asked = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		// Details shown: the guesses are drawn as they are, so an untouched save re-posts them unchanged.
		const posted = new FormData();

		for (const [key, value] of Object.entries({
			details_visible: "1",
			kind_was: "subscription",
			kind: "subscription",
			for_person_id_was: "1",
			for_person_id: "1",
			note_was: "",
			note: "",
		}))
			posted.set(key, value);
		const parsed = parseEdit(posted, [EATING_OUT, GAS]);

		if (!parsed.ok) throw new Error("expected the form to parse");
		await saveEdit(db, id, parsed.value, "demo");
		expect(
			await db
				.prepare(
					"SELECT kind, kind_guessed, for_person_id, for_person_guessed FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({
			kind: "subscription",
			kind_guessed: 1,
			for_person_id: 1,
			for_person_guessed: 1,
		});
	});

	it("a Kind a person chooses after clearing it is no longer a clear", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET kind = 'bill', kind_guessed = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveEdit(db, id, edit({ kind: null, noteProvided: false }), "demo");
		expect(
			await db
				.prepare("SELECT kind_cleared FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ kind_cleared: 1 });
		await saveEdit(
			db,
			id,
			edit({ kind: "one_off", noteProvided: false }),
			"demo",
		);
		expect(
			await db
				.prepare("SELECT kind, kind_cleared FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ kind: "one_off", kind_cleared: 0 });
	});
});

describe("saveEdit recounts a linked credit when this save makes it count with its purchase", () => {
	const PURCHASE = 9401;
	const REFUND = 9402;
	const INCOME_CREDIT = 9403;

	beforeEach(async () => {
		const bank = await db
			.prepare("SELECT id FROM accounts WHERE type != 'cash' LIMIT 1")
			.first<{ id: number }>();

		if (!bank) throw new Error("bank account missing");
		// A $50 purchase whose whole $50 is already refunded by REFUND, and a $20 credit linked to it
		// that is marked as income, so it doesn't count against the purchase.
		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, is_split, parent_id, refund_of_id, flag_income, credit_reviewed, updated_by) VALUES
				(?, ?, '2026-09-01', 5000, 'CAP SHOP', 1, 'user', 0, NULL, NULL, 0, 0, 'test'),
				(?, ?, '2026-09-03', -5000, 'CAP SHOP', 1, 'user', 0, NULL, ?, 0, 1, 'test'),
				(?, ?, '2026-09-04', -2000, 'CAP SHOP', 1, 'user', 0, NULL, ?, 1, 0, 'test')`,
			)
			.bind(
				PURCHASE,
				bank.id,
				REFUND,
				bank.id,
				PURCHASE,
				INCOME_CREDIT,
				bank.id,
				PURCHASE,
			)
			.run();
	});

	const creditRow = () =>
		db
			.prepare(
				"SELECT note, flag_income, refund_of_id FROM transactions WHERE id = ?",
			)
			.bind(INCOME_CREDIT)
			.first<{
				note: string | null;
				flag_income: number;
				refund_of_id: number | null;
			}>();

	it("saves a note from a panel that showed income off, leaving the income flag and the cap alone", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Note only",
					income: false,
					incomeWas: false,
					creditReviewedProvided: false,
				},
				"test",
			),
		).toEqual({ saved: true });
		expect(await creditRow()).toEqual({
			note: "Note only",
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});

	it("refuses reviewing a linked credit as not income when the purchase has no room left, since the review clears its income", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Reviewed only",
					income: false,
					incomeWas: false,
					creditReviewed: true,
					creditReviewedWas: false,
					creditReviewedProvided: true,
				},
				"test",
			),
		).toEqual({ saved: false, refundLeftCents: 0 });
		expect(await creditRow()).toEqual({
			note: null,
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});

	it("still refuses clearing income on a linked credit when the purchase has no room left", async () => {
		expect(
			await saveEdit(
				db,
				INCOME_CREDIT,
				{
					...edit(),
					note: "Clearing income",
					income: false,
					incomeWas: true,
					creditReviewedProvided: false,
				},
				"test",
			),
		).toEqual({ saved: false, refundLeftCents: 0 });
		expect(await creditRow()).toEqual({
			note: null,
			flag_income: 1,
			refund_of_id: PURCHASE,
		});
	});
});

describe("saveEdit counts a transfer credit as income when a person turns Exclude off on it (#878)", () => {
	const CREDIT = 9510;
	const PURCHASE = 9511;
	const PARENT = 9512;
	const PART = 9513;
	const DEBIT = 9514;
	const NOT_TRANSFER = 9515;
	const PLAID_CREDIT = 9516;
	const PLAID_DEBIT = 9517;
	const PLAID_OTHER = 9518;
	const PLAID_CARD = 9519;
	const MONTH = "2026-09";

	const loadMonthSummary = async (month: string) =>
		summarizeMonth({
			month,
			...(await loadMonth(db, month)),
			unpaidDueBillsCents: 0,
		});

	type Seed = {
		amountCents?: number;
		rawName?: string;
		flagTransfer?: number;
		flagIncome?: number;
		excluded?: number;
		excludedSource?: "user" | "jev" | "plaid" | null;
		isSplit?: number;
		parentId?: number | null;
		refundOfId?: number | null;
		categoryId?: number | null;
		plaidCategory?: string | null;
	};

	/** Inserts one row in the bank account with the given state; everything else is the column default. */
	const seedRow = async (id: number, over: Seed = {}) => {
		const bank = await db
			.prepare("SELECT id FROM accounts WHERE type != 'cash' LIMIT 1")
			.first<{ id: number }>();

		if (!bank) throw new Error("bank account missing");

		const s = {
			amountCents: -5000,
			rawName: "ONLINE TRANSFER FROM SAV",
			flagTransfer: 1,
			flagIncome: 0,
			excluded: 1,
			excludedSource: "jev",
			isSplit: 0,
			parentId: null,
			refundOfId: null,
			categoryId: null,
			plaidCategory: null,
			...over,
		};

		await db
			.prepare(
				`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, category_source, flag_transfer, flag_income, excluded, excluded_source, is_split, parent_id, refund_of_id, plaid_category, updated_by) VALUES
				(?, ?, '2026-09-05', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
			)
			.bind(
				id,
				bank.id,
				s.amountCents,
				s.rawName,
				s.categoryId,
				s.categoryId === null ? null : "user",
				s.flagTransfer,
				s.flagIncome,
				s.excluded,
				s.excludedSource,
				s.isSplit,
				s.parentId,
				s.refundOfId,
				s.plaidCategory,
			)
			.run();
	};

	const creditRow = (id: number) =>
		db
			.prepare(
				"SELECT excluded, excluded_source, flag_income, income_source, credit_reviewed, credit_reviewed_by, refund_of_id FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{
				excluded: number;
				excluded_source: string | null;
				flag_income: number;
				income_source: string | null;
				credit_reviewed: number | null;
				credit_reviewed_by: string | null;
				refund_of_id: number | null;
			}>();

	/** The panel's post for a row whose Exclude chip was turned off and nothing else was touched. */
	const panelPost = (over: Partial<Parameters<typeof saveEdit>[2]> = {}) => ({
		categoryId: null,
		alwaysForMerchant: false,
		displayName: null,
		note: null,
		excluded: false,
		income: false,
		incomeWas: false,
		creditReviewed: false,
		creditReviewedWas: false,
		creditReviewedProvided: true,
		...over,
	});

	const incomeColumns = {
		excluded: 0,
		excluded_source: "user",
		flag_income: 1,
		income_source: "user",
		credit_reviewed: 1,
		credit_reviewed_by: null,
		refund_of_id: null,
	};

	it("a credit Jev excluded counts as income, reviewed by the person, when Exclude is turned off", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });

		expect(await saveEdit(db, CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(CREDIT)).toEqual(incomeColumns);
	});

	it('a credit the person excluded ("yes, it is a transfer") counts as income when Exclude is turned off', async () => {
		await seedRow(CREDIT, { excludedSource: "user" });

		expect(await saveEdit(db, CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(CREDIT)).toEqual(incomeColumns);
	});

	it("guard, passes before the change too: an explicit review as not income in the same save wins", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });

		expect(
			await saveEdit(
				db,
				CREDIT,
				panelPost({ creditReviewed: true, creditReviewedWas: false }),
				"test",
			),
		).toEqual({ saved: true });
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			refund_of_id: null,
		});
	});

	it("guard, passes before the change too: a credit left excluded is unchanged", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });

		await saveEdit(db, CREDIT, panelPost({ excluded: true }), "test");
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 1,
			excluded_source: "jev",
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	it("guard, passes before the change too: a debit marked a transfer is not income when Exclude is turned off", async () => {
		await seedRow(DEBIT, { amountCents: 5000, excludedSource: "jev" });

		await saveEdit(db, DEBIT, panelPost(), "test");
		expect(await creditRow(DEBIT)).toMatchObject({
			excluded: 0,
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
		});
	});

	it("guard, passes before the change too: an excluded credit that is not a transfer is unchanged", async () => {
		await seedRow(NOT_TRANSFER, { flagTransfer: 0, excludedSource: "jev" });

		await saveEdit(db, NOT_TRANSFER, panelPost(), "test");
		expect(await creditRow(NOT_TRANSFER)).toMatchObject({
			excluded: 0,
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
		});
	});

	it("a credit only Plaid marked as a transfer counts as income, reviewed by the person, when Exclude is turned off", async () => {
		await seedRow(PLAID_CREDIT, {
			flagTransfer: 0,
			plaidCategory: "TRANSFER_IN",
			excludedSource: "plaid",
		});

		expect(await saveEdit(db, PLAID_CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(PLAID_CREDIT)).toEqual(incomeColumns);
	});

	it("a credit only Plaid marked as a loan payment, on a card, counts as income when Exclude is turned off", async () => {
		await seedRow(PLAID_CARD, {
			flagTransfer: 0,
			plaidCategory: "LOAN_PAYMENTS",
			excludedSource: "plaid",
		});
		await db
			.prepare(
				"UPDATE transactions SET account_id = (SELECT id FROM accounts WHERE type = 'credit' LIMIT 1) WHERE id = ?",
			)
			.bind(PLAID_CARD)
			.run();

		expect(await saveEdit(db, PLAID_CARD, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(PLAID_CARD)).toEqual(incomeColumns);
	});

	it("guard, passes before the change too: a debit only Plaid marked as a transfer is unchanged when Exclude is turned off", async () => {
		await seedRow(PLAID_DEBIT, {
			amountCents: 5000,
			flagTransfer: 0,
			plaidCategory: "TRANSFER_OUT",
			excludedSource: "plaid",
		});

		await saveEdit(db, PLAID_DEBIT, panelPost(), "test");
		expect(await creditRow(PLAID_DEBIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	it("guard, passes before the change too: a credit excluded some other way, with no transfer category, is unchanged", async () => {
		await seedRow(PLAID_OTHER, {
			flagTransfer: 0,
			plaidCategory: "GENERAL_MERCHANDISE",
			excludedSource: "jev",
		});

		await saveEdit(db, PLAID_OTHER, panelPost(), "test");
		expect(await creditRow(PLAID_OTHER)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	it("guard, passes before the change too: an explicit review as not income wins for a credit only Plaid marked", async () => {
		await seedRow(PLAID_CREDIT, {
			flagTransfer: 0,
			plaidCategory: "TRANSFER_IN",
			excludedSource: "plaid",
		});

		expect(
			await saveEdit(
				db,
				PLAID_CREDIT,
				panelPost({ creditReviewed: true, creditReviewedWas: false }),
				"test",
			),
		).toEqual({ saved: true });
		expect(await creditRow(PLAID_CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			refund_of_id: null,
		});
	});

	it("guard, passes before the change too: a person's earlier income choice stands for a credit only Plaid marked", async () => {
		await seedRow(PLAID_CREDIT, {
			flagTransfer: 0,
			plaidCategory: "TRANSFER_IN",
			excludedSource: "plaid",
		});
		await db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, income_source = 'user' WHERE id = ?",
			)
			.bind(PLAID_CREDIT)
			.run();

		expect(await saveEdit(db, PLAID_CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(PLAID_CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	describe("a stale panel cannot make a credit income (the panel's Exclude was off when drawn)", () => {
		const STALE_PLAID = 9520;
		const STALE_TALLY = 9521;

		const noteOf = (id: number) =>
			db
				.prepare("SELECT note FROM transactions WHERE id = ?")
				.bind(id)
				.first<{ note: string | null }>();

		it("a Plaid-only transfer credit the panel drew included stays not income, and the unrelated note is saved", async () => {
			await seedRow(STALE_PLAID, {
				flagTransfer: 0,
				plaidCategory: "TRANSFER_IN",
				excludedSource: "plaid",
			});

			expect(
				await saveEdit(
					db,
					STALE_PLAID,
					panelPost({ note: "Saved from a stale panel", excludedWas: false }),
					"test",
				),
			).toEqual({ saved: true });
			expect(await creditRow(STALE_PLAID)).toMatchObject({
				flag_income: 0,
				income_source: null,
				credit_reviewed: null,
			});
			expect(await noteOf(STALE_PLAID)).toEqual({
				note: "Saved from a stale panel",
			});
		});

		it("a Tally-marked transfer credit the panel drew included stays not income, and the unrelated note is saved", async () => {
			await seedRow(STALE_TALLY, {
				flagTransfer: 1,
				excludedSource: "plaid",
				plaidCategory: null,
			});

			expect(
				await saveEdit(
					db,
					STALE_TALLY,
					panelPost({ note: "Saved from a stale panel", excludedWas: false }),
					"test",
				),
			).toEqual({ saved: true });
			expect(await creditRow(STALE_TALLY)).toMatchObject({
				flag_income: 0,
				income_source: null,
				credit_reviewed: null,
			});
			expect(await noteOf(STALE_TALLY)).toEqual({
				note: "Saved from a stale panel",
			});
		});

		it.each([
			{
				kind: "Plaid-only",
				id: STALE_PLAID,
				flagTransfer: 0,
				plaidCategory: "TRANSFER_IN",
			},
			{
				kind: "Tally-marked",
				id: STALE_TALLY,
				flagTransfer: 1,
				plaidCategory: null,
			},
		])(
			"a real toggle still counts a $kind transfer credit as income when the panel drew Exclude on",
			async ({ id, flagTransfer, plaidCategory }) => {
				await seedRow(id, {
					flagTransfer,
					plaidCategory,
					excludedSource: "plaid",
				});

				expect(
					await saveEdit(db, id, panelPost({ excludedWas: true }), "test"),
				).toEqual({ saved: true });
				expect(await creditRow(id)).toEqual(incomeColumns);
			},
		);
	});

	it("the month's buckets move the Plaid-only credit from excluded to counted, and it is not held for review", async () => {
		await seedRow(PLAID_CREDIT, {
			flagTransfer: 0,
			plaidCategory: "TRANSFER_IN",
			excludedSource: "plaid",
		});
		const before = await monthCounts(db, MONTH);
		const beforeExcluded = await excludedBreakdown(db, MONTH);

		await saveEdit(db, PLAID_CREDIT, panelPost(), "test");

		const after = await monthCounts(db, MONTH);
		const afterExcluded = await excludedBreakdown(db, MONTH);
		expect(after.counted - before.counted).toBe(1);
		expect(after.heldForReview).toBe(before.heldForReview);
		expect(beforeExcluded.transfer - afterExcluded.transfer).toBe(1);
	});

	it("guard, passes before the change too: a split part and a split parent are left as they were", async () => {
		await seedRow(PARENT, { isSplit: 1, excludedSource: "jev" });
		await seedRow(PART, { parentId: PARENT, excludedSource: "jev" });

		await saveEdit(db, PART, panelPost(), "test");
		expect(await creditRow(PART)).toMatchObject({
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
		});

		await saveEdit(db, PARENT, panelPost(), "test");
		expect(await creditRow(PARENT)).toMatchObject({
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
		});
	});

	it("guard, passes before the change too: a credit linked as a refund in the same save is a refund, not income", async () => {
		await seedRow(PURCHASE, {
			amountCents: 5000,
			flagTransfer: 0,
			excluded: 0,
			excludedSource: null,
			categoryId: 1,
		});
		await seedRow(CREDIT, { amountCents: -2000, excludedSource: "jev" });

		expect(
			await saveEdit(db, CREDIT, panelPost({ refundOfId: PURCHASE }), "test"),
		).toEqual({ saved: true });
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			refund_of_id: PURCHASE,
		});
	});

	it("a credit already linked as a refund stays a refund when Exclude is turned off and the link is kept", async () => {
		await seedRow(PURCHASE, {
			amountCents: 5000,
			flagTransfer: 0,
			excluded: 0,
			excludedSource: null,
			categoryId: 1,
		});
		await seedRow(CREDIT, {
			amountCents: -2000,
			excludedSource: "jev",
			refundOfId: PURCHASE,
		});

		expect(await saveEdit(db, CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: null,
			credit_reviewed: null,
			credit_reviewed_by: null,
			refund_of_id: PURCHASE,
		});
	});

	it("a credit the person already reviewed as not income stays not income when Exclude is turned off", async () => {
		await seedRow(CREDIT, { excludedSource: "user" });
		await db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = ?",
			)
			.bind(CREDIT)
			.run();

		expect(
			await saveEdit(
				db,
				CREDIT,
				panelPost({ creditReviewed: true, creditReviewedWas: true }),
				"test",
			),
		).toEqual({ saved: true });
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			refund_of_id: null,
		});
	});

	it("a credit whose income the person unticked stays not income when Exclude is turned off", async () => {
		await seedRow(CREDIT, { excludedSource: "user" });
		await db
			.prepare(
				"UPDATE transactions SET credit_reviewed = 1, income_source = 'user' WHERE id = ?",
			)
			.bind(CREDIT)
			.run();

		expect(await saveEdit(db, CREDIT, panelPost(), "test")).toEqual({
			saved: true,
		});
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	it("a person's income choice stands through include, untick, exclude and include again (no seeding)", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });

		await saveEdit(db, CREDIT, panelPost(), "test");
		await saveEdit(
			db,
			CREDIT,
			panelPost({ income: false, incomeWas: true }),
			"test",
		);
		await saveEdit(
			db,
			CREDIT,
			panelPost({ income: false, incomeWas: false, excluded: true }),
			"test",
		);
		await saveEdit(
			db,
			CREDIT,
			panelPost({ income: false, incomeWas: false, excluded: false }),
			"test",
		);
		expect(await creditRow(CREDIT)).toEqual({
			excluded: 0,
			excluded_source: "user",
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: null,
			refund_of_id: null,
		});
	});

	it("include, exclude, include again: the income columns stay, and only Exclude moves", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });

		await saveEdit(db, CREDIT, panelPost(), "test");
		expect(await creditRow(CREDIT)).toEqual(incomeColumns);

		// Turning Exclude back on leaves the income and the review the first save wrote: saveEdit has no revert path.
		const income = {
			income: true,
			incomeWas: true,
			creditReviewedProvided: false,
		};

		await saveEdit(
			db,
			CREDIT,
			{ ...panelPost(income), excluded: true },
			"test",
		);
		expect(await creditRow(CREDIT)).toEqual({ ...incomeColumns, excluded: 1 });

		await saveEdit(
			db,
			CREDIT,
			{ ...panelPost(income), excluded: false },
			"test",
		);
		expect(await creditRow(CREDIT)).toEqual(incomeColumns);
	});

	it("after the first save, the month counts the credit as income, not spending (guard: heldForReview never held it)", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });
		const spentBefore = (await loadMonthSummary(MONTH)).totalSpentCents;
		const incomeBefore = (await loadMonthSummary(MONTH)).incomeCents;
		const heldBefore = (await monthCounts(db, MONTH)).heldForReview;

		await saveEdit(db, CREDIT, panelPost(), "test");

		const after = await loadMonthSummary(MONTH);
		expect(after.incomeCents - incomeBefore).toBe(5000);
		expect(after.totalSpentCents).toBe(spentBefore);
		expect((await monthCounts(db, MONTH)).heldForReview).toBe(heldBefore);
	});

	it("classify() names the credit income, set by the person, counted and not excluded", async () => {
		await seedRow(CREDIT, { excludedSource: "jev" });
		await saveEdit(db, CREDIT, panelPost(), "test");

		const r = await db
			.prepare("SELECT * FROM transactions WHERE id = ?")
			.bind(CREDIT)
			.first<Row>();

		if (!r) throw new Error("credit missing");

		const c = classify(r, {
			paysBillOrPlan: false,
			refundTarget: null,
			jevCategoryActive: false,
			anyActiveCategory: true,
			neverSuggestIncome: false,
		});

		expect(c.income).toEqual({ kind: "income", setBy: "user" });
		expect(c.budget).toEqual({ kind: "counted", because: "not_excluded" });
	});
});
