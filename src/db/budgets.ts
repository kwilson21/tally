// Budget amounts as Home's budget sheet reads and sets them (spec §5, §7, #66).
import { budgetForMonth } from "../budget";

/** Sets a category's budget from `month` on, replacing one already set for that month. */
export async function setBudget(
	db: D1Database,
	categoryId: number,
	cents: number,
	month: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)
			ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(categoryId, month, cents)
		.run();
}

export type BudgetCategory = {
	id: number;
	name: string;
	icon: string;
	color: string;
	archived: boolean;
	/** This month's budget, or null for none. */
	budgetCents: number | null;
};

/** One category with its budget for `month`, or null when there's no such category. */
export async function budgetCategory(
	db: D1Database,
	id: number,
	month: string,
): Promise<BudgetCategory | null> {
	const [category, amounts] = (await db.batch([
		db
			.prepare(
				"SELECT id, name, icon, color, archived FROM categories WHERE id = ?",
			)
			.bind(id),
		db
			.prepare(
				"SELECT category_id AS categoryId, effective_month AS effectiveMonth, amount_cents AS amountCents FROM budget_amounts WHERE category_id = ?",
			)
			.bind(id),
	])) as [
		D1Result<
			Omit<BudgetCategory, "archived" | "budgetCents"> & { archived: number }
		>,
		D1Result<Parameters<typeof budgetForMonth>[0][number]>,
	];
	const row = category.results[0];
	if (!row) return null;
	return {
		...row,
		archived: row.archived === 1,
		budgetCents: budgetForMonth(amounts.results, id, month),
	};
}

/** The month before 'YYYY-MM'. */
export function previousMonth(month: string): string {
	const [year = 0, m = 1] = month.split("-").map(Number);
	return m === 1
		? `${year - 1}-12`
		: `${year}-${String(m - 1).padStart(2, "0")}`;
}

/** What the category spent the month before `month`: counted spending, not income (spec §6). */
export async function lastMonthSpentCents(
	db: D1Database,
	categoryId: number,
	month: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions
			 WHERE category_id = ? AND substr(date, 1, 7) = ? AND excluded = 0 AND is_split = 0 AND flag_income = 0`,
		)
		.bind(categoryId, previousMonth(month))
		.first<{ cents: number }>();
	return row?.cents ?? 0;
}
