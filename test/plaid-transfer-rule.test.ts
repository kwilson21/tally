import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyPlaidTransferRule,
	plaidTransferRuleStatement,
} from "../src/db/plaid-transfers";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

type Options = {
	excluded?: number;
	source?: string | null;
	split?: boolean;
	parent?: number;
	incomeSource?: string | null;
	reviewedBy?: string | null;
};

/** One stored transaction (ids from 9001 up), with Plaid's category and who decided what so far. */
const add = (id: number, category: string | null, options: Options = {}) =>
	db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_category, excluded, excluded_source, is_split, parent_id, income_source, credit_reviewed_by)
			 SELECT ?, id, '2026-09-10', 5000, 'SYNTHETIC', ?, ?, ?, ?, ?, ?, ? FROM accounts LIMIT 1`,
		)
		.bind(
			id,
			category,
			options.excluded ?? 0,
			options.source ?? null,
			options.split ? 1 : 0,
			options.parent ?? null,
			options.incomeSource ?? null,
			options.reviewedBy ?? null,
		);

const stateOf = async (id: number) => {
	const row = await db
		.prepare("SELECT excluded, excluded_source FROM transactions WHERE id = ?")
		.bind(id)
		.first<{ excluded: number; excluded_source: string | null }>();
	return [row?.excluded, row?.excluded_source];
};

const COUNTED = [0, null];
const PLAID = [1, "plaid"];

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9100, 'Mortgage', 150000, 1, 'monthly', 'LANDLORD LLC')",
		),
	]);
});

describe("applyPlaidTransferRule", () => {
	it.each(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"])(
		"excludes a stored %s transaction nobody decided about, with Plaid as the source",
		async (category) => {
			await add(9001, category).run();
			await applyPlaidTransferRule(db, [9001]);
			expect(await stateOf(9001)).toEqual(PLAID);
		},
	);

	it("touches only the transactions it is given", async () => {
		await db.batch([add(9001, "TRANSFER_OUT"), add(9002, "TRANSFER_OUT")]);
		await applyPlaidTransferRule(db, [9001]);
		expect(await stateOf(9001)).toEqual(PLAID);
		expect(await stateOf(9002)).toEqual(COUNTED);
	});

	it("does nothing for an empty list", async () => {
		await add(9001, "TRANSFER_OUT").run();
		await applyPlaidTransferRule(db, []);
		expect(await stateOf(9001)).toEqual(COUNTED);
	});

	it("leaves a transaction that isn't a transfer counted", async () => {
		await db.batch([add(9001, "FOOD_AND_DRINK"), add(9002, null)]);
		await applyPlaidTransferRule(db, [9001, 9002]);
		expect(await stateOf(9001)).toEqual(COUNTED);
		expect(await stateOf(9002)).toEqual(COUNTED);
	});

	it("never changes a person's include or exclude, or keeps Jev's source", async () => {
		await db.batch([
			add(9001, "TRANSFER_OUT", { source: "user" }),
			add(9002, "TRANSFER_OUT", { excluded: 1, source: "user" }),
			add(9003, "TRANSFER_OUT", { excluded: 1, source: "jev" }),
			add(9004, "TRANSFER_OUT", { excluded: 1 }),
		]);
		await applyPlaidTransferRule(db, [9001, 9002, 9003, 9004]);
		expect(await stateOf(9001)).toEqual([0, "user"]);
		expect(await stateOf(9002)).toEqual([1, "user"]);
		expect(await stateOf(9003)).toEqual([1, "jev"]);
		expect(await stateOf(9004)).toEqual([1, null]);
	});

	it("leaves a payment linked to a bill counted, and excludes it once the link is gone", async () => {
		await db.batch([
			add(9001, "TRANSFER_OUT"),
			db.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9100, '2026-09', 9001, 'user', 'linked')",
			),
		]);
		await applyPlaidTransferRule(db, [9001]);
		expect(await stateOf(9001)).toEqual(COUNTED);

		// A dismissed payment is not a link.
		await db.batch([
			db.prepare("DELETE FROM bill_payments WHERE bill_id = 9100"),
			db.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9100, '2026-09', 9001, 'user', 'dismissed')",
			),
		]);
		await applyPlaidTransferRule(db, [9001]);
		expect(await stateOf(9001)).toEqual(PLAID);
	});

	it.each([
		["income a person chose", { incomeSource: "user" }],
		["a credit a person reviewed", { reviewedBy: "user" }],
	])("leaves %s counted", async (_name, options) => {
		await add(9001, "TRANSFER_IN", options).run();
		await applyPlaidTransferRule(db, [9001]);
		expect(await stateOf(9001)).toEqual(COUNTED);
	});

	it("takes back its own exclusion when the category isn't a transfer, and no one else's", async () => {
		await db.batch([
			add(9001, "FOOD_AND_DRINK", { excluded: 1, source: "plaid" }),
			add(9002, "FOOD_AND_DRINK", { excluded: 1, source: "jev" }),
			add(9003, "FOOD_AND_DRINK", { excluded: 1, source: "user" }),
			add(9004, "TRANSFER_IN", {
				excluded: 1,
				source: "plaid",
				incomeSource: "user",
			}),
		]);
		await applyPlaidTransferRule(db, [9001, 9002, 9003, 9004]);
		expect(await stateOf(9001)).toEqual(COUNTED);
		expect(await stateOf(9002)).toEqual([1, "jev"]);
		expect(await stateOf(9003)).toEqual([1, "user"]);
		// A person's income choice wins over Plaid's own earlier exclusion.
		expect(await stateOf(9004)).toEqual(COUNTED);
	});

	describe("a split's parts", () => {
		it("follow the bank transaction's category, whether it or a part is given", async () => {
			await db.batch([
				add(9001, "TRANSFER_OUT", { split: true }),
				add(9002, null, { parent: 9001 }),
				add(9003, null, { parent: 9001 }),
				add(9011, "TRANSFER_OUT", { split: true }),
				add(9012, null, { parent: 9011 }),
				add(9013, null, { parent: 9011 }),
			]);
			await applyPlaidTransferRule(db, [9001, 9012]);
			expect(await stateOf(9001)).toEqual(PLAID);
			expect(await stateOf(9002)).toEqual(PLAID);
			expect(await stateOf(9003)).toEqual(PLAID);
			// Only the part that was given, not its parent or sibling.
			expect(await stateOf(9011)).toEqual(COUNTED);
			expect(await stateOf(9012)).toEqual(PLAID);
			expect(await stateOf(9013)).toEqual(COUNTED);
		});

		it("keep a person's choice, a bill link and a person's whole-split choice", async () => {
			await db.batch([
				add(9001, "LOAN_PAYMENTS", { split: true }),
				add(9002, null, { parent: 9001, source: "user" }),
				add(9003, null, { parent: 9001 }),
				add(9004, null, { parent: 9001 }),
				add(9011, "LOAN_PAYMENTS", { split: true, source: "user" }),
				add(9012, null, { parent: 9011 }),
				db.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9100, '2026-09', 9003, 'user', 'linked')",
				),
			]);
			await applyPlaidTransferRule(db, [9001, 9011]);
			expect(await stateOf(9002)).toEqual([0, "user"]);
			expect(await stateOf(9003)).toEqual(COUNTED);
			expect(await stateOf(9004)).toEqual(PLAID);
			expect(await stateOf(9012)).toEqual(COUNTED);
		});
	});

	it("can run inside a batch with the write that removes a link", async () => {
		await db.batch([
			add(9001, "TRANSFER_OUT"),
			db.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9100, '2026-09', 9001, 'user', 'linked')",
			),
		]);
		await db.batch([
			db.prepare("DELETE FROM bill_payments WHERE transaction_id = 9001"),
			plaidTransferRuleStatement(db, [9001]),
		]);
		expect(await stateOf(9001)).toEqual(PLAID);
	});
});
