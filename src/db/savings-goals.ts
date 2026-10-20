/**
 * The current savings goal, as SQL: the cents of the latest goal row at or before `month` (`YYYY-MM`, code, checked here),
 * or NULL when that row is $0 or there is none. Home writes $0 to remove a goal, so a $0 row is no goal (month.ts reads
 * the same latest row). Shared by the first week's savings question (first-page.ts) and the Home sheet's write.
 */
export function currentGoalSql(month: string): string {
	if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`not a month: ${month}`);
	return `(SELECT NULLIF(amount_cents, 0) FROM savings_goal_amounts WHERE effective_month <= '${month}' ORDER BY effective_month DESC LIMIT 1)`;
}

/**
 * The statement that sets the goal from `month` on, preserving earlier months, for a batch. `guard` is an SQL condition
 * checked in the same statement (as strokeStatement's is), so the write lands only while it holds; it is code, never input.
 */
export function savingsGoalStatement(
	db: D1Database,
	cents: number,
	month: string,
	guard = "1",
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO savings_goal_amounts (effective_month, amount_cents) SELECT ?1, ?2 WHERE ${guard}
			ON CONFLICT (effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(month, cents);
}

/** Sets the monthly savings goal from `month` on, preserving earlier months. */
export async function setSavingsGoal(
	db: D1Database,
	cents: number,
	month: string,
): Promise<void> {
	await savingsGoalStatement(db, cents, month).run();
}
