// The question page's data (P125 E, spec §8.8, decision 114): what the family's own bank shows, which pay and bills are
// still to ask, and the ledger of what they answered. Nothing about an answer is stored apart from the transactions and
// bills it changed, so a reload asks only what is still open. The strokes are drawn with markStroke, which never
// overwrites a stroke's first day.
import { type BillSuggestion, loadBillSuggestions } from "../bills/find";
import { insertBill } from "../bills/write";
import { markedTransferSql } from "../db/counted-month";
import { markStroke, readFirstTally, STROKES } from "../db/first-tally";
import { maybeIncomeConfidenceSql, personChoseIncomeSql } from "../db/income";
import { merchantKeySql } from "../db/merchant-key";
import { unsureSql } from "../db/suggestions-queue";
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

/**
 * The money in Tally marked as income that nobody has answered (a Maybe income included, #583): the rows the Yes and No
 * write, so an answered merchant has no rows left to ask about.
 */
const PAY_SQL = `SELECT ${merchantKeySql("t")} AS key, m.display_name AS displayName, t.date AS date, -t.amount_cents AS cents
	FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
	WHERE t.amount_cents < 0 AND t.excluded = 0 AND t.is_split = 0 AND t.flag_transfer = 0
	AND (t.flag_income = 1 OR ${unsureSql(maybeIncomeConfidenceSql("t"))})
	AND COALESCE(${personChoseIncomeSql("t")}, 0) = 0`;

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
 * Yes and No on a merchant's money in: each row that the question covers is marked income or not, as the person's
 * choice (`income_source` = 'user', which wins over Plaid and Jev, spec §6). Returns the rows changed (0 when the
 * merchant has nothing left to ask, so a stale answer changes nothing).
 */
export async function answerPay(
	db: D1Database,
	key: string,
	answer: "yes" | "no",
	who: string,
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE transactions SET flag_income = ?1, income_source = 'user',
				updated_by = ?2, updated_at = datetime('now')
			WHERE amount_cents < 0 AND excluded = 0 AND is_split = 0 AND flag_transfer = 0
			AND ${merchantKeySql("transactions")} = ?3
			AND (flag_income = 1 OR ${unsureSql(maybeIncomeConfidenceSql("transactions"))})
			AND COALESCE(${personChoseIncomeSql("transactions")}, 0) = 0`,
		)
		.bind(answer === "yes" ? 1 : 0, who, key)
		.run();
	return result.meta.changes;
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
			WHERE p.disconnected_at IS NULL AND t.is_split = 0`,
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

/** The ledger lines of the pay answers: each money-in merchant the family marked, as a pay line (Yes) or Not pay (No). */
async function payLedger(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS key, m.display_name AS displayName, t.date AS date,
				t.flag_income AS flag, -t.amount_cents AS cents
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
			WHERE t.amount_cents < 0 AND t.excluded = 0 AND t.is_split = 0 AND t.income_source = 'user'
			ORDER BY key, t.date`,
		)
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
	return [...byKey.values()].map((entry) =>
		entry.yes.length > 0
			? payLedgerLine({ name: entry.name, deposits: entry.yes })
			: `Not pay · ${entry.name}`,
	);
}

/** The ledger line of the bills kept on the day the bills stroke was drawn, or null before it has a day. */
async function billsLedger(
	db: D1Database,
	day: string | null,
): Promise<string | null> {
	if (!day) return null;
	const kept = await db
		.prepare(
			"SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM bills WHERE active = 1 AND added_on = ?",
		)
		.bind(day)
		.first<{ n: number; cents: number }>();
	return kept && kept.n > 0 ? billsLedgerLine(kept.n, kept.cents) : null;
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
 * The pay stroke waits for the last pay answer; the bills stroke waits for pay, since the page asks pay first.
 */
export async function settleAndLoad(
	db: D1Database,
	today: string,
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
	if (pay.length === 0 && split.keep.length === 0)
		await markStroke(db, "bills", today);
	const record = await readFirstTally(db);
	const payLines = await payLedger(db);
	const ledger = [...payLines];
	const billLine = await billsLedger(db, record?.strokes.bills ?? null);
	if (billLine) ledger.push(billLine);
	const head = ledger.length === 0 ? await bankHead(db) : null;
	return {
		drawn: STROKES.filter((stroke) => record?.strokes[stroke] !== undefined)
			.length,
		head,
		ledger,
		payAnswered: payLines.length > 0,
		pay,
		keep: split.keep,
		waiting: split.waiting,
	};
}

/**
 * Keeps the found charges, one tap (spec §8.8): each goes through insertBill, the Add bill write, so the bill's name and
 * amount are checked there too. Returns how many were added and their monthly total in cents.
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
	return { kept, cents };
}
