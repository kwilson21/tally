import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AI_SWITCHES_ALL_ON, type AiSwitches } from "../src/db/ai-switches";
import { addNeverSuggest } from "../src/db/never-suggest";
import {
	categoryAskedSql,
	incomeAskedSql,
	suggestionQueue,
	transferAskedSql,
} from "../src/db/suggestions-queue";
import { resetDemo } from "../src/demo/reset";

// The one review screen's queue (spec §8.6, decisions 79 and 101, issue #195): every "Maybe …" a person
// hasn't answered, one item at a time, in the order money first, then categories, new categories, names.
// The Band on Settings shows exactly this list's length.

const db = env.DB;
const ALL_OFF_CATEGORIES: AiSwitches = {
	...AI_SWITCHES_ALL_ON,
	categories: false,
};

let account = 0;
let eatingOut = 0;

async function transaction(fields: {
	date?: string;
	amount: number;
	raw: string;
	merchantName?: string | null;
	categoryId?: number | null;
	categorySource?: string | null;
	categoryConfidence?: number | null;
	jevCategoryId?: number | null;
	flagIncome?: number;
	incomeSource?: string | null;
	incomeConfidence?: number | null;
	creditReviewed?: number;
	creditReviewedBy?: string | null;
	flagTransfer?: number;
	excluded?: number;
	excludedSource?: string | null;
	transferConfidence?: number | null;
	suggestionId?: number | null;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name,
				category_id, category_source, category_confidence, jev_category_id, flag_income, income_source,
				income_confidence, credit_reviewed, credit_reviewed_by, flag_transfer, excluded, excluded_source,
				transfer_confidence, category_suggestion_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			account,
			fields.date ?? "2026-10-03",
			fields.amount,
			fields.raw,
			fields.merchantName ?? null,
			fields.categoryId ?? null,
			fields.categorySource ?? null,
			fields.categoryConfidence ?? null,
			fields.jevCategoryId ?? null,
			fields.flagIncome ?? 0,
			fields.incomeSource ?? null,
			fields.incomeConfidence ?? null,
			fields.creditReviewed ?? 0,
			fields.creditReviewedBy ?? null,
			fields.flagTransfer ?? 0,
			fields.excluded ?? 0,
			fields.excludedSource ?? null,
			fields.transferConfidence ?? null,
			fields.suggestionId ?? null,
		)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

/** One of each kind: a paycheck guess, a transfer guess, a category guess, a new category and a name. */
async function oneOfEachKind() {
	const income = await transaction({
		amount: -250000,
		raw: "VENMO PAYMENT",
		incomeConfidence: 0.5,
		date: "2026-10-02",
	});
	const transfer = await transaction({
		amount: 20000,
		raw: "CHASE CARD PAYMENT",
		transferConfidence: 0.5,
		date: "2026-10-02",
	});
	const category = await transaction({
		amount: 2300,
		raw: "SQ *LUPITAS TAQ 2210",
		jevCategoryId: eatingOut,
		categoryConfidence: 0.5,
		date: "2026-10-02",
	});
	const suggestion = await db
		.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
		)
		.first<{ id: number }>();
	for (const raw of ["CHEWY.COM 1", "PETSMART 22"]) {
		await transaction({
			amount: 4500,
			raw,
			suggestionId: suggestion?.id ?? null,
			jevCategoryId: null,
		});
	}
	await db
		.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('BLUE BOTTLE COF', 'Blue Bottle Coffee', 'pending')",
		)
		.run();
	await transaction({ amount: 600, raw: "BLUE BOTTLE COF" });
	return { income, transfer, category, suggestion: suggestion?.id ?? 0 };
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM never_suggest_rules"),
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
	const acc = await db
		.prepare("SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1")
		.first<{ id: number }>();
	account = acc?.id ?? 1;
	const cat = await db
		.prepare("SELECT id FROM categories WHERE name = 'Eating Out'")
		.first<{ id: number }>();
	eatingOut = cat?.id ?? 0;
});

