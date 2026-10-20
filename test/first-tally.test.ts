import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	type BudgetAnswer,
	forgetPayDeposits,
	isSetUp,
	keepBudgetStatement,
	keepNightStatement,
	markStroke,
	nightSyncStatement,
	type PayAnswerRecord,
	payAnswerStatement,
	readFirstTally,
	STROKES,
	strokeStatement,
	takeBackBankStrokes,
	takeBackQuestionStrokes,
} from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import {
	answerPay,
	budgetsStrokeGuard,
	keepBills,
	NO_PAY_LEFT_SQL,
	type PayMerchant,
	payMerchants,
	settleAndLoad,
} from "../src/first-tally/first-page";
import { BANK_CONNECTED_SQL } from "../src/first-tally/gate";

const db = env.DB;

const stored = async () =>
	await db
		.prepare("SELECT value FROM household_settings WHERE key = 'first_tally'")
		.first<{ value: string }>();

/** The three questions answered (pay, bills, budgets drawn on `day`), so the night's writes can land. */
const answeredQuestions = async (day: string) => {
	for (const stroke of ["bank", "pay", "bills", "budgets"] as const) {
		await markStroke(db, stroke, day);
	}
};

/**
 * A pay answer's batch as answerPay writes it: the answer's own change, then the record behind it. The stand-in change
 * is an UPDATE of the record's row, which changes one row whenever the record exists (each test writes one first).
 */
const payBatch = (merchant: string, record: PayAnswerRecord) =>
	db.batch([
		db.prepare(
			"UPDATE household_settings SET value = value WHERE key = 'first_tally'",
		),
		payAnswerStatement(db, merchant, record),
	]);

/** One budgets answer, written the way the route writes it: its record statement, run on its own. */
const keepBudget = (categoryId: number, answer: BudgetAnswer) =>
	keepBudgetStatement(db, categoryId, answer).run();

/** A found charge as Possible bills lists it, with a category, for keepBills. */
const found = (
	rawName: string,
	displayName: string,
	amountCents: number,
	categoryId: number,
): BillSuggestion => ({
	rawName,
	bankText: rawName,
	displayName,
	amountCents,
	dueDay: 5,
	categoryId,
	chargeCount: 2,
});

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
		.run();
});

