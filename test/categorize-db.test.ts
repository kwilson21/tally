import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMerchantRules,
	needsCategoryCount,
	pendingForJev,
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
			`SELECT category_id, category_source, category_confidence,
				flag_transfer, flag_reimbursement, flag_income, updated_by
			FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<Record<string, unknown>>();

const decision = (over = {}) => ({
	categoryId: EATING_OUT,
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
});

describe("applyMerchantRules", () => {
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
			flag_transfer: 0,
			flag_reimbursement: 1,
			flag_income: 0,
			updated_by: before,
		});
		expect(await needsCategoryCount(db, "2026-09")).toBe(11);
	});

	it("stores only the confidence when Jev wasn't sure", async () => {
		const id = await idOf("VENMO *J RIVERA");
		await saveJevResult(
			db,
			id,
			decision({ categoryId: null, confidence: 0.55 }),
		);
		expect(await row(id)).toMatchObject({
			category_id: null,
			category_source: null,
			category_confidence: 0.55,
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
