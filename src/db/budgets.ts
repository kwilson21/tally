// Budget amounts as Home's budget sheet reads and sets them (spec §5, §7, #66).
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { budgetForMonth } from "../budget";
import { monthsBefore } from "../dates";
import { averageMonthlyCents, firstMonthIsPart } from "../trends";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedCategorySql,
	countedMonthSql,
} from "./counted-month";
import { budgetAmounts, categories } from "./schema";

// stays SQL: a WITH statement built from the shared counted-month helpers; test/budgets-db.test.ts runs EXPLAIN on it.
export const THREE_MONTH_AVERAGE_SQL = `WITH monthly AS (
				SELECT ${countedMonthSql()} AS month, SUM(t.amount_cents) AS cents
				FROM (
					SELECT * FROM transactions WHERE date >= ?4 AND date < ?5
					UNION ALL
					SELECT * FROM transactions WHERE +date < ?4 AND refund_of_id > 0
				) t ${COUNTED_JOINS}
				WHERE ${COUNTED_SPENDING} AND ${countedCategorySql()} = ?6
					AND ${countedMonthSql()} BETWEEN ?1 AND ?3
				GROUP BY ${countedMonthSql()}
			)
			SELECT (SELECT MIN(date) FROM transactions) AS firstDate,
				COALESCE(MAX(CASE WHEN month = ?1 THEN cents END), 0) AS first,
				COALESCE(MAX(CASE WHEN month = ?2 THEN cents END), 0) AS second,
				COALESCE(MAX(CASE WHEN month = ?3 THEN cents END), 0) AS third
			FROM monthly`;

/**
 * The query that sets a category's budget from `month` on, replacing one already set for that month. The first
 * page's budget answers write their own guarded statement (budgetWriteStatement, first-tally/first-page.ts).
 * It is a Drizzle query, not a D1 statement, so it cannot sit in a raw db.batch; setBudget is its only caller.
 */
export function setBudgetStatement(
	db: D1Database,
	categoryId: number,
	cents: number,
	month: string,
) {
	return drizzle(db)
		.insert(budgetAmounts)
		.values({ categoryId, effectiveMonth: month, amountCents: cents })
		.onConflictDoUpdate({
			target: [budgetAmounts.categoryId, budgetAmounts.effectiveMonth],
			set: { amountCents: sql`excluded.amount_cents` },
		});
}

/**
 * Sets a category's budget from `month` on, replacing one already set for that month, with no rule and no guard: tests
 * use it to set a scene. Home saves through the rules (src/rules/budgets.ts) and budgetSaveStatement.
 */
export async function setBudget(
	db: D1Database,
	categoryId: number,
	cents: number,
	month: string,
): Promise<void> {
	await setBudgetStatement(db, categoryId, cents, month).run();
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
	const orm = drizzle(db);

	// orm.batch returns one array per query, in the order listed: the category rows first, then the budget rows.
	const [category, amounts] = await orm.batch([
		orm
			.select({
				id: categories.id,
				name: categories.name,
				icon: categories.icon,
				color: categories.color,
				archived: categories.archived,
			})
			.from(categories)
			.where(eq(categories.id, id)),
		orm
			.select({
				categoryId: budgetAmounts.categoryId,
				effectiveMonth: budgetAmounts.effectiveMonth,
				amountCents: budgetAmounts.amountCents,
			})
			.from(budgetAmounts)
			.where(eq(budgetAmounts.categoryId, id)),
	]);

	const row = category[0];

	if (!row) return null;

	return {
		...row,
		archived: row.archived === 1,
		budgetCents: budgetForMonth(amounts, id, month),
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
	// stays SQL: built from COUNTED_JOINS and the counted helpers, shared SQL strings (decision 179).
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(t.amount_cents), 0) AS cents FROM transactions t
			 ${COUNTED_JOINS}
			 WHERE ${countedCategorySql()} = ? AND ${countedMonthSql()} = ? AND ${COUNTED_SPENDING}`,
		)
		.bind(categoryId, previousMonth(month))
		.first<{ cents: number }>();

	return row?.cents ?? 0;
}

/** Average counted spending in the last three finished months, only after three whole months exist. */
export async function threeMonthAverageSpentCents(
	db: D1Database,
	categoryId: number,
	month: string,
): Promise<number | null> {
	const months = [3, 2, 1].map((n) => monthsBefore(month, n));
	const fromDate = `${monthsBefore(months[0] ?? month, 1)}-01`;
	const throughDate = `${monthsBefore(months[2] ?? month, -2)}-01`;

	// stays SQL: THREE_MONTH_AVERAGE_SQL, the WITH statement above (decision 179).
	const row = await db
		.prepare(THREE_MONTH_AVERAGE_SQL)
		.bind(months[0], months[1], months[2], fromDate, throughDate, categoryId)
		.first<{
			firstDate: string | null;
			first: number;
			second: number;
			third: number;
		}>();

	if (!row?.firstDate || firstMonthIsPart(row.firstDate, months[0] ?? month))
		return null;

	return averageMonthlyCents([row.first, row.second, row.third]);
}