describe("first_tally record", () => {
	it("has no record until something is written, and is not set up", async () => {
		expect(await readFirstTally(db)).toBeNull();
		expect(isSetUp(null)).toBe(false);
	});

	it("keeps the day each stroke was drawn, and a stroke drawn once keeps its first day", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await markStroke(db, "bank", "2026-10-12");
		await markStroke(db, "pay", "2026-10-11");
		expect(await readFirstTally(db)).toEqual({
			strokes: { bank: "2026-10-10", pay: "2026-10-11" },
			budgets: {},
		});
		expect(isSetUp(await readFirstTally(db))).toBe(false);
	});

	it("draws a stroke with no day, which still counts as drawn", async () => {
		await markStroke(db, "bank", null);
		expect((await readFirstTally(db))?.strokes).toEqual({ bank: null });
	});

	it("is set up once all five strokes are drawn, days or not", async () => {
		expect(STROKES).toEqual(["bank", "pay", "bills", "budgets", "count"]);
		for (const stroke of STROKES) await markStroke(db, stroke, null);
		expect(isSetUp(await readFirstTally(db))).toBe(true);
	});

	it("keeps each budgets answer as it was given, a skip included, and the newest answer for a category", async () => {
		await keepBudget(3, { kind: "suggested", cents: 65000 });
		await keepBudget(4, { kind: "skipped", cents: null });
		await keepBudget(4, { kind: "another", cents: 12000 });
		expect((await readFirstTally(db))?.budgets).toEqual({
			"3": { kind: "suggested", cents: 65000 },
			"4": { kind: "another", cents: 12000 },
		});
	});

	it("keeps the first night's counts beside the strokes and answers", async () => {
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-13", 1).run();
		expect(await readFirstTally(db)).toEqual({
			strokes: {
				bank: "2026-10-12",
				pay: "2026-10-12",
				bills: "2026-10-12",
				budgets: "2026-10-12",
			},
			budgets: {},
			night: { brought: 3, needYou: 1 },
		});
	});

	it("stores the record as one JSON value under first_tally", async () => {
		await markStroke(db, "bank", "2026-10-10");
		expect(await stored()).toEqual({
			value: JSON.stringify({ strokes: { bank: "2026-10-10" }, budgets: {} }),
		});
	});

	it("keeps every field when the writes overlap, since each one changes only its own part", async () => {
		await answeredQuestions("2026-10-12");
		await Promise.all([
			keepBudget(3, { kind: "suggested", cents: 65000 }),
			keepBudget(4, { kind: "skipped", cents: null }),
			markStroke(db, "count", "2026-10-13", "1"),
			nightSyncStatement(db, { brought: 3, on: "2026-10-13", ok: true }).run(),
		]);
		expect(await readFirstTally(db)).toEqual({
			strokes: {
				bank: "2026-10-12",
				pay: "2026-10-12",
				bills: "2026-10-12",
				budgets: "2026-10-12",
				count: "2026-10-13",
			},
			budgets: {
				"3": { kind: "suggested", cents: 65000 },
				"4": { kind: "skipped", cents: null },
			},
		});
	});

	it("is gone after the demo's nightly reset, so the demo never shows setup", async () => {
		await answeredQuestions("2026-10-01");
		await nightSyncStatement(db, {
			brought: 0,
			on: "2026-10-01",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-01", 0).run();
		expect(await readFirstTally(db)).not.toBeNull();
		await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
		expect(await readFirstTally(db)).toBeNull();
		expect(await stored()).toBeNull();
	});
});

describe("the pay answers' record (P125 E)", () => {
	it("keeps each merchant's answers by its key, a key with a quote in it included, and a merchant answered again keeps both its Yes and its No deposits", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch('ACME "CORP"', {
			yes: { "1": { date: "2026-10-01", cents: 245000 } },
		});
		await payBatch("SIDE GIG", {
			no: { "2": { date: "2026-10-02", cents: 4000 } },
		});
		await payBatch("SIDE GIG", {
			yes: { "3": { date: "2026-10-03", cents: 4000 } },
		});
		const record = await readFirstTally(db);
		expect(record?.strokes).toEqual({ bank: "2026-10-10" });
		expect(record?.pay).toEqual({
			'ACME "CORP"': {
				yes: { "1": { date: "2026-10-01", cents: 245000 } },
				at: 0,
			},
			"SIDE GIG": {
				no: { "2": { date: "2026-10-02", cents: 4000 } },
				yes: { "3": { date: "2026-10-03", cents: 4000 } },
				at: 1,
			},
		});
	});

	it("starts the pay answers on a record that has none yet", async () => {
		await markStroke(db, "bank", null);
		await payBatch("ACME CORP", {
			no: { "7": { date: "2026-10-01", cents: 4000 } },
		});
		expect((await readFirstTally(db))?.pay).toEqual({
			"ACME CORP": { no: { "7": { date: "2026-10-01", cents: 4000 } }, at: 0 },
		});
	});

	it("keeps a merchant's place in the order first answered, and a re-answer keeps it, a numeric key included", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch("ACME CORP", {
			yes: { "1": { date: "2026-10-01", cents: 245000 } },
		});
		await payBatch("1234", {
			yes: { "3": { date: "2026-10-02", cents: 9000 } },
		});
		await payBatch("ACME CORP", {
			no: { "2": { date: "2026-10-08", cents: 245000 } },
		});
		const pay = (await readFirstTally(db))?.pay;
		expect(pay?.["ACME CORP"]).toEqual({
			yes: { "1": { date: "2026-10-01", cents: 245000 } },
			no: { "2": { date: "2026-10-08", cents: 245000 } },
			at: 0,
		});
		expect(pay?.["1234"]?.at).toBe(1);
	});

	it("gives a key with a quote in it the next place, since no key is ever put in a JSON path", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch("ACME CORP", {
			no: { "5": { date: "2026-10-01", cents: 4000 } },
		});
		await payBatch('ACME "CORP"', {
			yes: { "6": { date: "2026-10-01", cents: 245000 } },
		});
		expect((await readFirstTally(db))?.pay?.['ACME "CORP"']?.at).toBe(1);
	});

	it("a Yes again for a new deposit adds it to the Yes deposits, and keeps the ones already there", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch("ACME CORP", {
			yes: {
				"1": { date: "2026-09-17", cents: 245000 },
				"2": { date: "2026-10-01", cents: 245000 },
			},
		});
		await payBatch("ACME CORP", {
			yes: { "3": { date: "2026-10-15", cents: 245000 } },
		});
		expect((await readFirstTally(db))?.pay?.["ACME CORP"]).toEqual({
			yes: {
				"1": { date: "2026-09-17", cents: 245000 },
				"2": { date: "2026-10-01", cents: 245000 },
				"3": { date: "2026-10-15", cents: 245000 },
			},
			at: 0,
		});
	});

	it("a Yes again that repeats a deposit keeps one entry for it", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch("ACME CORP", {
			yes: {
				"1": { date: "2026-09-17", cents: 245000 },
				"2": { date: "2026-10-01", cents: 245000 },
			},
		});
		await payBatch("ACME CORP", {
			yes: {
				"2": { date: "2026-10-01", cents: 245000 },
				"3": { date: "2026-10-15", cents: 245000 },
			},
		});
		expect(
			Object.keys((await readFirstTally(db))?.pay?.["ACME CORP"]?.yes ?? {}),
		).toEqual(["1", "2", "3"]);
	});

	it("writes no record for an answer whose own change touched no row", async () => {
		await markStroke(db, "bank", null);
		await db.batch([
			db.prepare("UPDATE transactions SET flag_income = flag_income WHERE 0"),
			payAnswerStatement(db, "ACME CORP", {
				yes: { "1": { date: "2026-10-01", cents: 245000 } },
			}),
		]);
		expect((await readFirstTally(db))?.pay).toBeUndefined();
	});
});

