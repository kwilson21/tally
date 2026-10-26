// The question page's data (P125 E, spec §8.8, decision 114): what the family's own bank shows, which pay and bills are
// still to ask, and the ledger of what they answered. A reload asks only what is still open. The ledger reads what the
// answers recorded in first_tally (each merchant's Yes deposits, in the order its merchant was first answered, and the
// bills step's kept count and total), so a change made elsewhere, in the Transactions panel or on Bills, adds no line.
// The strokes never overwrite a stroke's first day (markStroke).

import { type BillSuggestion, loadBillSuggestions } from "../bills/find";
import { matchBillPayments } from "../bills/match";
import { insertBillStatements } from "../bills/write";
import {
	firstBudgetSuggestion,
	fullMonths,
	type MonthSpent,
	monthlyMeanCents,
} from "../budgets/first-suggestion";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedCategorySql,
	countedMonthSql,
} from "../db/counted-month";
import {
	anyQuestionAnswered,
	type BillsKept,
	type BudgetAnswer,
	type FirstTally,
	keepBudgetStatement,
	keptBillStatement,
	markStroke,
	type PayAnswer,
	type PayRecord,
	payAnswerStatement,
	readFirstTally,
	STROKES,
	strokeStatement,
} from "../db/first-tally";
import { PERSON_INCOME_SET_SQL } from "../db/income";
import { merchantKeySql } from "../db/merchant-key";
import { merchantDisplayNames } from "../db/merchant-names";
import { currentGoalSql } from "../db/savings-goals";
import { payAskedSql } from "../db/suggestions-queue";
import { needsCategoryCount } from "../db/transactions";
import { readMonthSummary } from "../month-summary";
import { tidyName } from "../transactions/tidy-name";
import { billsLedgerLine, splitKeepable } from "./bills";
import {
	type BudgetAsk,
	budgetsLedgerLine,
	type NothingAsked,
	savingsLedgerLine,
} from "./budgets";
import { type PayDeposit, payLedgerLine, shownPayValues } from "./pay";

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

export type FirstPageModel = {
	/** The strokes drawn so far, of five. */
	drawn: number;
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
	/** The budgets step (spec §8.8): null until pay and bills are done, since the page asks them first. */
	budgets: BudgetsStep | null;
	/**
	 * True once a budgets answer is recorded, a skip included (first_tally's `budgets` has an entry). A budgets screen draws
	 * the steps that asked nothing only while this is false, so the notes show on the step's first screen (P142 A, #773).
	 */
	budgetsAnswered: boolean;
	/**
	 * True while no question is answered in the record once the page has settled its own draws (anyQuestionAnswered): the
	 * check-in a page or an answer's reply keeps (decision 146). Settling draws the pay step when there is no paycheck to
	 * ask about, so that page draws no check-in.
	 */
	watching: boolean;
};

/**
 * The budgets step as the page reads it (spec §6, §8.8, #590). Once the budgets stroke is drawn the page rules off the
 * month's Safe to spend (`done`, the same number Home shows); until then it asks the categories still to answer.
 */
export type BudgetsStep =
	| {
			done: true;
			safeCents: number;
			/**
			 * Why the step asked nothing, for the line above the ruled-off total (nothingAskedReason), or null when it says
			 * nothing: a family's answer is recorded, or a category with no budget was added after the stroke.
			 */
			nothingAsked: NothingAsked | null;
	  }
	| {
			done: false;
			/** The month the answers take effect from (YYYY-MM), the current one. */
			month: string;
			/** The categories still to answer, in the household's order. */
			asks: BudgetAsk[];
			/**
			 * True when the keep all question is the one asked: some category has a suggestion, and nothing is answered yet.
			 * Otherwise one at a time asks asks[0].
			 */
			keepAllOpen: boolean;
			/** The Needs a category line: the transactions that need a category, and the monthly mean of their spending when known. */
			needs: { count: number; meanCents: number | null } | null;
			/**
			 * The history's first date the read used for its months (HISTORY_FIRST_SQL), or null when nothing is asked and no
			 * months were read. A suggested answer's write checks it is unchanged, so the window it was read from still holds.
			 */
			firstDate: string | null;
			/**
			 * Why the step asked nothing, when no category is asked and none is answered (nothingAskedReason), or null otherwise:
			 * the reason the setup screen's note under the step bar says (P142 A, #773).
			 */
			nothingAsked: NothingAsked | null;
	  };

