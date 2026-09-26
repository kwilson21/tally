// Home's Adjust mode (#94, decision 48): each tap of − or + moves a budget to the next round $10.
import { MAX_BUDGET_CENTS } from "./amount";

/** One tap: $10. */
export const NUDGE_STEP_CENTS = 1000;

/** The budget after one tap: $712 → $720 up or $710 down, $720 → $730 or $710; never below $0 or above the largest budget. */
export function nudgeCents(cents: number, direction: "up" | "down"): number {
	const step = NUDGE_STEP_CENTS;
	const next =
		direction === "up"
			? (Math.floor(cents / step) + 1) * step
			: (Math.ceil(cents / step) - 1) * step;
	return Math.min(MAX_BUDGET_CENTS, Math.max(0, next));
}
