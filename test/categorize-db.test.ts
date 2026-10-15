import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { JEV_THRESHOLD } from "../src/ai/categorize";
import { decide } from "../src/ai/decide";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	applyMerchantRules,
	needsCategoryCount,
	pendingForJev,
	saveEdit,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const TODAY = "2026-09-22";
const GROCERIES = 1;
const EATING_OUT = 2;
const GAS = 3;

const idOf = async (rawName: string) =>
	(
		await db
			.prepare("SELECT id FROM transactions WHERE raw_name = ? LIMIT 1")
			.bind(rawName)
			.first<{ id: number }>()
	)?.id as number;

const row = (id: number) =>
	db
		.prepare(
			`SELECT amount_cents, credit_reviewed, category_id, category_source, category_confidence, jev_category_id,
				flag_transfer, flag_reimbursement, flag_income, income_confidence, transfer_confidence, excluded, excluded_source, updated_by
			FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<Record<string, unknown>>();

const personEdit = {
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	creditReviewedProvided: true,
};

const decision = (over = {}) => ({
	categoryId: EATING_OUT,
	suggestedCategoryId: EATING_OUT,
	confidence: 0.91,
	flags: { transfer: false, reimbursement: false, income: false },
	...over,
});

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
});

describe("pendingForJev", () => {
	it("returns the transactions that need a category, with what Jev is told", async () => {
		const pending = await pendingForJev(db, 40);
		expect(pending).toHaveLength(10);
		expect(pending).toContainEqual(
			expect.objectContaining({
				id: await idOf("SQ *LOCAL BAKERY 4432"),
				rawName: "SQ *LOCAL BAKERY 4432",
				displayName: "Local Bakery",
				amountCents: 1200,
				accountType: "credit",
				plaidCategory: null,
				categoryOnly: false,
			}),
		);
	});

	it("respects the limit", async () => {
		expect(await pendingForJev(db, 5)).toHaveLength(5);
	});

	it("skips a transaction Jev already looked at (decision 27)", async () => {
		const id = await idOf("PAYPAL *XYZSHOP");
		await saveJevResult(
			db,
			id,
			decision({ categoryId: null, confidence: 0.4 }),
		);
		const pending = await pendingForJev(db, 40);
		expect(pending).toHaveLength(9);
		expect(pending.map((p) => p.id)).not.toContain(id);
	});

	it("queues an unreviewed credit for Jev without counting it as an uncategorized purchase", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		expect(await pendingForJev(db, 40)).toContainEqual(
			expect.objectContaining({ id, amountCents: -1200 }),
		);
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
	});

	describe("with categories and exclusions off (spec §8.6)", () => {
		const reviewedCredit = async () => {
			const id = await idOf("SQ *LOCAL BAKERY 4432");
			await db
				.prepare(
					"UPDATE transactions SET amount_cents = -1200, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
				)
				.bind(id)
				.run();
			return id;
		};

		it("still asks about a credit a person reviewed when categories are on, for its category", async () => {
			const id = await reviewedCredit();
			expect(await pendingForJev(db, 40)).toContainEqual(
				expect.objectContaining({ id, categoryOnly: true }),
			);
			expect(await pendingForJev(db, 40, { categories: true })).toContainEqual(
				expect.objectContaining({ id, categoryOnly: true }),
			);
		});

		it("leaves it out, since only its category could be asked and that answer is unused", async () => {
			const id = await reviewedCredit();
			const pending = await pendingForJev(db, 40, { categories: false });
			expect(pending.map((p) => p.id)).not.toContain(id);
			// Everything else is still asked about, for the income answer.
			expect(pending).toHaveLength(9);
		});

		// A review that was never recorded is NULL, not 0: it means "not reviewed by a person", so the
		// credit is still asked about for income, however its review columns read.
		it.each([
			{
				shape: "credit_reviewed never set",
				set: "credit_reviewed = NULL, credit_reviewed_by = NULL, income_source = NULL",
			},
			{
				shape: "credit_reviewed 0",
				set: "credit_reviewed = 0, credit_reviewed_by = NULL, income_source = NULL",
			},
			{
				shape: "reviewed, but not by a person",
				set: "credit_reviewed = 1, credit_reviewed_by = NULL, income_source = NULL",
			},
			{
				shape: "reviewed, and its income set by Jev",
				set: "credit_reviewed = 1, credit_reviewed_by = NULL, income_source = 'jev'",
			},
		])(
			"still asks about an older credit with $shape, for its income answer",
			async ({ set }) => {
				const id = await idOf("SQ *LOCAL BAKERY 4432");
				await db
					.prepare(
						`UPDATE transactions SET amount_cents = -1200, ${set} WHERE id = ?`,
					)
					.bind(id)
					.run();
				const withoutCategories = await pendingForJev(db, 40, {
					categories: false,
				});
				expect(withoutCategories).toContainEqual(
					expect.objectContaining({
						id,
						amountCents: -1200,
						categoryOnly: false,
					}),
				);
				expect(withoutCategories).toHaveLength(10);
				// The same rows are listed with categories on.
				expect(await pendingForJev(db, 40)).toHaveLength(10);
			},
		);

		it("doesn't let those rows use up the limit", async () => {
			await reviewedCredit();
			expect(await pendingForJev(db, 11, { categories: false })).toHaveLength(
				9,
			);
		});
	});
});

describe("a split purchase's category from before its split", () => {
	// A purchase at the merchant "SPLIT STORE"; `splitRemoved` is the note's cents, `isSplit` marks a split parent.
	const insertRow = async (over: {
		categoryId?: number | null;
		source?: string | null;
		splitRemoved?: number | null;
		isSplit?: number;
	}) =>
		(
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, split_removed_from_cents, is_split) SELECT id, '2026-09-20', 4200, 'SPLIT STORE', ?, ?, ?, ? FROM accounts ORDER BY id LIMIT 1",
				)
				.bind(
					over.categoryId ?? null,
					over.source ?? null,
					over.splitRemoved ?? null,
					over.isSplit ?? 0,
				)
				.run()
		).meta.last_row_id as number;

	beforeEach(async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('SPLIT STORE', ?) ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id",
			)
			.bind(GROCERIES)
			.run();
	});

	it("is not replaced by a merchant rule, and a split parent is never categorized by one", async () => {
		const bill = await insertRow({
			categoryId: EATING_OUT,
			source: "bill",
			splitRemoved: 4200,
		});
		const plain = await insertRow({ splitRemoved: 4200 });
		const parent = await insertRow({ isSplit: 1 });
		await applyMerchantRules(db);
		expect(await row(bill)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "bill",
		});
		// No earlier category: the note's purchase is sorted by its merchant's rule, as before.
		expect(await row(plain)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
		});
		expect(await row(parent)).toMatchObject({
			category_id: null,
			category_source: null,
		});
	});

	it("is not replaced by Jev's new guess", async () => {
		const restored = await insertRow({
			categoryId: EATING_OUT,
			source: "jev",
			splitRemoved: 4200,
		});
		expect(
			await saveJevResult(db, restored, decision({ categoryId: GROCERIES })),
		).toBe(false);
		expect(await row(restored)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
		});
	});

	it("is not replaced when a person saves an Always rule for its merchant", async () => {
		const restored = await insertRow({
			categoryId: EATING_OUT,
			source: "jev",
			splitRemoved: 4200,
		});
		const parent = await insertRow({
			categoryId: EATING_OUT,
			source: "jev",
			isSplit: 1,
		});
		const edited = await insertRow({});
		const uncategorized = await insertRow({});
		await saveEdit(
			db,
			edited,
			{ ...personEdit, categoryId: GROCERIES, alwaysForMerchant: true },
			"demo",
		);
		expect(await row(restored)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
		});
		expect(await row(parent)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
		});
		// The rule itself still reaches the other uncategorized purchase of the merchant.
		expect(await row(uncategorized)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
		});
		expect(await row(edited)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
	});

	const splitRemoved = async (id: number) =>
		(
			await db
				.prepare(
					"SELECT split_removed_from_cents AS cents FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first<{ cents: number | null }>()
		)?.cents;

	it("a person's pick sets the category, clears the note, and takes the person's source", async () => {
		const restored = await insertRow({
			categoryId: EATING_OUT,
			source: "jev",
			splitRemoved: 4200,
		});
		await saveEdit(
			db,
			restored,
			{ ...personEdit, categoryId: GROCERIES },
			"demo",
		);
		expect(await row(restored)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
		});
		expect(await splitRemoved(restored)).toBeNull();
	});

	it("confirming the restored category keeps Jev's source and clears the note", async () => {
		const restored = await insertRow({
			categoryId: EATING_OUT,
			source: "jev",
			splitRemoved: 4200,
		});
		await saveEdit(
			db,
			restored,
			{ ...personEdit, categoryId: EATING_OUT },
			"demo",
		);
		expect(await row(restored)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
		});
		expect(await splitRemoved(restored)).toBeNull();
	});

	it("an Always rule fills a purchase that has no category, and its note stays until a person decides", async () => {
		const noted = await insertRow({ splitRemoved: 4200 });
		await saveEdit(
			db,
			await insertRow({}),
			{ ...personEdit, categoryId: GROCERIES, alwaysForMerchant: true },
			"demo",
		);
		expect(await row(noted)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
		});
		expect(await splitRemoved(noted)).toBe(4200);
	});
});

describe("applyMerchantRules", () => {
	it("keeps merchant-rule credits queued for Jev's separate income classification", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db.batch([
			db
				.prepare(
					"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0 WHERE id = ?",
				)
				.bind(id),
			db
				.prepare(
					"UPDATE merchants SET default_category_id = ? WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
				)
				.bind(GROCERIES),
		]);
		await applyMerchantRules(db);
		expect(await pendingForJev(db, 40)).toContainEqual(
			expect.objectContaining({ id, amountCents: -1200 }),
		);
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: EATING_OUT,
				suggestedCategoryId: EATING_OUT,
				flags: { transfer: false, reimbursement: false, income: true },
			}),
		);
		expect(await row(id)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
			flag_income: 1,
		});
	});

	it("classifies a pending credit even if Organize previously assigned a category", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(GROCERIES, id)
			.run();
		expect(await pendingForJev(db, 40)).toContainEqual(
			expect.objectContaining({ id, amountCents: -1200 }),
		);
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: EATING_OUT,
				suggestedCategoryId: EATING_OUT,
				flags: { transfer: false, reimbursement: false, income: true },
			}),
		);
		expect(await row(id)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
			flag_income: 1,
		});
	});

	it("counts a credit after Jev confidently assigns a non-income category", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: GROCERIES,
				suggestedCategoryId: GROCERIES,
				confidence: 0.95,
				flags: { transfer: false, reimbursement: false, income: false },
			}),
		);
		expect(await row(id)).toMatchObject({
			amount_cents: -1200,
			category_id: GROCERIES,
			category_source: "jev",
			credit_reviewed: 1,
			flag_income: 0,
		});
	});

	it("categorizes uncategorized transactions from a merchant with a default category", async () => {
		const id = await idOf("SQ *FARMERS MKT");
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = ? WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.bind(GROCERIES)
			.run();

		await applyMerchantRules(db);

		expect(await row(id)).toMatchObject({
			category_id: GROCERIES,
			category_source: "merchant_rule",
			category_confidence: null,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
	});

	it("never changes a person's choice or an already categorized transaction", async () => {
		const bakery = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare("UPDATE transactions SET category_source = 'user' WHERE id = ?")
			.bind(bakery)
			.run();
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = ? WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
			)
			.bind(GROCERIES)
			.run();

		await applyMerchantRules(db);

		expect(await row(bakery)).toMatchObject({
			category_id: null,
			category_source: "user",
		});
	});

	it("skips a rule while its category is archived, so the transaction still needs a category", async () => {
		const id = await idOf("SQ *FARMERS MKT");
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = ? WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.bind(EATING_OUT)
			.run();
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(EATING_OUT)
			.run();

		await applyMerchantRules(db);

		expect(await row(id)).toMatchObject({
			category_id: null,
			category_source: null,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(10);
	});
});

describe("saveJevResult", () => {
	it("applies a confident category with its confidence and flags", async () => {
		const id = await idOf("TST* CORNER DELI");
		// Jev isn't a person, so who last edited the row stays as it was.
		const before = (await row(id))?.updated_by;
		await saveJevResult(
			db,
			id,
			decision({
				flags: { transfer: false, reimbursement: true, income: false },
			}),
		);
		expect(await row(id)).toMatchObject({
			category_id: EATING_OUT,
			category_source: "jev",
			category_confidence: 0.91,
			jev_category_id: EATING_OUT,
			flag_transfer: 0,
			flag_reimbursement: 1,
			flag_income: 0,
			// A reimbursement starts excluded (spec §6); a person can include it again (#27).
			excluded: 1,
			updated_by: before,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
	});

	it("stores Jev's confident income answer so it is excluded from spending", async () => {
		const id = await idOf("VENMO *J RIVERA");
		// Income is money coming in, so this is a credit (Jev's income answer never marks money out).
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -amount_cents WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: true, reimbursement: false, income: true },
			}),
		);
		// The transfer flag excludes it (spec §6), while the income flag is retained.
		expect(await row(id)).toMatchObject({
			flag_transfer: 1,
			flag_income: 1,
			excluded: 1,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(9);
	});

	it("accepts Jev's confident income classification for a negative payroll credit", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: false, reimbursement: false, income: true },
				flagConfidence: { income: 0.85 },
			}),
		);
		expect(await row(id)).toMatchObject({
			flag_income: 1,
			income_confidence: null,
		});
		expect(
			await db
				.prepare("SELECT income_source FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ income_source: "jev" });
	});

	it("keeps a below-threshold income guess without counting the credit as income", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: EATING_OUT,
				confidence: 0.91,
				flags: { transfer: false, reimbursement: false, income: false },
				flagConfidence: { income: 0.71, transfer: 0.23 },
			}),
		);
		expect(await row(id)).toMatchObject({
			flag_income: 0,
			income_confidence: 0.71,
			transfer_confidence: 0.23,
			credit_reviewed: 0,
		});
	});

	it("does not keep the income suggestion when Spot paychecks is off", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare("UPDATE transactions SET amount_cents = -1200 WHERE id = ?")
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: false, reimbursement: false, income: true },
				flagConfidence: { income: 0.95 },
			}),
			{ switches: { income: false } },
		);
		expect(await row(id)).toMatchObject({
			flag_income: 0,
			income_confidence: null,
		});
	});

	it("keeps Plaid's income mark when Jev disagrees", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, flag_income = 1, plaid_category = 'INCOME' WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: false, reimbursement: false, income: false },
				flagConfidence: { income: 0.12 },
			}),
		);
		expect(await row(id)).toMatchObject({
			flag_income: 1,
			income_confidence: null,
		});
	});

	it("preserves a legacy income choice without a recorded source", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await db
			.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: false, reimbursement: false, income: false },
			}),
		);
		expect(await row(id)).toMatchObject({ flag_income: 1 });
		expect(
			await db
				.prepare("SELECT income_source FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ income_source: "user" });
	});

	it("keeps the income flag and Jev source consistent when an answer is explicitly cleared", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await db
			.prepare(
				"UPDATE transactions SET amount_cents = -amount_cents WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: false, reimbursement: false, income: true },
			}),
		);
		expect(await row(id)).toMatchObject({ flag_income: 1 });
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = NULL WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.4,
				flags: { transfer: false, reimbursement: false, income: false },
			}),
		);
		expect(await row(id)).toMatchObject({ flag_income: 0 });
		expect(
			await db
				.prepare("SELECT income_source FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ income_source: null });
	});

	it("leaves a transaction counted when Jev flags neither transfer nor reimbursement", async () => {
		const id = await idOf("TST* CORNER DELI");
		await saveJevResult(db, id, decision());
		expect(await row(id)).toMatchObject({ excluded: 0 });
	});

	it("never overrides a person who included a transaction again (#27)", async () => {
		const id = await idOf("VENMO *J RIVERA");
		// A person excluded it, then included it again from the edit panel.
		await saveEdit(db, id, { ...personEdit, excluded: true }, "demo");
		await saveEdit(db, id, { ...personEdit, excluded: false }, "demo");
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				confidence: 0.5,
				flags: { transfer: true, reimbursement: false, income: false },
			}),
		);
		expect(await row(id)).toMatchObject({
			flag_transfer: 0,
			excluded: 0,
			excluded_source: "user",
		});
	});

	it("records that Jev said none fit: a confidence with no pick", async () => {
		const id = await idOf("POS 4417 CITY PARKING");
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				suggestedCategoryId: null,
				confidence: 0.9,
			}),
		);
		expect(await row(id)).toMatchObject({
			category_id: null,
			category_confidence: 0.9,
			jev_category_id: null,
		});
		expect((await pendingForJev(db, 40)).map((p) => p.id)).not.toContain(id);
	});

	it("reports whether it wrote anything", async () => {
		const id = await idOf("SQ *LOCAL BAKERY 4432");
		expect(await saveJevResult(db, id, decision())).toBe(true);
		expect(await saveJevResult(db, id, decision())).toBe(false);
	});

	it("keeps Jev's pick and confidence when Jev wasn't sure, without applying it", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await saveJevResult(
			db,
			id,
			decision({
				categoryId: null,
				suggestedCategoryId: GROCERIES,
				confidence: 0.55,
			}),
		);
		expect(await row(id)).toMatchObject({
			category_id: null,
			category_source: null,
			category_confidence: 0.55,
			jev_category_id: GROCERIES,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(10);
	});

	it("does nothing if a person chose a category in the meantime", async () => {
		const id = await idOf("APPLE.COM/BILL");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(GROCERIES, id)
			.run();

		await saveJevResult(db, id, decision());

		expect(await row(id)).toMatchObject({
			category_id: GROCERIES,
			category_source: "user",
			category_confidence: null,
		});
	});
});

describe("a credit whose category Jev answered unsure, asked for its income (decision 79)", () => {
	// A credit with a stored category confidence and no income answer yet, as Jev leaves it with income off.
	const setUnsureCategory = async (id: number) =>
		db
			.prepare(
				"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL, category_confidence = 0.4, income_confidence = NULL WHERE id = ?",
			)
			.bind(id)
			.run();

	it("with income on, stores the income answer, and the row leaves the queue", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await setUnsureCategory(id);
		expect(
			await saveJevResult(
				db,
				id,
				decision({
					categoryId: null,
					confidence: 0.5,
					flagConfidence: { transfer: 0, reimbursement: 0, income: 0.3 },
				}),
				{ switches: { income: true, categories: true } },
			),
		).toBe(true);
		expect(await row(id)).toMatchObject({ income_confidence: 0.3 });
		expect((await pendingForJev(db, 40)).map((p) => p.id)).not.toContain(id);
	});

	it("with income off, rejects the answer and changes nothing", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await setUnsureCategory(id);
		const before = await row(id);
		expect(
			await saveJevResult(
				db,
				id,
				decision({
					categoryId: null,
					confidence: 0.5,
					flagConfidence: { transfer: 0, reimbursement: 0, income: 0.3 },
				}),
				{ switches: { income: false, categories: true } },
			),
		).toBe(false);
		expect(await row(id)).toEqual(before);
	});

	// Every category column is set, so a save that writes any of them shows. Jev's answer was unsure, so the
	// category is unset and its suggestion (Groceries), mixed reading (0.3) and also-category (Gas) are kept.
	const setCategoryAnswer = async (id: number) =>
		db
			.prepare(
				`UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL,
					category_id = NULL, category_source = NULL, category_confidence = 0.4,
					jev_category_id = ?, jev_none_fit = 0, jev_mixed = 0.3, jev_also_category_id = ?,
					transfer_confidence = 0.4, flag_transfer = 0, flag_reimbursement = 0, excluded = 0,
					excluded_source = NULL, income_confidence = NULL
				WHERE id = ?`,
			)
			.bind(GROCERIES, GAS, id)
			.run();
	// The twelve columns a catch-up save keeps as they are: Jev's category answer, its transfer answer and exclusion.
	const categoryAnswer = (id: number) =>
		db
			.prepare(
				`SELECT category_id, category_source, category_confidence, jev_category_id, jev_none_fit, jev_mixed,
					jev_also_category_id, transfer_confidence, flag_transfer, flag_reimbursement, excluded, excluded_source
				FROM transactions WHERE id = ?`,
			)
			.bind(id)
			.first<Record<string, unknown>>();
	const incomeSourceOf = (id: number) =>
		db
			.prepare("SELECT income_source FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ income_source: string | null }>();
	const ALL_CATEGORIES = [
		{ id: GROCERIES, name: "Groceries" },
		{ id: EATING_OUT, name: "Eating Out" },
		{ id: GAS, name: "Gas" },
	];

	it("with categories on, keeps Jev's category answer and stores only its income answer", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await setCategoryAnswer(id);
		const before = await categoryAnswer(id);
		expect(
			await saveJevResult(
				db,
				id,
				decision({
					categoryId: EATING_OUT,
					suggestedCategoryId: EATING_OUT,
					confidence: 0.95,
					mixedProbability: 0.9,
					alsoCategoryId: null,
					flags: { transfer: true, reimbursement: false, income: false },
					flagConfidence: { transfer: 0.95, reimbursement: 0, income: 0.3 },
				}),
				{ switches: { income: true, categories: true } },
			),
		).toBe(true);
		expect(await categoryAnswer(id)).toEqual(before);
		expect(await row(id)).toMatchObject({
			credit_reviewed: 0,
			income_confidence: 0.3,
		});
		expect((await pendingForJev(db, 40)).map((p) => p.id)).not.toContain(id);
	});

	it("with categories off, keeps the suggestion, mixed reading and transfer answer, and stores only its income answer", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await setCategoryAnswer(id);
		const before = await categoryAnswer(id);
		expect(
			await saveJevResult(
				db,
				id,
				decide(
					{
						category: { label: "Eating Out", confidence: 0.95 },
						flags: { transfer: 0.95, reimbursement: 0, income: 0.3 },
						mixed: { probability: 0.9, also: "Gas" },
					},
					ALL_CATEGORIES,
					JEV_THRESHOLD,
					{ categories: false },
				),
				{ switches: { income: true, categories: false } },
			),
		).toBe(true);
		expect(await categoryAnswer(id)).toEqual(before);
		expect(await row(id)).toMatchObject({
			credit_reviewed: 0,
			income_confidence: 0.3,
		});
		expect((await pendingForJev(db, 40)).map((p) => p.id)).not.toContain(id);
	});

	it.each([true, false])(
		"with categories %s, a sure yes for its income flags it and keeps Jev's category answer",
		async (categories) => {
			const id = await idOf("VENMO *J RIVERA");
			await setCategoryAnswer(id);
			const before = await categoryAnswer(id);
			expect(
				await saveJevResult(
					db,
					id,
					decide(
						{
							category: { label: "Eating Out", confidence: 0.95 },
							flags: { transfer: 0, reimbursement: 0, income: 0.95 },
							mixed: { probability: 0.9, also: "Gas" },
						},
						ALL_CATEGORIES,
						JEV_THRESHOLD,
						{ categories },
					),
					{ switches: { income: true, categories } },
				),
			).toBe(true);
			expect(await categoryAnswer(id)).toEqual(before);
			expect(await row(id)).toMatchObject({
				flag_income: 1,
				credit_reviewed: 1,
			});
			expect(await incomeSourceOf(id)).toEqual({ income_source: "jev" });
		},
	);
});

describe("the Maybe edges Jev's answer is saved at (spec §8.6)", () => {
	// Sure is 0.8 and up for a yes and 0.2 and down for a no; 0.7999 and 0.2001 are the first unsure values.
	// A guess is kept as a Maybe only below 0.8, and a credit counts once its category is sure (0.8 or more)
	// or its income guess is a sure no (0.2 or less).
	it.each([
		[0.7999, 0.7999],
		[0.8, null],
	])(
		"stores an income and a transfer guess of %s as %s",
		async (guess, kept) => {
			const id = await idOf("SQ *LOCAL BAKERY 4432");
			await db
				.prepare("UPDATE transactions SET amount_cents = -1200 WHERE id = ?")
				.bind(id)
				.run();

			await saveJevResult(
				db,
				id,
				decision({
					flagConfidence: { transfer: guess, reimbursement: 0, income: guess },
				}),
			);

			expect(await row(id)).toMatchObject({
				income_confidence: kept,
				transfer_confidence: kept,
			});
		},
	);

	it.each([
		[0.8, null, true],
		[0.7999, null, false],
		[0.95, 0.2, true],
		[0.95, 0.2001, false],
	])(
		"with a category of %s and an income guess of %s, counted: %s",
		async (category, income, counted) => {
			const id = await idOf("SQ *LOCAL BAKERY 4432");
			await db
				.prepare(
					"UPDATE transactions SET amount_cents = -1200, credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
				)
				.bind(id)
				.run();

			await saveJevResult(
				db,
				id,
				decision({
					categoryId: GROCERIES,
					suggestedCategoryId: GROCERIES,
					confidence: category,
					flagConfidence:
						income === null
							? undefined
							: { transfer: 0, reimbursement: 0, income },
				}),
			);

			expect(await row(id)).toMatchObject({
				credit_reviewed: counted ? 1 : 0,
				flag_income: 0,
			});
		},
	);
});