/**
 * The history's first date (MIN(date) over every transaction). The suggestions' months come from it (fullMonths), so the
 * budgets step's read and a suggested answer's write both use this one query, and they can't drift apart.
 */
const HISTORY_FIRST_SQL = "SELECT MIN(date) AS first FROM transactions";

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
 * deposits the page showed: the UPDATE is bound to each shown deposit's id, merchant key, day and cents (shownPayValues,
 * the same values the form carries). It is all or nothing. If a sync corrected a shown deposit's day, cents or merchant
 * since the read, or nothing asks about one any more, the UPDATE changes 0 rows, so the record below writes nothing and
 * the route asks the question again. A per-row check would not be enough: the record would still store the skipped row's
 * old day, cents or merchant key. A deposit that arrives between the question and the answer is not in the snapshot, so
 * it stays unanswered and is asked next. The answer is recorded in the same batch, each deposit by its transaction id
 * under the answer. Returns the rows changed (0 when the merchant has nothing left to ask, or the shown deposits changed).
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
	const shown = `[${shownPayValues(merchant).join(",")}]`;
	const [changed] = await db.batch([
		db
			.prepare(
				`UPDATE transactions SET ${PERSON_INCOME_SET_SQL} WHERE ${payAskedSql("transactions")}
				AND transactions.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
				AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM transactions s
					WHERE s.id = json_extract(j.value, '$.id') AND s.date = json_extract(j.value, '$.date')
					AND -s.amount_cents = json_extract(j.value, '$.cents')
					AND ${merchantKeySql("s")} = json_extract(j.value, '$.key') AND ${payAskedSql("s")}))`,
			)
			.bind(answer === "yes" ? 1 : 0, who, shown, shown),
		payAnswerStatement(db, merchant.key, { [answer]: deposits }),
	]);
	return changed?.meta.changes ?? 0;
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
	const names = await merchantDisplayNames(
		db,
		yeses.map(([key]) => key),
	);
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

/**
 * The ledger line of the budgets the step kept, from its record (first_tally's `budgets`): every answer that set an
 * amount, a suggestion or another, counted and totalled. Null when none is set (a skip writes no line).
 */
function budgetsLedger(
	budgets: Record<string, BudgetAnswer> | undefined,
): { id: string; text: string } | null {
	const kept = Object.values(budgets ?? {}).filter(
		(answer) => answer.cents !== null,
	);
	if (kept.length === 0) return null;
	const cents = kept.reduce((sum, answer) => sum + (answer.cents ?? 0), 0);
	return { id: "budgets", text: budgetsLedgerLine(kept.length, cents) };
}

/**
 * The ledger line of the savings answer, from its record (first_tally's `savings`): "Savings · $300 a month" for a goal kept,
 * and null for Not now, which writes no line (decision 135).
 */
function savingsLedger(
	savings: number | "skipped" | undefined,
): { id: string; text: string } | null {
	return typeof savings === "number"
		? { id: "savings", text: savingsLedgerLine(savings) }
		: null;
}

/**
 * True when a budget applies to the category row `alias` names in `month`: one set from that month or an earlier one, since
 * a budget takes effect from its month on. `month` is code (YYYY-MM), checked here.
 */
export function budgetAppliesSql(alias: string, month: string): string {
	if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`not a month: ${month}`);
	return `EXISTS (SELECT 1 FROM budget_amounts b WHERE b.category_id = ${alias}.id AND b.effective_month <= '${month}')`;
}

/**
 * True when the category row `alias` names is still asked by the budgets step: active, with no budget that applies this
 * month, and no answer in first_tally. The step's read, the budgets stroke's guard and every answer's write all check this
 * one predicate, so they can't drift. `month` is code (YYYY-MM), checked here.
 */
export function budgetAskedSql(alias: string, month: string): string {
	return `${alias}.archived = 0
		AND NOT ${budgetAppliesSql(alias, month)}
		AND NOT EXISTS (SELECT 1 FROM household_settings h WHERE h.key = 'first_tally' AND json_type(h.value, '$.budgets."' || ${alias}.id || '"') IS NOT NULL)`;
}

