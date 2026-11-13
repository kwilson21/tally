import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEdit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { present } from "./helpers/present";

const db = env.DB;
const TODAY = "2026-09-05";
const LOCK = "credit-merge-lock";
const CREDIT_CENTS = -5000;

let item = 0;
let bank = 0;

beforeEach(async () => {
	await resetDemo(db, TODAY);

	item = present(
		(
			await db
				.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
				.first<{ id: number }>()
		)?.id,
	);
	await db
		.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
		.bind(LOCK, item)
		.run();

	bank = present(
		(
			await db
				.prepare("SELECT id FROM accounts WHERE type != 'cash' LIMIT 1")
				.first<{ id: number }>()
		)?.id,
	);
});

/** A transfer credit's row, pending or posted, with the state it is given; the rest is the column default. */
async function insertCredit(
	plaidId: string,
	pending: 0 | 1,
	over: {
		excluded?: number;
		excludedSource?: string | null;
		flagIncome?: number;
		incomeSource?: string | null;
		creditReviewed?: number;
		creditReviewedBy?: string | null;
	} = {},
): Promise<number> {
	const s = {
		excluded: 1,
		excludedSource: "jev",
		flagIncome: 0,
		incomeSource: null,
		creditReviewed: 0,
		creditReviewedBy: null,
		...over,
	};

	const result = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by,
				flag_transfer, excluded, excluded_source, flag_income, income_source, credit_reviewed, credit_reviewed_by)
			 VALUES (?, ?, ?, 'ONLINE TRANSFER FROM SAV', ?, ?, 'test', 1, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			bank,
			TODAY,
			CREDIT_CENTS,
			plaidId,
			pending,
			s.excluded,
			s.excludedSource,
			s.flagIncome,
			s.incomeSource,
			s.creditReviewed,
			s.creditReviewedBy,
		)
		.run();

	return present(result.meta.last_row_id);
}

/** Merges the pending row into the posted row, as sync does, and returns the posted row's review state. */
async function merge(pendingPlaidId: string, postedPlaidId: string) {
	await db.batch(
		mergePendingIntoPosted(db, item, LOCK, pendingPlaidId, {
			id: postedPlaidId,
			cents: CREDIT_CENTS,
			date: TODAY,
			name: "ONLINE TRANSFER FROM SAV",
			merchantName: null,
			plaidCategory: null,
		}),
	);

	return db
		.prepare(
			`SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by
			 FROM transactions WHERE plaid_transaction_id = ?`,
		)
		.bind(postedPlaidId)
		.first<{
			flag_income: number;
			income_source: string | null;
			credit_reviewed: number | null;
			credit_reviewed_by: string | null;
		}>();
}

describe("the pending-to-posted merge carries a transfer credit's income and review (#878)", () => {
	it("a pending credit a person included by this rule keeps its review once it posts", async () => {
		const pendingId = await insertCredit("pend-included", 1);
		// The person turns Exclude off on the pending row, which the rule saves as income they reviewed.
		await saveEdit(
			db,
			pendingId,
			{
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
			},
			"test",
		);
		await insertCredit("post-included", 0);

		expect(await merge("pend-included", "post-included")).toEqual({
			flag_income: 1,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: null,
		});
	});

	it("guard, passes before the change too: the posted row's own review by a person is kept", async () => {
		await insertCredit("pend-own", 1, {
			excluded: 0,
			excludedSource: "user",
			flagIncome: 1,
			incomeSource: "user",
			creditReviewed: 1,
		});
		await insertCredit("post-own", 0, {
			flagIncome: 0,
			incomeSource: "user",
			creditReviewed: 1,
			creditReviewedBy: "user",
		});

		expect(await merge("pend-own", "post-own")).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

	it("guard, passes before the change too: the posted row's own income choice blocks the copied review", async () => {
		await insertCredit("pend-choice", 1, {
			excluded: 0,
			excludedSource: "user",
			flagIncome: 1,
			incomeSource: "user",
			creditReviewed: 1,
		});
		await insertCredit("post-choice", 0, {
			flagIncome: 0,
			incomeSource: "user",
		});

		expect(await merge("pend-choice", "post-choice")).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 0,
			credit_reviewed_by: null,
		});
	});

	it("a pending income a person chose is not copied onto a posted row they reviewed as a refund", async () => {
		await insertCredit("pend-refund-income", 1, {
			excluded: 0,
			excludedSource: "user",
			flagIncome: 1,
			incomeSource: "user",
		});
		await insertCredit("post-refund", 0, {
			creditReviewed: 1,
			creditReviewedBy: "user",
		});

		expect(await merge("pend-refund-income", "post-refund")).toEqual({
			flag_income: 0,
			income_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

	it("guard, passes before the change too: a pending person's review copies even when the posted row has its own income choice", async () => {
		await insertCredit("pend-review-only", 1, {
			excluded: 0,
			excludedSource: "user",
			flagIncome: 0,
			creditReviewed: 1,
			creditReviewedBy: "user",
		});
		await insertCredit("post-choice-only", 0, {
			flagIncome: 0,
			incomeSource: "user",
		});

		expect(await merge("pend-review-only", "post-choice-only")).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

	it("guard, passes before the change too: a pending row with no review of its own leaves the posted review alone", async () => {
		await insertCredit("pend-none", 1);
		await insertCredit("post-none", 0, { creditReviewed: 1 });

		expect(await merge("pend-none", "post-none")).toEqual({
			flag_income: 0,
			income_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: null,
		});
	});
});
