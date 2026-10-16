// The question page's data (P125 E, spec §8.8, decision 114): what the family's own bank shows, which pay and bills are
// still to ask, and the ledger of what they answered. A reload asks only what is still open. The ledger reads what the
// answers recorded in first_tally (each merchant's Yes deposits, in the order its merchant was first answered, and the
// bills step's kept count and total), so a change made elsewhere, in the Transactions panel or on Bills, adds no line.
// The strokes never overwrite a stroke's first day (markStroke).

import { type BillSuggestion, loadBillSuggestions } from "../bills/find";
import { matchBillPayments } from "../bills/match";
import { insertBillStatements } from "../bills/write";
import { includedSql, markedTransferSql } from "../db/counted-month";
import {
	type BillsKept,
	keptBillStatement,
	markStroke,
	type PayAnswer,
	type PayRecord,
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
	/** The transaction ids the question covers, which the answer changes. */
	ids: number[];
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
	/**
	 * The answers so far, in ledger order. `id` names the line for the reply that wrote it (`pay:` and the merchant key for
	 * a pay line, `bills` for the bills line), so a reply finds its own line even when two lines read the same.
	 */
	ledger: { id: string; text: string }[];
	/** True once the family has answered a pay question (Yes or No), so an empty pay step is not the one to say so. */
	payAnswered: boolean;
	/** The pay merchants still to ask, in order. */
	pay: PayMerchant[];
	/** The found charges that can be kept in one tap, and the ones that wait in Possible bills. */
	keep: BillSuggestion[];
	waiting: BillSuggestion[];
};

/** The money in Tally marked as income that nobody has decided, one row per deposit the pay questions cover (payAskedSql). */
const PAY_SQL = `SELECT t.id AS id, ${merchantKeySql("t")} AS key, m.display_name AS displayName, t.date AS date, -t.amount_cents AS cents
	FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
	WHERE ${payAskedSql("t")}`;

/** True when the pay question has nothing left to ask: PAY_SQL's own predicate, so the strokes' guard can't drift from the page's query. */
export const NO_PAY_LEFT_SQL = `NOT EXISTS (SELECT 1 FROM transactions t WHERE ${payAskedSql("t")})`;

type PayRow = {
	id: number;
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
			ids: [],
		};
		merchant.deposits.push({ date: row.date, cents: row.cents });
		merchant.ids.push(row.id);
		byKey.set(row.key, merchant);
	}
	return [...byKey.values()];
}

/**
 * Yes and No on a merchant's money in: each row the question showed is marked income or not, as the person's choice
 * (PERSON_INCOME_SET_SQL, the review's Yes write, which wins over Plaid and Jev, spec §6). The answer covers only the
 * deposits the page showed, which the route has checked against `merchant` (payShown): only those rows change
 * (`merchant.ids`), and the answer is recorded in the same batch, each deposit by its transaction id under the answer.
 * So a deposit that arrives between the question and the answer stays unanswered and is asked next. Returns the rows
 * changed (0 when the merchant has nothing left to ask).
 */
export async function answerPay(
	db: D1Database,
	merchant: PayMerchant,
	answer: PayAnswer,
	who: string,
): Promise<number> {
	const deposits = Object.fromEntries(
		merchant.ids.map((id, i) => [id, merchant.deposits[i] as PayDeposit]),
	);
	const [changed] = await db.batch([
		db
			.prepare(
				`UPDATE transactions SET ${PERSON_INCOME_SET_SQL} WHERE ${payAskedSql("transactions")} AND transactions.id IN (SELECT value FROM json_each(?))`,
			)
			.bind(answer === "yes" ? 1 : 0, who, JSON.stringify(merchant.ids)),
		payAnswerStatement(db, merchant.key, { [answer]: deposits }),
	]);
	return changed?.meta.changes ?? 0;
}