/**
 * The live half of the pay and budget questions' guards, as SQL: no pay question is left (NO_PAY_LEFT_SQL, read when the
 * write runs, since a deposit can arrive after the strokes were drawn), and no category is left to ask (budgetAskedSql).
 * The budgets stroke's guard and the savings answer's guard both check it, so they can't drift apart. `month` is code (YYYY-MM).
 */
function noPayOrBudgetLeftSql(month: string): string {
	return `${NO_PAY_LEFT_SQL} AND NOT EXISTS (SELECT 1 FROM categories c WHERE ${budgetAskedSql("c", month)})`;
}

/**
 * The guard of the budgets stroke, as SQL: the pay and bills strokes are drawn, and no pay or budget question is left
 * (noPayOrBudgetLeftSql), so the stroke can't be drawn while a question is still asked. Pay is checked too, so budgets is
 * the last of the three questions drawn, and its write is the one that takes the re-ask marker away (strokeStatement).
 */
export function budgetsStrokeGuard(month: string): string {
	return `EXISTS (SELECT 1 FROM household_settings h WHERE h.key = 'first_tally' AND json_type(h.value, '$.strokes.pay') IS NOT NULL AND json_type(h.value, '$.strokes.bills') IS NOT NULL)
		AND ${noPayOrBudgetLeftSql(month)}
		AND (EXISTS (SELECT 1 FROM household_settings h WHERE h.key = 'first_tally' AND json_type(h.value, '$.savings') IS NOT NULL) OR ${currentGoalSql(month)} IS NOT NULL)`;
}

/**
 * The record's side of the savings question, as SQL on the record's JSON (decision 135, #721): pay and bills are drawn,
 * budgets isn't, and no savings answer is kept yet. Each savings write checks it, with noPayOrBudgetLeftSql.
 */
const SAVINGS_RECORD_SQL = `json_type(value, '$.strokes.pay') IS NOT NULL AND json_type(value, '$.strokes.bills') IS NOT NULL
	AND json_type(value, '$.strokes.budgets') IS NULL AND json_type(value, '$.savings') IS NULL`;

/**
 * The savings question is open: its record side (SAVINGS_RECORD_SQL), and no pay or budget question is left
 * (noPayOrBudgetLeftSql). A pay deposit that arrives after the page's read is caught here, in the write's own statement.
 */
function savingsOpenSql(month: string): string {
	return `${SAVINGS_RECORD_SQL} AND ${noPayOrBudgetLeftSql(month)}`;
}

/**
 * True while the record has no savings answer and its budgets stroke isn't drawn. The savings route reads this before its
 * writes, and only the writes check the pay and category questions, so a category added since the page drew gets its own
 * words, and an answer already kept gets the page as it is now.
 */
export async function savingsOpen(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT EXISTS (SELECT 1 FROM household_settings WHERE key = 'first_tally' AND ${SAVINGS_RECORD_SQL}) AS open`,
		)
		.first<{ open: number }>();
	return row?.open === 1;
}

/**
 * The record's copy of a current goal above $0 (decision 135, #721): the goal's cents become `savings` while the question is
 * open. With no goal above $0 it writes nothing, so the question still asks. It runs before the budgets stroke, in the same
 * batch wherever the stroke is drawn on a goal, so the stroke's guard sees the answer.
 */
export function savingsCopyStatement(
	db: D1Database,
	month: string,
): D1PreparedStatement {
	return db.prepare(
		`UPDATE household_settings SET value = json_set(value, '$.savings', ${currentGoalSql(month)})
		WHERE key = 'first_tally' AND ${savingsOpenSql(month)} AND ${currentGoalSql(month)} IS NOT NULL`,
	);
}

/**
 * The record's write of the savings answer (decision 135, #721): Save it's cents, or "skipped" for Not now, as `savings`,
 * while the question is open. COALESCE keeps a goal above $0 that Home set since the page drew in its place, so the record
 * always holds the goal the table holds. It is the first write of the answer's batch: the goal's write checks that it
 * landed (changes()), so a stale answer writes no goal.
 */
export function savingsAnswerStatement(
	db: D1Database,
	month: string,
	answer: number | "skipped",
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.savings', COALESCE(${currentGoalSql(month)}, ?1))
			WHERE key = 'first_tally' AND ${savingsOpenSql(month)}`,
		)
		.bind(answer);
}

