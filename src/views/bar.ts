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

/** A finished month's chart bar: at most 25% past its dashed budget line. */
export function endBarRatio(spentCents: number, budgetCents: number) {
	if (spentCents <= 0) return { ratio: 0, capped: false };
	if (budgetCents <= 0) return { ratio: 1.25, capped: true };
	const ratio = spentCents / budgetCents;
	return ratio > 1.25
		? { ratio: 1.25, capped: true }
		: { ratio, capped: false };
}
