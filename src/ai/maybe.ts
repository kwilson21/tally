// The "Maybe …" rules (spec §8.6, decision 79): when Tally's answer is unsure enough to show as a dashed
// "Maybe …" and ask about it, rather than apply it or leave it out. Pure, so the transaction rows, the
// review queue and the tests read one definition.

import { JEV_THRESHOLD } from "./categorize";
import { BASIS_POINTS, confidenceBasisPoints } from "./confidence";

/**
 * The Maybe range's bounds in whole basis points: a guess is unsure when its basis points are above `above`
 * and below `below`, both excluded, so the threshold itself is sure. The review queue's SQL is built from these
 * same bounds (src/db/suggestions-queue.ts), so the queue and the answer writes can't disagree with this.
 */
export function unsureBounds(threshold = JEV_THRESHOLD): {
	above: number;
	below: number;
} {
	const below = confidenceBasisPoints(threshold);
	return { above: BASIS_POINTS - below, below };
}

/** Unsure: neither a sure yes nor a sure no, between 1 − threshold and threshold (spec §8.6). */
export function isUnsure(
	confidence: number,
	threshold = JEV_THRESHOLD,
): boolean {
	const basis = confidenceBasisPoints(confidence);
	const { above, below } = unsureBounds(threshold);
	return basis < below && basis > above;
}

/**
 * A low-confidence credit is a visible income guess only until someone decides what it is. A payment for a bill or a
 * planned expense counts whatever its exclusion (decision 82), so it is asked as the income queue asks it (incomeAskedSql).
 */
export function maybeIncomeVisible({
	amountCents,
	income,
	incomeConfidence,
	creditReviewed,
	excluded,
	paysBill,
	paysPlan,
}: {
	amountCents: number;
	income: boolean;
	incomeConfidence?: number | null;
	creditReviewed: boolean;
	excluded?: boolean;
	paysBill?: boolean;
	paysPlan?: boolean;
}): boolean {
	return (
		amountCents < 0 &&
		!income &&
		!creditReviewed &&
		!(excluded && !paysBill && !paysPlan) &&
		incomeConfidence != null &&
		isUnsure(incomeConfidence)
	);
}
