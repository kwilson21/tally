// The question page's data (P125 E, spec §8.8, decision 114): what the family's own bank shows, which pay and bills are
// still to ask, and the ledger of what they answered. A reload asks only what is still open. The ledger reads what the
// answers recorded in first_tally (each pay answer, and the bills step's kept count and total) and the deposits a Yes
// marked, so a change made elsewhere, in the Transactions panel or on Bills, adds no line. The strokes never overwrite a
// stroke's first day (markStroke, keepBillsStep).

import { type BillSuggestion, loadBillSuggestions } from "../bills/find";
import { matchBillPayments } from "../bills/match";
import { insertBill } from "../bills/write";
import { markedTransferSql } from "../db/counted-month";
import {
	type BillsKept,
	keepBillsStep,
	markStroke,
	type PayAnswer,
	payAnswerStatement,
	readFirstTally,
	STROKES,
} from "../db/first-tally";
import { PERSON_INCOME_SET_SQL } from "../db/income";
import { merchantKeySql } from "../db/merchant-key";
import { payAskedSql } from "../db/suggestions-queue";
import { tidyName } from "../transactions/tidy-name";
import { billsLedgerLine, splitKeepable } from "./bills";
import { type PayDeposit, payLedgerLine } from "./pay";

/** A merchant whose money in Tally marked as income, and the deposits behind the question. */
export type PayMerchant = {
	/** The merchant key: the store's raw name, which the answer is given for. */
	key: string;
	/** The name the family sees: the merchant's own name, or its key tidied. */
	name: string;
	deposits: PayDeposit[];
};

/** The connected banks' lines, before any answer: the head lines (spec §8.8, the first page's muted lines). */
export type BankHead = {
	banks: string;
	lines: number;
	first: string;
	last: string;
	left: number;
};

export type FirstPageModel = {
	/** The strokes drawn so far, of five. */
	drawn: number;
	head: BankHead | null;
	/** The answers so far, in ledger order. */
	ledger: string[];
	/** True once the family has answered a pay question (Yes or No), so an empty pay step is not the one to say so. */
	payAnswered: boolean;
	/** The pay merchants still to ask, in order. */
	pay: PayMerchant[];
	/** The found charges that can be kept in one tap, and the ones that wait in Possible bills. */
	keep: BillSuggestion[];
	waiting: BillSuggestion[];
};

/** The money in Tally marked as income that nobody has decided, one row per deposit the pay questions cover (payAskedSql). */
const PAY_SQL = `SELECT ${merchantKeySql("t")} AS key, m.display_name AS displayName, t.date AS date, -t.amount_cents AS cents
	FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
	WHERE ${payAskedSql("t")}`;

type PayRow = {
	key: string;
	displayName: string | null;
	date: string;
	cents: number;
};

/** The pay merchants still to ask, one per merchant, in key order. */
export async function payMerchants(db: D1Database): Promise<PayMerchant[]> {
	const { results } = await db
		.prepare(`${PAY_SQL} ORDER BY key, t.date`)
		.all<PayRow>();
	const byKey = new Map<string, PayMerchant>();
	for (const row of results) {
		const merchant = byKey.get(row.key) ?? {
			key: row.key,
			name: row.displayName || tidyName(row.key),
			deposits: [],
		};
		merchant.deposits.push({ date: row.date, cents: row.cents });
		byKey.set(row.key, merchant);
	}
	return [...byKey.values()];
}

/**
 * Yes and No on a merchant's money in: each row the question covers is marked income or not, as the person's choice
 * (PERSON_INCOME_SET_SQL, the review's Yes write, which wins over Plaid and Jev, spec §6). The answer is recorded in the
 * same batch. Returns the rows changed (0 when the merchant has nothing left to ask).
 */
export async function answerPay(
	db: D1Database,
	key: string,
	answer: PayAnswer,
	who: string,
): Promise<number> {
	const [changed] = await db.batch([
		db
			.prepare(
				`UPDATE transactions SET ${PERSON_INCOME_SET_SQL} WHERE ${payAskedSql("transactions")} AND ${merchantKeySql("transactions")} = ?`,
			)
			.bind(answer === "yes" ? 1 : 0, who, key),
		payAnswerStatement(db, key, answer),
	]);
	return changed?.meta.changes ?? 0;
}

/** The connected banks' head lines: their names, how many bank lines, their first and last dates, and transfers left out. */
export async function bankHead(db: D1Database): Promise<BankHead | null> {
	const banks = await db
		.prepare(
			"SELECT institution_name AS name FROM plaid_items WHERE disconnected_at IS NULL ORDER BY institution_name",
		)
		.all<{ name: string }>();
	const lines = await db
		.prepare(
			`SELECT COUNT(*) AS lines, MIN(t.date) AS first, MAX(t.date) AS last,
				COALESCE(SUM(CASE WHEN ${markedTransferSql("t")} THEN 1 ELSE 0 END), 0) AS leftOut
			FROM transactions t JOIN accounts a ON a.id = t.account_id
			JOIN plaid_items p ON p.id = a.plaid_item_id
			WHERE p.disconnected_at IS NULL AND t.parent_id IS NULL`,
		)
		.first<{
			lines: number;
			first: string | null;
			last: string | null;
			leftOut: number;
		}>();
	if (!lines || lines.lines === 0 || !lines.first || !lines.last) return null;
	return {
		banks: banks.results.map((bank) => bank.name).join(", "),
		lines: lines.lines,
		first: lines.first,
		last: lines.last,
		left: lines.leftOut,
	};
}

