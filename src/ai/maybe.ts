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

/**
 * The lowest confidence Tally asks a category or a transfer guess about (decision 155, #800). Below it the guess is kept
 * as stored, but it is neither shown as a Maybe nor asked, so the row reads like one with no guess. Income has no floor
 * of its own: its range starts at unsureBounds' 20%.
 */
export const MAYBE_FLOOR = 0.4;

/** The three kinds of "Maybe …" question that have a range (a new category and a name are asked another way). */
export type MaybeKind = "category" | "income" | "transfer";

/**
 * A kind's asked range in whole basis points, both bounds excluded. Income: unsureBounds, from 20% up to the threshold.
 * Category and transfer: from MAYBE_FLOOR up to the threshold, so the threshold itself is sure. The review queue's SQL
 * is built from these bounds too (askedSql in src/db/suggestions-queue.ts), so the queue, the rows and the answer writes can't disagree.
 */
export function askedBounds(kind: MaybeKind): { above: number; below: number } {
	if (kind === "income") return unsureBounds();
	return {
		above: confidenceBasisPoints(MAYBE_FLOOR) - 1,
		below: confidenceBasisPoints(JEV_THRESHOLD),
	};
}

/** Unsure: the guess is in the kind's asked range (askedBounds), so a sure or a too-low guess is not a Maybe. */
export function isUnsure(confidence: number, kind: MaybeKind): boolean {
	const basis = confidenceBasisPoints(confidence);
	const { above, below } = askedBounds(kind);
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
		isUnsure(incomeConfidence, "income")
	);
}