/**
 * Spent per category per month over the given months, in one read: each row is a category (null for spending with no
 * category), a month, and its counted cents. Counted spending is what Home's budget rows count (spec §6), so a refund
 * counts in its purchase's month, as Home does.
 */
async function monthlySpent(
	db: D1Database,
	months: string[],
): Promise<{ categoryId: number | null; month: string; cents: number }[]> {
	const first = months[0];
	const last = months[months.length - 1];
	if (first === undefined || last === undefined) return [];
	const { results } = await db
		.prepare(
			`SELECT ${countedCategorySql()} AS categoryId, ${countedMonthSql()} AS month, SUM(t.amount_cents) AS cents
			FROM transactions t ${COUNTED_JOINS}
			WHERE ${COUNTED_SPENDING} AND ${countedMonthSql()} BETWEEN ?1 AND ?2
			GROUP BY categoryId, month`,
		)
		.bind(first, last)
		.all<{ categoryId: number | null; month: string; cents: number }>();
	return results;
}

/**
 * Why a drawn budgets step asked nothing, or null when its line says nothing. A recorded answer means the family set the
 * step's budgets itself, so none is "already" there. Otherwise the active categories are counted against the budgets that
 * apply this month: none active is "no-categories", and all of them budgeted is "every-category-budgeted". Any other count
 * (a category added since the stroke) says nothing.
 */
async function nothingAskedReason(
	db: D1Database,
	month: string,
	record: FirstTally | null,
): Promise<NothingAsked | null> {
	if (Object.keys(record?.budgets ?? {}).length > 0) return null;
	const counts = await db
		.prepare(
			`SELECT COUNT(*) AS active, COALESCE(SUM(CASE WHEN ${budgetAppliesSql("c", month)} THEN 1 ELSE 0 END), 0) AS budgeted
			FROM categories c WHERE c.archived = 0`,
		)
		.first<{ active: number; budgeted: number }>();
	if (!counts) return null;
	if (counts.active === 0) return "no-categories";
	return counts.budgeted === counts.active ? "every-category-budgeted" : null;
}

/**
 * The budgets step, read from the household. The categories it may ask are the active ones with no budget that applies
 * this month and no answer in first_tally, in the household's order. Each is given its full months of Spent (fullMonths
 * from the history's first date, a month with no spending is $0) and Tally's suggestion (firstBudgetSuggestion). The
 * keep all question is offered while nothing is answered and some category has a suggestion; otherwise one at a time
 * asks the first category not yet answered. The Needs a category line counts the transactions with no category, and
 * takes the monthly mean of their spending over the same months.
 */
async function budgetsStep(
	db: D1Database,
	today: string,
	record: FirstTally | null,
	oneAtATime: boolean,
): Promise<BudgetsStep> {
	const month = today.slice(0, 7);
	if (record?.strokes.budgets !== undefined) {
		const { summary } = await readMonthSummary(db, today, month);
		return {
			done: true,
			safeCents: summary.safeToSpendCents,
			nothingAsked: await nothingAskedReason(db, month, record),
		};
	}
	const { results: categories } = await db
		.prepare(
			`SELECT c.id AS id, c.name AS name, c.icon AS icon, c.color AS color FROM categories c WHERE ${budgetAskedSql("c", month)}
			ORDER BY c.sort_order, c.id`,
		)
		.all<{ id: number; name: string; icon: string; color: string }>();
	if (categories.length === 0)
		return {
			done: false,
			month,
			asks: [],
			keepAllOpen: false,
			needs: null,
			firstDate: null,
			nothingAsked: await nothingAskedReason(db, month, record),
		};
	const first = await db
		.prepare(HISTORY_FIRST_SQL)
		.first<{ first: string | null }>();
	const firstDate = first?.first ?? null;
	const months = fullMonths(firstDate, today);
	const spent = new Map<string, number>();
	for (const row of await monthlySpent(db, months))
		spent.set(`${row.categoryId}|${row.month}`, row.cents);
	const monthsOf = (categoryId: number | null): MonthSpent[] =>
		months.map((m) => ({
			month: m,
			spentCents: spent.get(`${categoryId}|${m}`) ?? 0,
		}));
	const asks: BudgetAsk[] = categories.map((category) => {
		const monthsSpent = monthsOf(category.id);
		return {
			id: category.id,
			name: category.name,
			icon: category.icon,
			color: category.color,
			months: monthsSpent,
			suggestion: firstBudgetSuggestion(monthsSpent),
		};
	});
	const keepAllOpen =
		!oneAtATime &&
		Object.keys(record?.budgets ?? {}).length === 0 &&
		asks.some((ask) => ask.suggestion !== null);
	const count = await needsCategoryCount(db, "all");
	const needs =
		count > 0 ? { count, meanCents: monthlyMeanCents(monthsOf(null)) } : null;
	// asks is never empty here (an empty step returned above), so the step asked something and has no reason to give.
	return {
		done: false,
		month,
		asks,
		keepAllOpen,
		needs,
		firstDate,
		nothingAsked: null,
	};
}