/** The connected banks' head lines: their names, how many bank lines, their first and last dates, and transfers still left out of the budget. */
export async function bankHead(db: D1Database): Promise<BankHead | null> {
	const banks = await db
		.prepare(
			"SELECT institution_name AS name FROM plaid_items WHERE disconnected_at IS NULL ORDER BY institution_name",
		)
		.all<{ name: string }>();
	const lines = await db
		.prepare(
			`SELECT COUNT(*) AS lines, MIN(t.date) AS first, MAX(t.date) AS last,
				COALESCE(SUM(CASE WHEN ${markedTransferSql("t")} AND NOT ${includedSql("t")} THEN 1 ELSE 0 END), 0) AS leftOut
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
 * The ledger lines of the pay answers (first_tally's `pay`), in the order each merchant was first answered: the record's
 * `at`, not the object's key order, which puts a numeric key first. A merchant answered again keeps its place.
 * "Pay · {Merchant}, …" for each merchant with a Yes, from every deposit answered Yes, as recorded with the answers, so a
 * deposit marked later in the Transactions panel adds nothing. A No adds no deposit to the line, and a merchant with only
 * No answers writes no line.
 */
async function payLedger(
	db: D1Database,
	pay: Record<string, PayRecord> | undefined,
): Promise<{ id: string; text: string }[]> {
	const yeses = Object.entries(pay ?? {})
		.filter(([, record]) => Object.keys(record.yes ?? {}).length > 0)
		.sort(([, a], [, b]) => a.at - b.at);
	if (yeses.length === 0) return [];
	const { results } = await db
		.prepare(
			"SELECT raw_name AS key, display_name AS displayName FROM merchants WHERE raw_name IN (SELECT value FROM json_each(?1))",
		)
		.bind(JSON.stringify(yeses.map(([key]) => key)))
		.all<{ key: string; displayName: string | null }>();
	const names = new Map(results.map((row) => [row.key, row.displayName]));
	return yeses.map(([key, record]) => ({
		id: `pay:${key}`,
		text: payLedgerLine({
			name: names.get(key) || tidyName(key),
			deposits: Object.values(record.yes ?? {}),
		}),
	}));
}

/** The ledger line of what the bills step kept, from its record (first_tally's `bills`), or null when nothing was kept. */
function billsLedger(
	bills: BillsKept | undefined,
): { id: string; text: string } | null {
	return bills && bills.kept > 0
		? { id: "bills", text: billsLedgerLine(bills.kept, bills.cents) }
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
 * The pay stroke waits for the last pay answer; the bills stroke waits for pay, since the page asks pay first. What the
 * bills step kept is recorded by keepBills, as each bill is kept, so this read adds no count.
 */
export async function settleAndLoad(
	db: D1Database,
	today: string,
): Promise<FirstPageModel> {
	const pay = await payMerchants(db);
	if (pay.length === 0) await markStroke(db, "pay", today, NO_PAY_LEFT_SQL);
	const split =
		pay.length === 0
			? splitKeepable(
					await loadBillSuggestions(db, today),
					await activeBillNames(db),
				)
			: { keep: [] as BillSuggestion[], waiting: [] as BillSuggestion[] };
	const done = pay.length === 0 && split.keep.length === 0;
	if (done) await markStroke(db, "bills", today, NO_PAY_LEFT_SQL);
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
 * Keeps the found charges, one tap (spec §8.8). Each bill is the Add bill write (insertBillStatements, which checks that
 * no active bill already has the name), with the record of what the step kept (keptBillStatement) between its bill
 * and its amount row, in one batch: a bill and its count land together, so a Keep that fails part-way keeps the bills
 * before it, counted, and a retry counts the rest. Then the charges those bills already paid this period are linked
 * (matchBillPayments, as the Add bill route does), so that occurrence isn't due. It runs on every Keep, not only one
 * that kept a bill: it fills only the occurrences not yet linked, so a retry after a failed link still links them
 * (after-sync also runs it). Returns how many were added and their monthly total in cents.
 */
export async function keepBills(
	db: D1Database,
	today: string,
	keep: BillSuggestion[],
): Promise<{ kept: number; cents: number }> {
	let kept = 0;
	let cents = 0;
	for (const suggestion of keep) {
		const [bill, amounts] = insertBillStatements(
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
		const [added] = await db.batch([
			bill,
			keptBillStatement(db, suggestion.amountCents),
			amounts,
		]);
		if ((added?.meta.changes ?? 0) > 0) {
			kept += 1;
			cents += suggestion.amountCents;
		}
	}
	await matchBillPayments(db, today);
	return { kept, cents };
}