describe("the pay stroke's guard (P125 E, #650)", () => {
	beforeEach(async () => {
		// The demo's own transactions include pay deposits, so the pay question starts with none.
		await db.prepare("DELETE FROM transactions").run();
	});

	/** One money-in row the pay question asks about: marked income, and nobody has decided it. */
	const payDeposit = () =>
		db
			.prepare(
				`INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name, flag_income)
				VALUES ((SELECT MIN(id) FROM accounts), 'stroke-guard-pay', '2026-10-10', -245000, 'ACME CORP PAYROLL', 1)`,
			)
			.run();

	it("leaves the pay stroke undrawn when a deposit arrived after the pay read found none", async () => {
		await markStroke(db, "bank", "2026-10-10");
		expect(await payMerchants(db)).toEqual([]);
		await payDeposit();
		await markStroke(db, "pay", "2026-10-16", NO_PAY_LEFT_SQL);
		expect((await readFirstTally(db))?.strokes).toEqual({
			bank: "2026-10-10",
		});
	});

	it("draws the pay stroke with its day when no pay question is left", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await markStroke(db, "pay", "2026-10-16", NO_PAY_LEFT_SQL);
		expect((await readFirstTally(db))?.strokes).toEqual({
			bank: "2026-10-10",
			pay: "2026-10-16",
		});
	});

	it("keeps a pay stroke's first day, a guarded write after it changes nothing", async () => {
		await markStroke(db, "pay", "2026-10-10");
		await markStroke(db, "pay", "2026-10-16", NO_PAY_LEFT_SQL);
		expect((await readFirstTally(db))?.strokes.pay).toBe("2026-10-10");
	});

	it("still draws the stroke with no guard, a deposit or not, as before", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payDeposit();
		await markStroke(db, "pay", "2026-10-16");
		expect((await readFirstTally(db))?.strokes.pay).toBe("2026-10-16");
	});

	it("is true exactly when the pay question has nothing to ask", async () => {
		const check = async () =>
			await db
				.prepare(`SELECT ${NO_PAY_LEFT_SQL} AS none`)
				.first<{ none: number }>();
		expect(await check()).toEqual({ none: 1 });
		await payDeposit();
		expect(await check()).toEqual({ none: 0 });
	});
});

describe("the legacy bank repair's write (#657)", () => {
	const REPAIR_DAY = "2026-10-16";
	const disconnectAll = () =>
		db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
	const repair = () => markStroke(db, "bank", REPAIR_DAY, BANK_CONNECTED_SQL);

	it("draws nothing when every bank is disconnected", async () => {
		await disconnectAll();
		await repair();
		expect((await readFirstTally(db))?.strokes.bank).toBeUndefined();
	});

	it("draws stroke one on the day when a bank is connected", async () => {
		await disconnectAll();
		await db
			.prepare(
				"UPDATE plaid_items SET disconnected_at = NULL WHERE id = (SELECT MIN(id) FROM plaid_items)",
			)
			.run();
		await repair();
		expect((await readFirstTally(db))?.strokes.bank).toBe(REPAIR_DAY);
	});

	it("keeps a bank day that is already drawn", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await repair();
		expect((await readFirstTally(db))?.strokes.bank).toBe("2026-10-10");
	});
});

