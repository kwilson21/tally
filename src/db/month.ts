import type { BudgetAmount, CountedTransaction } from "../budget";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedCategorySql,
	countedMonthSql,
	FOLLOWS_PURCHASE,
	INCLUDED,
} from "./counted-month";

const COUNTED_MONTH = countedMonthSql();
const COUNTED_CATEGORY = countedCategorySql();

export type CategoryRow = {
	id: number;
	name: string;
	icon: string;
	color: string;
	/** Archived categories only appear for a month they have spending in. */
	archived: boolean;
};

export type MonthData = {
	categories: CategoryRow[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
};

/**
 * Loads what summarizeMonth needs for a month ('YYYY-MM'). Counted = in month, not excluded (or paying a
 * bill), not a split parent.
 * Categories are the active ones plus any archived one with counted spending that month (spec §7).
 */
export async function loadMonth(
	db: D1Database,
	month: string,
): Promise<MonthData> {
	// db.batch()'s return type is D1Result[], not a fixed-length tuple, so noUncheckedIndexedAccess
	// treats each destructured element as possibly undefined; the query list above guarantees all three.
	const [categories, amounts, transactions] = (await db.batch([
		// An archived category stays for a month it has counted spending in (not income), so the month still adds up.
		db
			.prepare(
				`SELECT id, name, icon, color, archived FROM categories c
				 WHERE archived = 0 OR EXISTS (
					SELECT 1 FROM transactions t
					${COUNTED_JOINS}
					WHERE ${COUNTED_CATEGORY} = c.id AND ${COUNTED_MONTH} = ?1 AND ${COUNTED_SPENDING}
				 )
				 ORDER BY sort_order, name`,
			)
			.bind(month),
		db.prepare(
			"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts",
		),
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
	])) as [D1Result, D1Result, D1Result];

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
	};
}

/** First month with an included, whole transaction, using the same counted-month rule as Home. */
export async function firstCountedMonth(
	db: D1Database,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT MIN(${COUNTED_MONTH}) AS month FROM transactions t
			 ${COUNTED_JOINS}
			 WHERE ${INCLUDED} AND t.is_split = 0`,
		)
		.first<{ month: string | null }>();
	return row?.month ?? null;
}
