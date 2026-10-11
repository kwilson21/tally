// What AI did this month (spec §5 and §8.6, decisions 91 and 101): the log of what Tally's AI applied,
// written when it applies it, and the tally read back from it. Code does all the counting; no AI is
// called here. The log has no amounts, and a person's later change is never written: "you changed" is
// read from the transaction as it stands (`category_source`).
import { monthsBefore } from "../dates";

/** One month's counts for the tally (spec §8.6). `changed` is the categories a person changed. */
export type AiTallyCounts = {
	/** The month the counts are for, 'YYYY-MM': this month, or last month until this one has any work. */
	month: string;
	/** Transactions Tally gave a category. */
	sorted: number;
	/** Of those, the ones a person changed later, by a pick or an Always rule (never a bill's category). */
	changed: number;
	/** Merchant names Tally guessed that a person kept. */
	named: number;
	/** Paychecks (income) Tally marked. */
	paychecks: number;
};

/**
 * The tally for the household's month, read from the log (spec §8.6). Until this month has any work,
 * it shows last month's, labelled with that month; a month with no work at all shows this month's zeros.
 * One grouped read covers both months, and the changed count joins each category row to its transaction.
 */
export async function readAiTally(
	db: D1Database,
	today: string,
): Promise<AiTallyCounts> {
	const thisMonth = today.slice(0, 7);
	const lastMonth = monthsBefore(thisMonth, 1);
	const { results } = await db
		.prepare(
			`SELECT substr(l.household_day, 1, 7) AS month, l.kind AS kind, COUNT(*) AS total,
				SUM(CASE WHEN t.category_source IN ('user', 'merchant_rule') THEN 1 ELSE 0 END) AS changed
			 FROM ai_log l
			 LEFT JOIN transactions t ON t.id = l.transaction_id AND l.kind = 'category'
			 WHERE substr(l.household_day, 1, 7) IN (?, ?)
			 GROUP BY substr(l.household_day, 1, 7), l.kind`,
		)
		.bind(thisMonth, lastMonth)
		.all<{ month: string; kind: string; total: number; changed: number }>();
	const rows = (month: string) => results.filter((row) => row.month === month);
	const total = (month: string) =>
		rows(month).reduce((sum, row) => sum + row.total, 0);
	const month =
		total(thisMonth) > 0 || total(lastMonth) === 0 ? thisMonth : lastMonth;
	const count = (kind: string) =>
		rows(month)
			.filter((row) => row.kind === kind)
			.reduce((sum, row) => sum + row.total, 0);
	return {
		month,
		sorted: count("category"),
		changed: rows(month)
			.filter((row) => row.kind === "category")
			.reduce((sum, row) => sum + (row.changed ?? 0), 0),
		named: count("name"),
		paychecks: count("income"),
	};
}

/**
 * Logs what one Jev run applied (spec §8.6), in one statement per kind, after its answers are saved:
 * each transaction that now has Jev's category, and each that now has Jev's income. A row is written only
 * while the answer is still in place, so a person's choice made meanwhile is never counted, and a row
 * that is already logged is ignored (the unique indexes), so a repeat run writes nothing twice.
 */
export async function recordJevAnswers(
	db: D1Database,
	day: string,
	{ categories, incomes }: { categories: number[]; incomes: number[] },
): Promise<void> {
	const statements: D1PreparedStatement[] = [];
	if (categories.length > 0)
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO ai_log (kind, transaction_id, household_day)
					 SELECT 'category', t.id, ? FROM transactions t
					 WHERE t.id IN (SELECT value FROM json_each(?)) AND t.category_source = 'jev'`,
				)
				.bind(day, JSON.stringify(categories)),
		);
	if (incomes.length > 0)
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO ai_log (kind, transaction_id, household_day)
					 SELECT 'income', t.id, ? FROM transactions t
					 WHERE t.id IN (SELECT value FROM json_each(?)) AND t.income_source = 'jev'`,
				)
				.bind(day, JSON.stringify(incomes)),
		);
	if (statements.length > 0) await db.batch(statements);
}

/**
 * The log row for a name Tally guessed that a person is keeping (spec §8.6): parameters are the day, the
 * merchant's key and the name. It is written before the save that settles the suggestion, and only while
 * the suggestion is still pending and the name is one of its suggestions. Callers check first that the
 * name is Tally's guess and not the bank's (`nameSource`). A merchant is counted once.
 */
export const KEPT_NAME_LOG_SQL = `INSERT OR IGNORE INTO ai_log (kind, merchant_raw_name, household_day)
	SELECT 'name', m.raw_name, ? FROM merchants m
	WHERE m.raw_name = ? AND m.suggestion_status = 'pending' AND m.display_name IS NULL
		AND instr(char(10) || COALESCE(m.suggested_name, '') || char(10), char(10) || ? || char(10)) > 0`;