describe("the bills step's record (P125 E)", () => {
	it("adds each kept bill to the count and the total in the bill's own write, and a refused name adds nothing", async () => {
		const categoryId = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		const day = "2026-10-10";
		await keepBills(db, day, [found("KEPT ONE", "Kept One", 1549, categoryId)]);
		await keepBills(db, day, [found("KEPT TWO", "Kept Two", 1199, categoryId)]);
		// The same name as an active bill, in other case and spacing: refused, so the record doesn't move.
		await keepBills(db, day, [
			found("KEPT ONE AGAIN", "kept one ", 1549, categoryId),
		]);
		expect((await readFirstTally(db))?.bills).toEqual({
			kept: 2,
			cents: 2748,
		});
	});

	it("keeps no bills record for a step with nothing kept, and draws the bills stroke with its first day", async () => {
		await keepBills(db, "2026-10-10", []);
		expect((await readFirstTally(db))?.bills).toBeUndefined();
		await markStroke(db, "bills", "2026-10-10");
		await markStroke(db, "bills", "2026-10-12");
		expect((await readFirstTally(db))?.strokes.bills).toBe("2026-10-10");
	});
});

describe("a bank's history takes its pay deposits with it (P125 E, decision 114)", () => {
	/** A linked bank with one checking account, as the disconnect route finds one. */
	async function linkBank(name: string) {
		const item = await db
			.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (X'00', ?, 'person') RETURNING id",
			)
			.bind(name)
			.first<{ id: number }>();
		const account = await db
			.prepare(
				"INSERT INTO accounts (plaid_item_id, name, type) VALUES (?, 'Checking', 'depository') RETURNING id",
			)
			.bind(item?.id)
			.first<{ id: number }>();
		return { item: item?.id as number, account: account?.id as number };
	}

	/** One income deposit into a bank's account, in Plaid's sign (money in is negative); returns its transaction id. */
	async function depositInto(
		account: number,
		rawName: string,
		cents: number,
		date: string,
	) {
		const row = await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, flag_income) VALUES (?, ?, ?, ?, 1) RETURNING id",
			)
			.bind(account, date, -cents, rawName)
			.first<{ id: number }>();
		return row?.id as number;
	}

	const answerMerchant = async (key: string, answer: "yes" | "no") => {
		const merchant = (await payMerchants(db)).find(
			(m) => m.key === key,
		) as PayMerchant;
		return answerPay(db, merchant, answer, "person@example.com");
	};

	/** The batch the disconnect route runs for "delete its history": the pay purge first, then the bank's transactions. */
	const deleteHistory = (bank: { item: number; account: number }) =>
		db.batch([
			forgetPayDeposits(db, bank.item),
			db
				.prepare("DELETE FROM transactions WHERE account_id = ?")
				.bind(bank.account),
		]);

	/** Every transaction id the record still holds, under Yes or No, across all merchants. */
	const depositIds = (record: Awaited<ReturnType<typeof readFirstTally>>) =>
		Object.values(record?.pay ?? {}).flatMap((merchant) => [
			...Object.keys(merchant.yes ?? {}),
			...Object.keys(merchant.no ?? {}),
		]);

	it("drops the bank's Yes and No deposits from the record, and the merchants left with none", async () => {
		const bankA = await linkBank("Bank A");
		const bankB = await linkBank("Bank B");
		const payA = await depositInto(
			bankA.account,
			"NORTHWIND PAYROLL",
			245000,
			"2026-10-01",
		);
		const refundA = await depositInto(
			bankA.account,
			"HARBOR REFUND",
			4000,
			"2026-10-02",
		);
		const payB = await depositInto(
			bankB.account,
			"SIDE GIG",
			9000,
			"2026-10-03",
		);
		await answerMerchant("HARBOR REFUND", "no");
		await answerMerchant("NORTHWIND PAYROLL", "yes");
		await answerMerchant("SIDE GIG", "yes");
		const bBefore = (await readFirstTally(db))?.pay?.["SIDE GIG"];

		await deleteHistory(bankA);

		const after = await readFirstTally(db);
		expect(depositIds(after)).toEqual([String(payB)]);
		expect(depositIds(after)).not.toContain(String(payA));
		expect(depositIds(after)).not.toContain(String(refundA));
		expect(after?.pay?.["NORTHWIND PAYROLL"]).toBeUndefined();
		expect(after?.pay?.["HARBOR REFUND"]).toBeUndefined();
		expect(after?.pay?.["SIDE GIG"]).toEqual(bBefore);
	});

	it("keeps only the other bank's deposits of a merchant paid from both banks, and its place", async () => {
		const bankA = await linkBank("Bank A");
		const bankB = await linkBank("Bank B");
		await depositInto(bankA.account, "NORTHWIND PAYROLL", 245000, "2026-10-01");
		const payB = await depositInto(
			bankB.account,
			"NORTHWIND PAYROLL",
			245000,
			"2026-10-15",
		);
		await answerMerchant("NORTHWIND PAYROLL", "yes");

		await deleteHistory(bankA);

		expect((await readFirstTally(db))?.pay?.["NORTHWIND PAYROLL"]).toEqual({
			yes: { [payB]: { date: "2026-10-15", cents: 245000 } },
			at: 0,
		});
	});

	it("leaves a record with no pay key exactly as it is, and adds none", async () => {
		const bankA = await linkBank("Bank A");
		await depositInto(bankA.account, "NORTHWIND PAYROLL", 245000, "2026-10-01");
		await markStroke(db, "bank", "2026-10-10");
		const before = await stored();

		await deleteHistory(bankA);

		expect(await stored()).toEqual(before);
		expect((await readFirstTally(db))?.pay).toBeUndefined();
	});

	it("runs with no first_tally row and writes none", async () => {
		const bankA = await linkBank("Bank A");
		await depositInto(bankA.account, "NORTHWIND PAYROLL", 245000, "2026-10-01");

		await deleteHistory(bankA);

		expect(await stored()).toBeNull();
	});

	it("takes the deposits off the ledger, and keeps the other bank's line", async () => {
		const bankA = await linkBank("Bank A");
		const bankB = await linkBank("Bank B");
		await depositInto(bankA.account, "NORTHWIND PAYROLL", 245000, "2026-10-01");
		await depositInto(bankB.account, "SIDE GIG", 9000, "2026-10-03");
		await answerMerchant("NORTHWIND PAYROLL", "yes");
		await answerMerchant("SIDE GIG", "yes");

		await deleteHistory(bankA);

		const { ledger } = await settleAndLoad(db, todayIn(DEFAULT_TIME_ZONE));
		expect(ledger.map((line) => line.id)).toEqual(["pay:SIDE GIG"]);
		expect(ledger.map((line) => line.text).join(" ")).not.toContain(
			"NORTHWIND",
		);
	});

	it("gives a merchant answered after the purge the next place, past the merchants that are left", async () => {
		const bankA = await linkBank("Bank A");
		const bankB = await linkBank("Bank B");
		await depositInto(bankA.account, "NORTHWIND PAYROLL", 245000, "2026-10-01");
		await depositInto(bankB.account, "SIDE GIG", 9000, "2026-10-03");
		await answerMerchant("NORTHWIND PAYROLL", "yes");
		await answerMerchant("SIDE GIG", "yes");
		await deleteHistory(bankA);
		await depositInto(bankB.account, "HARBOR CAFE PAY", 6000, "2026-10-09");

		await answerMerchant("HARBOR CAFE PAY", "yes");

		const pay = (await readFirstTally(db))?.pay ?? {};
		expect(pay["HARBOR CAFE PAY"]?.at).toBeGreaterThan(
			pay["SIDE GIG"]?.at ?? Number.NaN,
		);
		const { ledger } = await settleAndLoad(db, todayIn(DEFAULT_TIME_ZONE));
		expect(ledger.map((line) => line.id)).toEqual([
			"pay:SIDE GIG",
			"pay:HARBOR CAFE PAY",
		]);
	});
});

