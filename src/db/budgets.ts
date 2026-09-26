// Budget amounts as Home's budget sheet reads and sets them (spec §5, §7, #66).
import { budgetForMonth } from "../budget";
import { MAX_BUDGET_CENTS } from "../budgets/amount";
import { NUDGE_STEP_CENTS } from "../budgets/nudge";

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

/**
 * One tap in Adjust mode (#94): moves the category's budget to the next round step (nudgeCents'
 * rule, $0 to the largest budget) from `month` on, reading and writing in one statement so two taps
 * at once both count. Returns the new amount, or null when there was no budget or it was at the limit.
 */
export async function nudgeBudget(
	db: D1Database,
	categoryId: number,
	direction: "up" | "down",
	month: string,
): Promise<number | null> {
	// The step and the cap are written in as integer literals: D1 binds JavaScript numbers as REAL,
	// which would turn the division below into fractional division.
	const STEP = Math.trunc(NUDGE_STEP_CENTS);
	const MAX = Math.trunc(MAX_BUDGET_CENTS);
	const row = await db
		.prepare(
			`INSERT INTO budget_amounts (category_id, effective_month, amount_cents)
			SELECT ?1, ?2, next FROM (
				SELECT cur, MIN(${MAX}, MAX(0, CASE WHEN ?3 = 'up'
					THEN (cur / ${STEP} + 1) * ${STEP}
					ELSE ((cur + ${STEP} - 1) / ${STEP} - 1) * ${STEP} END)) AS next
				FROM (SELECT amount_cents AS cur FROM budget_amounts
					WHERE category_id = ?1 AND effective_month <= ?2
					ORDER BY effective_month DESC LIMIT 1)
			) WHERE next != cur
			ON CONFLICT (category_id, effective_month) DO UPDATE SET amount_cents = excluded.amount_cents
			RETURNING amount_cents`,
		)
		.bind(categoryId, month, direction)
		.first<{ amount_cents: number }>();
	return row?.amount_cents ?? null;
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