/**
 * A budget answer's write, for its batch: the budget from this month on, written only while its category is still asked
 * (budgetAskedSql). A suggested amount (a Yes, or a keep all's) is written only while it is still the amount the page
 * showed, and the window it was read from is unchanged: the history's first date is still `firstDate` (HISTORY_FIRST_SQL,
 * bound from the read), and the category's counted spending over the months the read used (`first` to `last`, bound from
 * the read, not recomputed) must round up to it, ceil(total / (n * 1000)) * 1000 = shown. That is, with total > 0,
 * (shown - 1000) * n < total <= shown * n, in integers, with n the month count as an integer literal (no division). The
 * spending is the one monthlySpent counts. The write's own changes say whether it landed.
 */
function budgetWriteStatement(
	db: D1Database,
	ask: BudgetAsk,
	answer: Extract<BudgetAnswer, { cents: number }>,
	month: string,
	firstDate: string | null,
): D1PreparedStatement {
	const asked = `EXISTS (SELECT 1 FROM categories c WHERE c.id = ?1 AND ${budgetAskedSql("c", month)})`;
	const upsert =
		"ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents";
	if (answer.kind === "another")
		return db
			.prepare(
				`INSERT INTO budget_amounts (category_id, effective_month, amount_cents) SELECT ?1, ?2, ?3 WHERE ${asked}
			${upsert}`,
			)
			.bind(ask.id, month, answer.cents);
	const n = Math.trunc(ask.months.length);
	const total = `SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM transactions t ${COUNTED_JOINS}
		WHERE ${COUNTED_SPENDING} AND ${countedCategorySql()} = ?1 AND ${countedMonthSql()} BETWEEN ?4 AND ?5`;
	return db
		.prepare(
			`INSERT INTO budget_amounts (category_id, effective_month, amount_cents) SELECT ?1, ?2, ?3 WHERE ${asked}
			AND (${HISTORY_FIRST_SQL}) IS ?6
			AND EXISTS (SELECT 1 FROM (${total}) s WHERE s.total > 0 AND (?3 - 1000) * ${n} < s.total AND s.total <= ?3 * ${n})
			${upsert}`,
		)
		.bind(
			ask.id,
			month,
			answer.cents,
			ask.months[0]?.month ?? "",
			ask.months[ask.months.length - 1]?.month ?? "",
			firstDate,
		);
}

/**
 * Writes budget answers in one batch (spec §8.8). Each answer is checked where it is written, against what is still asked
 * (budgetWriteStatement, keepBudgetStatement), so a Home budget, a sync or a competing answer since the page drew changes
 * nothing it would overwrite. A set amount is its budget, then its record, which lands only when the budget did
 * (`changes() > 0`); a skip is its record alone, guarded by the same predicate. Then the budgets stroke, under its guard,
 * so the stroke is drawn in the same write as the last answer, and never before it. `firstDate` is the history's first date
 * the step's read used (BudgetsStep.firstDate), which a suggested answer's write checks. Returns the ids of the categories
 * whose answer landed.
 */
