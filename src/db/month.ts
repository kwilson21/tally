import type { BudgetAmount, CountedTransaction } from "../budget";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	COUNTED_TRANSACTION,
	countedCategorySql,
	countedMonthSql,
	FOLLOWS_PURCHASE,
	INCLUDED,
} from "./counted-month";

const COUNTED_MONTH = countedMonthSql();
const COUNTED_CATEGORY = countedCategorySql();
/**
 * False when an archive period covers the whole month ?1 (spec §5): archived in an earlier month and not
 * restored until a later one. A month the category was archived in still counts. Alias `c`.
 */
const ACTIVE_IN_MONTH = `NOT EXISTS (
	SELECT 1 FROM category_archive_periods p
	WHERE p.category_id = c.id AND substr(p.archived_on, 1, 7) < ?1
		AND (p.restored_on IS NULL OR substr(p.restored_on, 1, 7) > ?1)
)`;

export type CategoryRow = {
	id: number;
	name: string;
	icon: string;
	color: string;
	/** Archived categories appear for counted spending, or a budget that applied to a finished month. */
	archived: boolean;
};

export type MonthData = {
	categories: CategoryRow[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
	savingsGoalCents: number | null;
};

/**
 * Loads what summarizeMonth needs for a month ('YYYY-MM'). Counted = in month, not excluded (or paying a
 * bill), not a split parent.
 * Categories are active ones (not archived for the whole month), plus archived categories with counted
 * spending that month, or a budget that applies to the month (see ACTIVE_IN_MONTH).
 */
export async function loadMonth(
	db: D1Database,
	month: string,
): Promise<MonthData> {
	// db.batch() returns D1Result[], not a fixed-length tuple, so noUncheckedIndexedAccess treats each
	// destructured element as possibly undefined; the query list above guarantees all four.
	const [categories, amounts, transactions, savingsGoal] = (await db.batch([
		db
			.prepare(
				`SELECT id, name, icon, color, archived FROM categories c
				 WHERE (c.archived = 0 AND ${ACTIVE_IN_MONTH})
					OR EXISTS (
						SELECT 1 FROM transactions t
						${COUNTED_JOINS}
						WHERE ${COUNTED_CATEGORY} = c.id AND ${COUNTED_MONTH} = ?1 AND ${COUNTED_SPENDING}
					)
					OR EXISTS (
						SELECT 1 FROM budget_amounts ba
						WHERE ba.category_id = c.id AND ba.effective_month <= ?1
							AND ${ACTIVE_IN_MONTH}
					)
				 ORDER BY sort_order, name`,
			)
			.bind(month),
		db
			.prepare(
				`SELECT ba.category_id AS categoryId, ba.effective_month AS effectiveMonth, ba.amount_cents AS amountCents
				 FROM budget_amounts ba JOIN categories c ON c.id = ba.category_id
				 WHERE ba.effective_month <= ?1 AND ${ACTIVE_IN_MONTH}`,
			)
			.bind(month),
		db
			.prepare(
				`SELECT ${COUNTED_CATEGORY} AS categoryId, t.amount_cents AS amountCents, t.flag_income AS income,
				   ${FOLLOWS_PURCHASE} AS linked
				 FROM transactions t
				 ${COUNTED_JOINS}
				 WHERE ${COUNTED_MONTH} = ?1 AND ${INCLUDED} AND t.is_split = 0
					AND (t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE})`,
			)
			.bind(month),
		db
			.prepare(
				"SELECT amount_cents AS amountCents FROM savings_goal_amounts WHERE effective_month <= ? ORDER BY effective_month DESC LIMIT 1",
			)
			.bind(month),
	])) as [D1Result, D1Result, D1Result, D1Result];

	return {
		categories: (
			categories.results as (Omit<CategoryRow, "archived"> & {
				archived: number;
			})[]
		).map((c) => ({ ...c, archived: c.archived === 1 })),
		amounts: amounts.results as BudgetAmount[],
		transactions: (
			transactions.results as {
				categoryId: number | null;
				amountCents: number;
				income: number;
				linked: number;
			}[]
		).map((t) => ({ ...t, income: t.income === 1, linked: t.linked === 1 })),
		savingsGoalCents:
			(savingsGoal.results[0] as { amountCents: number } | undefined)
				?.amountCents ?? null,
	};
}

/**
 * First counted month, checking the earliest counted date and its two-month bill-occurrence bound.
 * The start is the earliest counted transaction that isn't a linked refund: a refund counts in its
 * purchase's month (spec §7), so its own date says nothing about where history starts.
 */
export async function firstCountedMonth(
	db: D1Database,
): Promise<string | null> {
	const row = await db
		.prepare(
			`WITH first_date AS MATERIALIZED (
				SELECT t.date, ${COUNTED_MONTH} AS month FROM transactions t
				${COUNTED_JOINS}
				WHERE ${COUNTED_TRANSACTION} AND NOT ${FOLLOWS_PURCHASE}
				ORDER BY t.date
				LIMIT 1
			), nearby_month AS (
				SELECT MIN(${COUNTED_MONTH}) AS month
				FROM first_date f, transactions t INDEXED BY transactions_date
				${COUNTED_JOINS}
				WHERE ${COUNTED_TRANSACTION}
					AND t.date >= f.date AND t.date <= date(f.date, '+2 months')
			)
			SELECT MIN(month) AS month FROM (
				SELECT month FROM first_date
				UNION ALL SELECT month FROM nearby_month
			)`,
		)
		.first<{ month: string | null }>();
	return row?.month ?? null;
}
