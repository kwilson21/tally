import type { BudgetAmount, CountedTransaction } from "../budget";

export type CategoryRow = { id: number; name: string; icon: string; color: string };

export type MonthData = {
	categories: CategoryRow[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
};

/** Loads what summarizeMonth needs for a month ('YYYY-MM'). Counted = in month, not excluded, not a split parent. */
export async function loadMonth(db: D1Database, month: string): Promise<MonthData> {
	const [categories, amounts, transactions] = await db.batch([
		db.prepare("SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name"),
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
	]);

	return {
		categories: categories.results as CategoryRow[],
		amounts: amounts.results as BudgetAmount[],
		transactions: (transactions.results as { categoryId: number | null; amountCents: number; income: number }[]).map(
			(t) => ({ ...t, income: t.income === 1 }),
		),
	};
}