describe("suggestionQueue", () => {
	it("holds one item of each kind, and the Band's count is the number of items", async () => {
		await oneOfEachKind();
		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		expect(queue.map((item) => item.kind)).toEqual([
			"income",
			"transfer",
			"category",
			"new_category",
			"name",
		]);
		expect(queue).toHaveLength(5);
	});

	it("asks every pending new category, not only the ten busiest, so the count covers them all", async () => {
		for (let n = 0; n < 11; n++) {
			const suggestion = await db
				.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES (?, 'pending') RETURNING id",
				)
				.bind(`Club ${n}`)
				.first<{ id: number }>();
			await transaction({
				amount: 1000 + n,
				raw: `CLUB ${n}`,
				suggestionId: suggestion?.id ?? null,
				jevCategoryId: null,
			});
		}
		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		expect(queue.filter((item) => item.kind === "new_category")).toHaveLength(
			11,
		);
		expect(queue).toHaveLength(11);
	});

	it("orders money first: income, then transfers, categories, new categories and names", async () => {
		await oneOfEachKind();
		const kinds = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).map(
			(item) => item.kind,
		);
		expect(kinds.indexOf("income")).toBeLessThan(kinds.indexOf("transfer"));
		expect(kinds.indexOf("transfer")).toBeLessThan(kinds.indexOf("category"));
		expect(kinds.indexOf("category")).toBeLessThan(
			kinds.indexOf("new_category"),
		);
		expect(kinds.indexOf("new_category")).toBeLessThan(kinds.indexOf("name"));
	});

	it("lists the newest first within a kind", async () => {
		await transaction({
			amount: -1000,
			raw: "OLD PAYER",
			incomeConfidence: 0.5,
			date: "2026-09-10",
		});
		const newer = await transaction({
			amount: -1000,
			raw: "NEW PAYER",
			incomeConfidence: 0.5,
			date: "2026-09-20",
		});
		const incomes = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).filter(
			(item) => item.kind === "income",
		);
		expect(incomes[0]).toMatchObject({ transactionId: newer });
	});

	it("leaves out a Maybe the person already answered, and a sure guess", async () => {
		await transaction({
			amount: -1000,
			raw: "ANSWERED",
			incomeConfidence: 0.5,
			creditReviewedBy: "user",
			creditReviewed: 1,
		});
		await transaction({
			amount: -1000,
			raw: "SURE PAYER",
			incomeConfidence: 0.95,
		});
		await transaction({
			amount: 2000,
			raw: "SETTLED TRANSFER",
			transferConfidence: 0.5,
			excludedSource: "user",
		});
		expect(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).toEqual([]);
	});

	it("follows each switch: Guess categories hides categories, transfers and new categories; Spot paychecks hides income", async () => {
		await oneOfEachKind();
		const kinds = (await suggestionQueue(db, ALL_OFF_CATEGORIES)).map(
			(item) => item.kind,
		);
		expect(kinds).toEqual(["income", "name"]);
		const noIncome = await suggestionQueue(db, {
			...AI_SWITCHES_ALL_ON,
			income: false,
		});
		expect(noIncome.map((item) => item.kind)).not.toContain("income");
	});

	it("with Suggest store names off, a bank-sent name is still asked and no Tally guess is", async () => {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('BLUE BOTTLE COF', 'Blue Bottle Coffee', 'pending'), ('Petsmart', 'Petsmart', 'pending')",
			)
			.run();
		await transaction({ amount: 600, raw: "BLUE BOTTLE COF" });
		await transaction({
			amount: 1200,
			raw: "PETSMART*ONLINE 0022",
			merchantName: "Petsmart",
		});
		const queue = await suggestionQueue(db, {
			...AI_SWITCHES_ALL_ON,
			names: false,
		});
		const names = queue.filter((item) => item.kind === "name");
		expect(names).toHaveLength(1);
		expect(names[0]).toMatchObject({ merchantKey: "Petsmart" });
	});

	it("a Never-suggest income line hides that store's income guess only", async () => {
		await transaction({
			amount: -1000,
			raw: "VENMO PAYMENT",
			incomeConfidence: 0.5,
		});
		await transaction({
			amount: -1000,
			raw: "VENMO OTHER",
			incomeConfidence: 0.5,
		});
		await addNeverSuggest(db, {
			merchantKey: "VENMO PAYMENT",
			kind: "income",
			decidedOn: "2026-10-03",
		});
		const left = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		expect(
			left.map((item) => item.kind === "income" && item.merchantKey),
		).toEqual(["VENMO OTHER"]);
	});

	it("a new-category rule takes that store out of the suggestion, and drops it when no store is left", async () => {
		const { suggestion } = await oneOfEachKind();
		await addNeverSuggest(db, {
			merchantKey: "CHEWY.COM 1",
			kind: "new_category",
			decidedOn: "2026-10-03",
		});
		const kept = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).find(
			(item) => item.kind === "new_category",
		);
		expect(kept).toMatchObject({ suggestionId: suggestion });
		expect(
			kept?.kind === "new_category"
				? kept.stores.map((s) => s.merchantKey)
				: [],
		).toEqual(["PETSMART 22"]);
		await addNeverSuggest(db, {
			merchantKey: "PETSMART 22",
			kind: "new_category",
			decidedOn: "2026-10-03",
		});
		const gone = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).filter(
			(item) => item.kind === "new_category",
		);
		expect(gone).toEqual([]);
	});

	it("never asks about a refund linked to a purchase: its exclusion or income mark would change the purchase's refunds", async () => {
		const purchase = await transaction({ amount: 5000, raw: "SHOP PURCHASE" });
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
					income_confidence, transfer_confidence, refund_of_id)
				VALUES (?, ?, '2026-10-03', -5000, 'SHOP REFUND', 0.5, 0.5, ?)`,
			)
			.bind(`plaid-${crypto.randomUUID()}`, account, purchase)
			.run();
		expect(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).toEqual([]);
	});

	it("keeps a credit linked to a purchase out of the category queue, as its row shows no Maybe, and asks it once the purchase is left out", async () => {
		const purchase = await transaction({ amount: 5000, raw: "SHOP PURCHASE" });
		const refund = await transaction({
			amount: -2000,
			raw: "SHOP REFUND",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
			creditReviewed: 1,
		});
		await db
			.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
			.bind(purchase, refund)
			.run();
		const categories = async () =>
			(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap((item) =>
				item.kind === "category" ? [item.transactionId] : [],
			);
		expect(await categories()).toEqual([]);
		await db
			.prepare("UPDATE transactions SET excluded = 1 WHERE id = ?")
			.bind(purchase)
			.run();
		expect(await categories()).toEqual([refund]);
	});

	it("asks about an excluded credit that pays a bill, as its row shows it as Maybe income, and not one left out", async () => {
		const paying = await transaction({
			amount: -250000,
			raw: "CARD PAYMENT CREDIT",
			incomeConfidence: 0.5,
			excluded: 1,
		});
		await transaction({
			amount: -250000,
			raw: "LEFT OUT CREDIT",
			incomeConfidence: 0.5,
			excluded: 1,
		});
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 250000, 1, 'monthly', 'CARD PAYMENT CREDIT') RETURNING id",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paying)
			.run();
		const income = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap(
			(item) => (item.kind === "income" ? [item.transactionId] : []),
		);
		expect(income).toEqual([paying]);
	});

	it("never asks a transfer about a payment linked to a bill, since leaving it out can't take it out of the budget", async () => {
		const paying = await transaction({
			amount: 20000,
			raw: "CHASE CARD PAYMENT",
			transferConfidence: 0.5,
		});
		const unlinked = await transaction({
			amount: 20000,
			raw: "CHASE CARD OTHER",
			transferConfidence: 0.5,
		});
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 20000, 1, 'monthly', 'CHASE CARD PAYMENT') RETURNING id",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paying)
			.run();
		const transfers = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap(
			(item) => (item.kind === "transfer" ? [item.transactionId] : []),
		);
		expect(transfers).toEqual([unlinked]);
	});

	it("never asks a category for a transaction a person or Tally left out of the budget", async () => {
		await transaction({
			amount: 2300,
			raw: "LEFT OUT TAQ",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
			excluded: 1,
		});
		expect(
			(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).filter(
				(item) => item.kind === "category",
			),
		).toEqual([]);
	});

	it("asks the category of an excluded transaction that pays a bill, as its row shows the Maybe, and not one left out", async () => {
		const paying = await transaction({
			amount: 2300,
			raw: "GYM MEMBERSHIP",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
			excluded: 1,
		});
		await transaction({
			amount: 2300,
			raw: "LEFT OUT TAQ",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
			excluded: 1,
		});
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Gym', 2300, 1, 'monthly', 'GYM MEMBERSHIP') RETURNING id",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paying)
			.run();
		const categories = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap(
			(item) => (item.kind === "category" ? [item.transactionId] : []),
		);
		expect(categories).toEqual([paying]);
	});

	it("asks no category about a credit held for review until a person or Tally reviews it, as Organize leaves it out, but still asks money out", async () => {
		const held = await transaction({
			amount: -2500,
			raw: "VENMO 123",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		const spent = await transaction({
			amount: 2300,
			raw: "SQ *LUPITAS TAQ 2210",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		const categories = async () =>
			(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap((item) =>
				item.kind === "category" ? [item.transactionId] : [],
			);
		expect(await categories()).toEqual([spent]);
		expect(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).toHaveLength(1);
		await db
			.prepare("UPDATE transactions SET credit_reviewed = 1 WHERE id = ?")
			.bind(held)
			.run();
		expect((await categories()).sort()).toEqual([held, spent].sort());
	});

	it("is empty when nothing waits", async () => {
		expect(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).toEqual([]);
	});
});

describe("a card's label is the transaction's own name, else its store's (spec §5)", () => {
	async function amazon() {
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('AMAZON', 'Amazon')",
			)
			.run();
	}

	it("labels an income, transfer and category item by its own name, and keeps its store and key", async () => {
		await amazon();
		const income = await transaction({
			amount: -250000,
			raw: "AMAZON",
			incomeConfidence: 0.5,
		});
		const transfer = await transaction({
			amount: 20000,
			raw: "AMAZON",
			transferConfidence: 0.5,
		});
		const category = await transaction({
			amount: 2300,
			raw: "AMAZON",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		for (const id of [income, transfer, category])
			await db
				.prepare(
					"UPDATE transactions SET own_name = 'Birthday gift' WHERE id = ?",
				)
				.bind(id)
				.run();
		const queue = await suggestionQueue(db, AI_SWITCHES_ALL_ON);
		expect(queue.map((item) => item.kind)).toEqual([
			"income",
			"transfer",
			"category",
		]);
		for (const item of queue)
			expect(item).toMatchObject({
				label: "Birthday gift",
				merchant: "Amazon",
				merchantKey: "AMAZON",
			});
	});

	it("labels a new category's row by its own name, and its stores by the store's name", async () => {
		await amazon();
		const suggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Gifts', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		const named = await transaction({
			amount: 4500,
			raw: "AMAZON",
			suggestionId: suggestion?.id ?? null,
			jevCategoryId: null,
		});
		const plain = await transaction({
			amount: 3100,
			raw: "AMAZON",
			suggestionId: suggestion?.id ?? null,
			jevCategoryId: null,
		});
		await db
			.prepare(
				"UPDATE transactions SET own_name = 'Birthday gift' WHERE id = ?",
			)
			.bind(named)
			.run();
		const newCategory = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).find(
			(item) => item.kind === "new_category",
		);
		if (newCategory?.kind !== "new_category")
			throw new Error("the new category was not asked");
		expect(newCategory.stores).toEqual([
			{ merchantKey: "AMAZON", merchant: "Amazon" },
		]);
		const rows = Object.fromEntries(
			newCategory.rows.map((row) => [row.transactionId, row]),
		);
		expect(rows[named]).toMatchObject({
			label: "Birthday gift",
			merchant: "Amazon",
			merchantKey: "AMAZON",
		});
		expect(rows[plain]).toMatchObject({ label: "Amazon", merchant: "Amazon" });
	});
});

describe("transferAskedSql", () => {
	it("matches only a plain unsure transfer, the same check the queue and the Yes and No writes share", async () => {
		const plain = await transaction({
			amount: 20000,
			raw: "PLAIN TRANSFER",
			transferConfidence: 0.5,
		});
		await transaction({
			amount: 20000,
			raw: "USER INCLUDED",
			transferConfidence: 0.5,
			excludedSource: "user",
		});
		await transaction({
			amount: 20000,
			raw: "LEFT OUT BY TALLY",
			transferConfidence: 0.5,
			excluded: 1,
		});
		await transaction({
			amount: 20000,
			raw: "FLAGGED TRANSFER",
			transferConfidence: 0.5,
			flagTransfer: 1,
		});
		await transaction({ amount: 20000, raw: "JEV SURE NOW" });
		await transaction({
			amount: 20000,
			raw: "INCOME ROW",
			transferConfidence: 0.5,
			flagIncome: 1,
		});
		const declined = await transaction({
			amount: 20000,
			raw: "DECLINED TRANSFER",
			transferConfidence: 0.5,
		});
		await db
			.prepare(
				"UPDATE transactions SET transfer_maybe_declined = 1 WHERE id = ?",
			)
			.bind(declined)
			.run();
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 20000, 1, 'monthly', 'LINKED PAYMENT') RETURNING id",
			)
			.first<{ id: number }>();
		const paying = await transaction({
			amount: 20000,
			raw: "LINKED PAYMENT",
			transferConfidence: 0.5,
		});
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paying)
			.run();
		const asked = await db
			.prepare(
				`SELECT id FROM transactions WHERE ${transferAskedSql("transactions")} ORDER BY id`,
			)
			.all<{ id: number }>();
		expect(asked.results.map((row) => row.id)).toEqual([plain]);
	});

	it("never matches a store with a Never suggest transfer line, so a stale Yes or No can't answer it either", async () => {
		const lined = await transaction({
			amount: 20000,
			raw: "NEVER TRANSFER",
			transferConfidence: 0.5,
		});
		await addNeverSuggest(db, {
			merchantKey: "NEVER TRANSFER",
			kind: "transfer",
			decidedOn: "2026-10-03",
		});
		const asked = await db
			.prepare(
				`SELECT id FROM transactions WHERE ${transferAskedSql("transactions")}`,
			)
			.all<{ id: number }>();
		expect(asked.results.map((row) => row.id)).not.toContain(lined);
		expect(
			(await suggestionQueue(db, AI_SWITCHES_ALL_ON)).filter(
				(item) => item.kind === "transfer",
			),
		).toEqual([]);
	});

	it("never asks a held credit (not reviewed, so not spending yet) as a transfer, but asks a reviewed one (decision 70)", async () => {
		const held = await transaction({
			amount: -20000,
			raw: "HELD CREDIT",
			transferConfidence: 0.5,
		});
		const reviewed = await transaction({
			amount: -20000,
			raw: "REVIEWED CREDIT",
			transferConfidence: 0.5,
			creditReviewed: 1,
			creditReviewedBy: "user",
		});
		const asked = await db
			.prepare(
				`SELECT id FROM transactions WHERE ${transferAskedSql("transactions")}`,
			)
			.all<{ id: number }>();
		expect(asked.results.map((row) => row.id)).not.toContain(held);
		expect(asked.results.map((row) => row.id)).toContain(reviewed);
		const transfers = (await suggestionQueue(db, AI_SWITCHES_ALL_ON)).flatMap(
			(item) => (item.kind === "transfer" ? [item.transactionId] : []),
		);
		expect(transfers).toContain(reviewed);
		expect(transfers).not.toContain(held);
	});
});

describe("incomeAskedSql", () => {
	it("matches only a plain unsure credit, the same check the queue and the Yes and No writes share", async () => {
		const plain = await transaction({
			amount: -250000,
			raw: "PLAIN CREDIT",
			incomeConfidence: 0.5,
		});
		const reviewed = await transaction({
			amount: -250000,
			raw: "REVIEWED CREDIT",
			incomeConfidence: 0.5,
			creditReviewed: 1,
			creditReviewedBy: "user",
		});
		const leftOut = await transaction({
			amount: -250000,
			raw: "LEFT OUT CREDIT",
			incomeConfidence: 0.5,
			excluded: 1,
		});
		const declined = await transaction({
			amount: -250000,
			raw: "DECLINED CREDIT",
			incomeConfidence: 0.5,
		});
		await db
			.prepare("UPDATE transactions SET income_maybe_declined = 1 WHERE id = ?")
			.bind(declined)
			.run();
		const neverLine = await transaction({
			amount: -250000,
			raw: "NEVER INCOME",
			incomeConfidence: 0.5,
		});
		await addNeverSuggest(db, {
			merchantKey: "NEVER INCOME",
			kind: "income",
			decidedOn: "2026-10-01",
		});
		const jevSaid = await transaction({
			amount: -250000,
			raw: "JEV CREDIT",
			incomeConfidence: 0.5,
			incomeSource: "jev",
		});
		const userSaid = await transaction({
			amount: -250000,
			raw: "USER CREDIT",
			incomeConfidence: 0.5,
			incomeSource: "user",
		});
		const cleared = await transaction({
			amount: -250000,
			raw: "CLEARED CREDIT",
			incomeConfidence: null,
		});
		const purchase = await transaction({ amount: 2300, raw: "LUPITAS" });
		const refund = await transaction({
			amount: -2300,
			raw: "REFUND",
			incomeConfidence: 0.5,
		});
		await db
			.prepare("UPDATE transactions SET refund_of_id = ? WHERE id = ?")
			.bind(purchase, refund)
			.run();
		const bill = await db
			.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 250000, 1, 'monthly', 'BILL CREDIT') RETURNING id",
			)
			.first<{ id: number }>();
		const paysBill = await transaction({
			amount: -250000,
			raw: "BILL CREDIT",
			incomeConfidence: 0.5,
			excluded: 1,
		});
		await db
			.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			)
			.bind(bill?.id, paysBill)
			.run();
		const counted = async (id: number) =>
			(
				await db
					.prepare(
						`SELECT COUNT(*) AS n FROM transactions WHERE id = ? AND ${incomeAskedSql("transactions")}`,
					)
					.bind(id)
					.first<{ n: number }>()
			)?.n;
		const asked = Object.fromEntries(
			await Promise.all(
				Object.entries({
					plain,
					reviewed,
					leftOut,
					declined,
					neverLine,
					jevSaid,
					userSaid,
					cleared,
					refund,
					paysBill,
				}).map(async ([name, id]) => [name, await counted(id)]),
			),
		);
		expect(asked).toEqual({
			plain: 1,
			reviewed: 0,
			leftOut: 0,
			declined: 0,
			neverLine: 0,
			jevSaid: 0,
			userSaid: 0,
			cleared: 0,
			refund: 0,
			paysBill: 1,
		});
	});
});

describe("categoryAskedSql", () => {
	it("matches only a plain unsure category guess, the same check the queue and the Something else and Yes writes share", async () => {
		const retired = await db
			.prepare(
				"INSERT INTO categories (name, icon, color, archived) VALUES ('Retired', 'gas', 'cat-slate', 1) RETURNING id",
			)
			.first<{ id: number }>();
		const plain = await transaction({
			amount: 2300,
			raw: "PLAIN SPEND",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		const userSet = await transaction({
			amount: 2300,
			raw: "USER SET",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
			categorySource: "user",
		});
		const sure = await transaction({
			amount: 2300,
			raw: "SURE SPEND",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.9,
		});
		const archived = await transaction({
			amount: 2300,
			raw: "RETIRED SPEND",
			jevCategoryId: retired?.id ?? null,
			categoryConfidence: 0.5,
		});
		const held = await transaction({
			amount: -2500,
			raw: "HELD CREDIT",
			jevCategoryId: eatingOut,
			categoryConfidence: 0.5,
		});
		const counted = async (id: number) =>
			(
				await db
					.prepare(
						`SELECT COUNT(*) AS n FROM transactions WHERE id = ? AND ${categoryAskedSql("transactions")}`,
					)
					.bind(id)
					.first<{ n: number }>()
			)?.n;
		const asked = Object.fromEntries(
			await Promise.all(
				Object.entries({ plain, userSet, sure, archived, held }).map(
					async ([name, id]) => [name, await counted(id)],
				),
			),
		);
		expect(asked).toEqual({
			plain: 1,
			userSet: 0,
			sure: 0,
			archived: 0,
			held: 0,
		});
	});
});
