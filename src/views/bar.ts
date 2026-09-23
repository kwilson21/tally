/**
 * Where a budget bar's fill ends and where its limit notch sits, as percentages of the track.
 * The track spans the larger of budget and spent, so an over-budget bar is full and its notch
 * shows how far past the limit it went.
 */
export function barGeometry(spentCents: number, budgetCents: number) {
	const spent = Math.max(spentCents, 0);
	const scale = Math.max(budgetCents, spent, 1);
	const pct = (n: number) => Math.round((n / scale) * 1000) / 10;
	return { fillPct: pct(spent), limitPct: pct(Math.max(budgetCents, 0)) };
}
