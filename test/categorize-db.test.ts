import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
			`SELECT category_id, category_source, category_confidence, jev_category_id,
				flag_transfer, flag_reimbursement, flag_income, excluded, updated_by
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
});

describe("pendingForJev", () => {
	it("returns the transactions that need a category, with what Jev is told", async () => {
		const pending = await pendingForJev(db, 40);
		expect(pending).toHaveLength(12);
		expect(pending).toContainEqual({
			id: await idOf("SQ *LOCAL BAKERY 4432"),
			rawName: "SQ *LOCAL BAKERY 4432",
			displayName: "Local Bakery",
			amountCents: 1200,
			accountType: "credit",
			plaidCategory: null,
		});
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
		expect(pending).toHaveLength(11);
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(11);
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(11);
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(12);
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(11);
	});

	it("stores Jev's confident income answer so it is excluded from spending", async () => {
		const id = await idOf("VENMO *J RIVERA");
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(11);
	});

	it("accepts Jev's confident income classification for a negative payroll credit", async () => {
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
			}),
		);
		expect(await row(id)).toMatchObject({ flag_income: 1 });
		expect(
			await db
				.prepare("SELECT income_source FROM transactions WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ income_source: "jev" });
	});

	it("preserves a legacy income choice without a recorded source", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await db
			.prepare("UPDATE transactions SET flag_income = 1, income_source = NULL WHERE id = ?")
			.bind(id)
			.run();
		await db
			.prepare("UPDATE transactions SET category_confidence = NULL WHERE id = ?")
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
		expect(await row(id)).toMatchObject({ flag_transfer: 1, excluded: 0 });
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
		const id = await idOf("GOOGLE *YOUTUBE");
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
		expect(await needsCategoryCount(db, "2026-09")).toBe(12);
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
