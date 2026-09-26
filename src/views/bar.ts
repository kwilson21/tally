/**
 * How much of a budget bar is filled, as a percentage of the track. The track is the budget; there
 * is no limit marker (decision 46), so an over-budget bar is simply full and its words say by how
 * much.
 */
export function barGeometry(spentCents: number, budgetCents: number) {
	const spent = Math.max(spentCents, 0);
	if (budgetCents <= 0) return { fillPct: spent > 0 ? 100 : 0 };
	return {
		fillPct: Math.min(100, Math.round((spent / budgetCents) * 1000) / 10),
	};
}
