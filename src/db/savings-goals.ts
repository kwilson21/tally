/** Sets the monthly savings goal from `month` on, preserving earlier months. */
export async function setSavingsGoal(
	db: D1Database,
	cents: number,
	month: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, ?)
			ON CONFLICT (effective_month) DO UPDATE SET amount_cents = excluded.amount_cents`,
		)
		.bind(month, cents)
		.run();
}
