import type { BudgetAmount, CountedTransaction } from "../budget";

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
 * Loads what summarizeMonth needs for a month ('YYYY-MM'). Counted = in month, not excluded, not a split parent.
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
					WHERE t.category_id = c.id AND substr(t.date, 1, 7) = ?1 AND t.excluded = 0 AND t.is_split = 0
						AND t.flag_income = 0
				 )
				 ORDER BY sort_order, name`,
			)
			.bind(month),
		db.prepare(
			"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts",
		),
		db
			.prepare(
				`SELECT category_id AS categoryId, amount_cents AS amountCents, flag_income AS income
				 FROM transactions
				 WHERE substr(date, 1, 7) = ?1 AND excluded = 0 AND is_split = 0`,
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
			}[]
		).map((t) => ({ ...t, income: t.income === 1 })),
	};
}