/**
 * The ledger lines of the pay answers the page recorded (first_tally's `pay`), in answer order: "Pay · {Merchant}, …" for
 * a Yes, from the deposits that Yes marked income, and "Not pay · {Merchant}" for a No. A money-in row that a
 * Transactions-panel review or a split part marked is not an answer, so it adds no line.
 */
async function payLedger(
	db: D1Database,
	pay: Record<string, PayAnswer> | undefined,
): Promise<string[]> {
	const answers = Object.entries(pay ?? {});
	if (answers.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS key, m.display_name AS displayName, t.date AS date,
				t.flag_income AS flag, -t.amount_cents AS cents
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
			WHERE t.amount_cents < 0 AND t.excluded = 0 AND t.is_split = 0 AND t.parent_id IS NULL
			AND t.refund_of_id IS NULL AND t.income_source = 'user' AND ${merchantKeySql("t")} IN (SELECT value FROM json_each(?1))
			ORDER BY key, t.date`,
		)
		.bind(JSON.stringify(answers.map(([key]) => key)))
		.all<PayRow & { flag: number }>();
	const byKey = new Map<string, { name: string; yes: PayDeposit[] }>();
	for (const row of results) {
		const entry = byKey.get(row.key) ?? {
			name: row.displayName || tidyName(row.key),
			yes: [],
		};
		if (row.flag === 1) entry.yes.push({ date: row.date, cents: row.cents });
		byKey.set(row.key, entry);
	}
	return answers.flatMap(([key, answer]) => {
		const entry = byKey.get(key);
		const name = entry?.name ?? tidyName(key);
		if (answer === "no") return [`Not pay · ${name}`];
		return entry && entry.yes.length > 0
			? [payLedgerLine({ name, deposits: entry.yes })]
			: [];
	});
}

/** The ledger line of what the bills step kept, from its record (first_tally's `bills`), or null when nothing was kept. */
function billsLedger(bills: BillsKept | undefined): string | null {
	return bills && bills.kept > 0
		? billsLedgerLine(bills.kept, bills.cents)
		: null;
}

/** The active bills' names, which a found charge can't share (spec §8.5). */
async function activeBillNames(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT name FROM bills WHERE active = 1")
		.all<{ name: string }>();
	return results.map((row) => row.name);
}

/**
 * Draws the strokes whose steps have nothing left to ask (an empty step counts as done, P125 E), then reads the page.
 * The pay stroke waits for the last pay answer; the bills stroke waits for pay, since the page asks pay first. `kept` is
 * what the Keep just before this read kept: the bills stroke's write records it (keepBillsStep).
 */
export async function settleAndLoad(
	db: D1Database,
	today: string,
	kept: BillsKept = { kept: 0, cents: 0 },
): Promise<FirstPageModel> {
	const pay = await payMerchants(db);
	if (pay.length === 0) await markStroke(db, "pay", today);
	const split =
		pay.length === 0
			? splitKeepable(
					await loadBillSuggestions(db, today),
					await activeBillNames(db),
				)
			: { keep: [] as BillSuggestion[], waiting: [] as BillSuggestion[] };
	const done = pay.length === 0 && split.keep.length === 0;
	if (done || kept.kept > 0)
		await keepBillsStep(db, kept, done ? today : undefined);
	const record = await readFirstTally(db);
	const payLines = await payLedger(db, record?.pay);
	const billLine = billsLedger(record?.bills);
	const ledger = billLine ? [...payLines, billLine] : payLines;
	const head = ledger.length === 0 ? await bankHead(db) : null;
	return {
		drawn: STROKES.filter((stroke) => record?.strokes[stroke] !== undefined)
			.length,
		head,
		ledger,
		payAnswered: Object.keys(record?.pay ?? {}).length > 0,
		pay,
		keep: split.keep,
		waiting: split.waiting,
	};
}

/**
 * Keeps the found charges, one tap (spec §8.8): each goes through insertBill, the Add bill write, which checks that no
 * active bill already has the name. Then the charges those bills already paid this period are linked (matchBillPayments,
 * as the Add bill route does), so that occurrence isn't due. Returns how many were added and their monthly total in cents.
 */
export async function keepBills(
	db: D1Database,
	today: string,
	keep: BillSuggestion[],
): Promise<{ kept: number; cents: number }> {
	let kept = 0;
	let cents = 0;
	for (const suggestion of keep) {
		const added = await insertBill(
			db,
			{
				name: suggestion.displayName,
				amountCents: suggestion.amountCents,
				dueDay: suggestion.dueDay,
				frequency: "monthly",
				anchorMonth: null,
				categoryId: suggestion.categoryId as number,
				merchantRawName: suggestion.rawName,
			},
			today,
		);
		if (added) {
			kept += 1;
			cents += suggestion.amountCents;
		}
	}
	if (kept > 0) await matchBillPayments(db, today);
	return { kept, cents };
}