describe("the first night's counts (P125 E, #586)", () => {
	it("keeps the 09:00 sync's result only once the three questions are answered", async () => {
		await markStroke(db, "bank", "2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		expect((await readFirstTally(db))?.nightSync).toBeUndefined();
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		expect((await readFirstTally(db))?.nightSync).toEqual({
			brought: 3,
			on: "2026-10-13",
			ok: true,
		});
	});

	it("keeps the 09:00 sync's result as ok false too, so the night's Workflow keeps nothing", async () => {
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 2,
			on: "2026-10-13",
			ok: false,
		}).run();
		await keepNightStatement(db, "2026-10-13", 0).run();
		expect((await readFirstTally(db))?.nightSync).toEqual({
			brought: 2,
			on: "2026-10-13",
			ok: false,
		});
		expect((await readFirstTally(db))?.night).toBeUndefined();
	});

	it("keeps nothing in the night's Workflow when the 09:00 sync was for another day", async () => {
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-12",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-13", 1).run();
		expect((await readFirstTally(db))?.night).toBeUndefined();
	});

	it("keeps nothing when no 09:00 sync was kept at all", async () => {
		await answeredQuestions("2026-10-12");
		await keepNightStatement(db, "2026-10-13", 1).run();
		expect((await readFirstTally(db))?.night).toBeUndefined();
	});

	it("a later 09:00 run replaces the sync of a night that did not finish", async () => {
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: false,
		}).run();
		await nightSyncStatement(db, {
			brought: 5,
			on: "2026-10-14",
			ok: true,
		}).run();
		expect((await readFirstTally(db))?.nightSync).toEqual({
			brought: 5,
			on: "2026-10-14",
			ok: true,
		});
		await keepNightStatement(db, "2026-10-14", 2).run();
		expect((await readFirstTally(db))?.night).toEqual({
			brought: 5,
			needYou: 2,
		});
	});

	it("keeps the counts once: a second keep changes nothing, and a 09:00 run after it writes nothing", async () => {
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-13", 1).run();
		await nightSyncStatement(db, {
			brought: 9,
			on: "2026-10-14",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-14", 4).run();
		expect(await readFirstTally(db)).toEqual({
			strokes: {
				bank: "2026-10-12",
				pay: "2026-10-12",
				bills: "2026-10-12",
				budgets: "2026-10-12",
			},
			budgets: {},
			night: { brought: 3, needYou: 1 },
		});
	});

	it("writes nothing once the count stroke is drawn", async () => {
		await answeredQuestions("2026-10-12");
		await markStroke(db, "count", "2026-10-13");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		expect((await readFirstTally(db))?.nightSync).toBeUndefined();
	});
});