export async function keepBudgetAnswers(
	db: D1Database,
	today: string,
	firstDate: string | null,
	answers: { ask: BudgetAsk; answer: BudgetAnswer }[],
): Promise<number[]> {
	const month = today.slice(0, 7);
	const statements: D1PreparedStatement[] = [];
	// Each answer's landing: the index of the statement whose changes say whether the answer landed.
	const landings: { id: number; at: number }[] = [];
	for (const { ask, answer } of answers) {
		landings.push({ id: ask.id, at: statements.length });
		if (answer.cents === null) {
			statements.push(
				keepBudgetStatement(
					db,
					ask.id,
					answer,
					`EXISTS (SELECT 1 FROM categories c WHERE c.id = ?2 AND ${budgetAskedSql("c", month)})`,
				),
			);
		} else {
			statements.push(
				budgetWriteStatement(db, ask, answer, month, firstDate),
				keepBudgetStatement(db, ask.id, answer, "changes() > 0"),
			);
		}
	}
	// A current goal above $0 answers the savings question (decision 135): it is copied before the stroke, so its guard sees it.
	statements.push(
		savingsCopyStatement(db, month),
		strokeStatement(db, "budgets", today, budgetsStrokeGuard(month)),
	);
	const results = await db.batch(statements);
	return landings
		.filter(({ at }) => (results[at]?.meta.changes ?? 0) > 0)
		.map(({ id }) => id);
}

/** The active bills' names, which a found charge can't share (spec §8.5). */
async function activeBillNames(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT name FROM bills WHERE active = 1")
		.all<{ name: string }>();
	return results.map((row) => row.name);
}

/**
 * The pay and bills steps as the page reads them, with no writes: the pay merchants still to ask, the charges to keep and
 * the ones that wait, and `done` once neither step has anything left to ask. The page asks pay first, then bills.
 */
async function payAndBills(db: D1Database, today: string) {
	const pay = await payMerchants(db);
	const split =
		pay.length === 0
			? splitKeepable(
					await loadBillSuggestions(db, today),
					await activeBillNames(db),
				)
			: { keep: [] as BillSuggestion[], waiting: [] as BillSuggestion[] };
	return { pay, split, done: pay.length === 0 && split.keep.length === 0 };
}

/**
 * True when the budgets step is the one the page shows: pay and bills have nothing left to ask (payAndBills). It reads only,
 * so a goal Home set after the page drew isn't copied and drawn here; the savings answer's own write keeps that goal (#721).
 */
export async function budgetsStepShown(
	db: D1Database,
	today: string,
): Promise<boolean> {
	return (await payAndBills(db, today)).done;
}

/**
 * Draws the strokes whose steps have nothing left to ask (an empty step counts as done, P125 E), then reads the page.
 * The pay stroke waits for the last pay answer; the bills stroke waits for pay, since the page asks pay first. What the
 * bills step kept is recorded by keepBills, as each bill is kept, so this read adds no count.
 */
export async function settleAndLoad(
	db: D1Database,
	today: string,
	{ oneAtATime = false }: { oneAtATime?: boolean } = {},
): Promise<FirstPageModel> {
	const { pay, split, done } = await payAndBills(db, today);
	if (pay.length === 0) await markStroke(db, "pay", today, NO_PAY_LEFT_SQL);
	if (done) await markStroke(db, "bills", today, NO_PAY_LEFT_SQL);
	// The budgets stroke waits for the bills stroke (budgetsStrokeGuard), and is drawn when no budget question is left and the
	// savings question is answered, or a goal above $0 answers it. The goal's copy and the stroke are one batch, so the
	// stroke's guard reads the copy and no other write lands between them (decision 135).
	if (done) {
		const month = today.slice(0, 7);
		await db.batch([
			savingsCopyStatement(db, month),
			strokeStatement(db, "budgets", today, budgetsStrokeGuard(month)),
		]);
	}
	const record = await readFirstTally(db);
	const payLines = await payLedger(db, record?.pay);
	const billLine = billsLedger(record?.bills);
	const budgetLine = budgetsLedger(record?.budgets);
	const savingsLine = savingsLedger(record?.savings);
	const ledger = [
		...payLines,
		...(billLine ? [billLine] : []),
		...(budgetLine ? [budgetLine] : []),
		...(savingsLine ? [savingsLine] : []),
	];
	return {
		drawn: STROKES.filter((stroke) => record?.strokes[stroke] !== undefined)
			.length,
		ledger,
		payAnswered: Object.keys(record?.pay ?? {}).length > 0,
		pay,
		keep: split.keep,
		waiting: split.waiting,
		budgets: done ? await budgetsStep(db, today, record, oneAtATime) : null,
		budgetsAnswered: Object.keys(record?.budgets ?? {}).length > 0,
		watching: !anyQuestionAnswered(record),
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
