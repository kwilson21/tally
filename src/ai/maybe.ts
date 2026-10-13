// The "Maybe …" rules (spec §8.6, decision 79): when Tally's answer is unsure enough to show as a dashed
// "Maybe …" and ask about it, rather than apply it or leave it out. Pure, so the transaction rows, the
// review queue and the tests read one definition.

import { JEV_THRESHOLD } from "./categorize";
import { confidenceBasisPoints } from "./confidence";

/** Unsure: neither a sure yes nor a sure no, between 1 − threshold and threshold (spec §8.6). */
export function isUnsure(
	confidence: number,
	threshold = JEV_THRESHOLD,
): boolean {
	const basis = confidenceBasisPoints(confidence);
	const limit = confidenceBasisPoints(threshold);
	return basis < limit && basis > 10_000 - limit;
}

/** A low-confidence credit is a visible income guess only until someone decides what it is. */
export function maybeIncomeVisible({
	amountCents,
	income,
	incomeConfidence,
	creditReviewed,
	excluded,
	paysBill,
}: {
	amountCents: number;
	income: boolean;
	incomeConfidence?: number | null;
	creditReviewed: boolean;
	excluded?: boolean;
	paysBill?: boolean;
}): boolean {
	return (
		amountCents < 0 &&
		!income &&
		!creditReviewed &&
		!(excluded && !paysBill) &&
		incomeConfidence != null &&
		isUnsure(incomeConfidence)
	);
}