describe("a second bank during setup takes the questions back (#578)", () => {
	it("takes back pay, bills, budgets, the night and its sync, and keeps stroke one and the answers", async () => {
		await answeredQuestions("2026-10-12");
		await keepBudget(3, { kind: "suggested", cents: 65000 });
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		await keepNightStatement(db, "2026-10-13", 1).run();
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect(await readFirstTally(db)).toEqual({
			strokes: { bank: "2026-10-12" },
			budgets: { "3": { kind: "suggested", cents: 65000 } },
			reAsk: { bank: "Wells Fargo" },
		});
	});

	it("names the bank it took the questions back for in reAsk, the marker the re-ask note reads", async () => {
		await answeredQuestions("2026-10-12");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect((await readFirstTally(db))?.reAsk).toEqual({ bank: "Wells Fargo" });
	});

	it("stores a bank name with quotes and a path in it as the name itself", async () => {
		const name = `O'Brien "Savings" $.strokes.count`;
		await answeredQuestions("2026-10-12");
		await takeBackQuestionStrokes(db, name).run();
		const record = await readFirstTally(db);
		expect(record?.reAsk).toEqual({ bank: name });
		expect(record?.strokes.count).toBeUndefined();
	});

	it("a third bank linked while the re-ask is still open names itself in the marker, not the second", async () => {
		await answeredQuestions("2026-10-12");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		// Nothing is drawn now, so only the open marker lets this link take its place.
		await takeBackQuestionStrokes(db, "Capital One").run();
		expect((await readFirstTally(db))?.reAsk).toEqual({ bank: "Capital One" });
	});

	it("the marker goes once budgets is drawn again, after pay and bills", async () => {
		await answeredQuestions("2026-10-12");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		await markStroke(db, "pay", "2026-10-13");
		await markStroke(db, "bills", "2026-10-13");
		expect((await readFirstTally(db))?.reAsk).toEqual({ bank: "Wells Fargo" });
		await markStroke(db, "budgets", "2026-10-13");
		expect((await readFirstTally(db))?.reAsk).toBeUndefined();
	});

	it("the budgets stroke's guard waits for pay as well as bills, so budgets is always the last question drawn", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		// The demo's unanswered deposits would keep a pay question open, which the guard checks live; this test is about the record.
		await db.prepare("UPDATE transactions SET income_source = 'user'").run();
		await markStroke(db, "bank", "2026-10-12");
		await markStroke(db, "bills", "2026-10-13");
		await strokeStatement(
			db,
			"budgets",
			"2026-10-13",
			budgetsStrokeGuard("2026-10"),
		).run();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		await markStroke(db, "pay", "2026-10-13");
		await strokeStatement(
			db,
			"budgets",
			"2026-10-13",
			budgetsStrokeGuard("2026-10"),
		).run();
		// With no savings answer and no goal above $0, the savings question is still to answer, so the stroke waits (#721).
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		await db
			.prepare(
				"UPDATE household_settings SET value = json_set(value, '$.savings', 'skipped') WHERE key = 'first_tally'",
			)
			.run();
		await strokeStatement(
			db,
			"budgets",
			"2026-10-13",
			budgetsStrokeGuard("2026-10"),
		).run();
		expect((await readFirstTally(db))?.strokes.budgets).toBe("2026-10-13");
	});

	it("the budgets stroke's guard also passes on a current goal above $0, and not on a $0 one (#721)", async () => {
		await db.prepare("UPDATE categories SET archived = 1").run();
		// As above: the demo's unanswered deposits would keep a pay question open, so this test sets them aside.
		await db.prepare("UPDATE transactions SET income_source = 'user'").run();
		await markStroke(db, "bank", "2026-10-12");
		await markStroke(db, "bills", "2026-10-13");
		await markStroke(db, "pay", "2026-10-13");
		await db
			.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES ('2026-10', 0)",
			)
			.run();
		await strokeStatement(
			db,
			"budgets",
			"2026-10-13",
			budgetsStrokeGuard("2026-10"),
		).run();
		expect((await readFirstTally(db))?.strokes.budgets).toBeUndefined();
		await db
			.prepare("UPDATE savings_goal_amounts SET amount_cents = 30000")
			.run();
		await strokeStatement(
			db,
			"budgets",
			"2026-10-13",
			budgetsStrokeGuard("2026-10"),
		).run();
		expect((await readFirstTally(db))?.strokes.budgets).toBe("2026-10-13");
	});

	it("takes the re-ask marker with the bank strokes when the last bank goes before setup is done", async () => {
		await answeredQuestions("2026-10-12");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		await db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
		await takeBackBankStrokes(db, 999).run();
		expect(await readFirstTally(db)).toEqual({ strokes: {}, budgets: {} });
	});

	it("takes nothing back once the count stroke is drawn, so a finished setup stays", async () => {
		await answeredQuestions("2026-10-12");
		await markStroke(db, "count", "2026-10-13");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect((await readFirstTally(db))?.strokes).toEqual({
			bank: "2026-10-12",
			pay: "2026-10-12",
			bills: "2026-10-12",
			budgets: "2026-10-12",
			count: "2026-10-13",
		});
	});

	it("takes nothing back before any question is drawn", async () => {
		await markStroke(db, "bank", "2026-10-12");
		await takeBackQuestionStrokes(db, "Wells Fargo").run();
		expect((await readFirstTally(db))?.strokes).toEqual({ bank: "2026-10-12" });
		expect((await readFirstTally(db))?.reAsk).toBeUndefined();
	});

	it("takes the night and its sync back with the bank strokes when the last bank goes before setup is done", async () => {
		// The demo's banks are connected; the last one going is the case under test.
		await db
			.prepare("UPDATE plaid_items SET disconnected_at = datetime('now')")
			.run();
		await answeredQuestions("2026-10-12");
		await nightSyncStatement(db, {
			brought: 3,
			on: "2026-10-13",
			ok: true,
		}).run();
		await takeBackBankStrokes(db, 999).run();
		expect(await readFirstTally(db)).toEqual({ strokes: {}, budgets: {} });
	});
});
