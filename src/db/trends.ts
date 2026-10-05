// What the Trends page reads (spec §8.3). Spending is counted exactly as Home counts it: the same
// counted-month SQL (src/db/counted-month.ts), here grouped by month and category instead of one month.
import type { BudgetAmount } from "../budget";
import { monthsBefore } from "../dates";
import {
	type MonthSpend,
	sameDays,
	TREND_MONTHS,
	type TrendCategory,
	type TrendsInput,
} from "../trends";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedCategorySql,
	countedMonthSql,
} from "./counted-month";

const COUNTED_MONTH = countedMonthSql();
const COUNTED_CATEGORY = countedCategorySql();

/**
 * The rows Trends builds from, for the household's `today` (YYYY-MM-DD): counted spending by the
 * month it counts in and its category for the six months ending with this one, last month's
 * counted spending dated on days 1 to today's day-of-month, and the categories and budgets.
 */
export async function loadTrends(
	db: D1Database,
	today: string,
): Promise<TrendsInput> {
	const days = sameDays(today);
	const from = monthsBefore(days.month, TREND_MONTHS - 1);
	// db.batch()'s return type is D1Result[], so the destructured elements are possibly undefined to
	// noUncheckedIndexedAccess; the list below guarantees all five.
	const [categories, amounts, spend, same, first] = (await db.batch([
		db.prepare(
			"SELECT id, name, icon, color, archived FROM categories ORDER BY sort_order, name",
		),
		db.prepare(
			"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts",
		),
		db
			.prepare(
				`SELECT ${COUNTED_MONTH} AS month, ${COUNTED_CATEGORY} AS categoryId, SUM(t.amount_cents) AS cents
				 FROM transactions t
				 ${COUNTED_JOINS}
				 WHERE ${COUNTED_SPENDING} AND ${COUNTED_MONTH} BETWEEN ?1 AND ?2
				 GROUP BY month, categoryId`,
			)
			.bind(from, days.month),
		// Last month's days by the date a transaction is dated: one that counts in last month but is
		// dated this month (a late bill's payment) wasn't spent by this time last month.
		db
			.prepare(
				`SELECT ${COUNTED_CATEGORY} AS categoryId, SUM(t.amount_cents) AS cents
				 FROM transactions t
				 ${COUNTED_JOINS}
				 WHERE ${COUNTED_SPENDING} AND ${COUNTED_MONTH} = ?1 AND t.date >= ?2 AND t.date <= ?3
				 GROUP BY categoryId`,
			)
			.bind(days.lastMonth, `${days.lastMonth}-01`, days.lastThrough),
		db.prepare("SELECT MIN(date) AS first FROM transactions"),
	])) as [D1Result, D1Result, D1Result, D1Result, D1Result];

	return {
		today,
		firstDate:
			(first.results[0] as { first: string | null } | undefined)?.first ?? null,
		categories: (
			categories.results as (Omit<TrendCategory, "archived"> & {
				archived: number;
			})[]
		).map((c) => ({ ...c, archived: c.archived === 1 })),
		amounts: amounts.results as BudgetAmount[],
		spend: spend.results as MonthSpend[],
		sameDays: same.results as { categoryId: number | null; cents: number }[],
	};
}
