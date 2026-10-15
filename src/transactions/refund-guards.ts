// The refund rule (spec §6, §8.5, decision 60): a purchase is refunded at most up to its amount,
// counting every refund already linked to it. Refunds are negative amounts and purchases positive
// (Plaid's sign convention), and everything here is integer cents, so sums are exact.
//
// The write itself enforces the rule (src/db/refunded.ts, in the UPDATE that links a refund, so two
// saves at once can't both fit). This is only the arithmetic the message needs, kept pure to test.

import { shortDay } from "../dates";
import { formatCents } from "../money";

/**
 * What is left to refund of a purchase: its amount less what the other refunds linked to it already
 * took (their absolute cents). Never below zero, so a purchase that was over-refunded before this rule
 * says "$0.00 left" rather than a negative.
 */
export function leftToRefundCents(
	purchaseCents: number,
	refundedCents: number,
): number {
	return Math.max(0, purchaseCents - refundedCents);
}

/** The field error under "This refunds…" when a refund doesn't fit what's left of its purchase. */
export function refundTooBigMessage(leftCents: number): string {
	return `This refund is more than what's left of that purchase (${formatCents(leftCents)} left).`;
}

/**
 * The field error under "This refunds…" when a part of a split refund doesn't fit what's left of the
 * purchase it is linked to, which is not the split's own purchase. `purchaseLabel` is refundPurchaseLabel.
 */
export function refundPartTooBigMessage(
	leftCents: number,
	purchaseLabel: string,
): string {
	return `Part of this refund is for the ${purchaseLabel} purchase and is more than what's left of it (${formatCents(leftCents)} left).`;
}

/**
 * A purchase as a refund's "This refunds…" chip names it, and the alerts that refer to it. `refundDate` is
 * the refund's own date, which the purchase's date is shown beside (shortDay).
 */
export function refundPurchaseLabel(
	purchase: { date: string; amountCents: number; categoryName: string | null },
	refundDate: string,
): string {
	return `${shortDay(purchase.date, refundDate)} · ${formatCents(purchase.amountCents)} · ${purchase.categoryName ?? "No category"}`;
}

/**
 * A refund linked to a split purchase, as the split sheet asks which part it goes with (decision 99). Its amount is
 * refund-shaped (negative): for a split refund, the cents of its parts that still follow its link, which is what a
 * save moves (refundFitsSql), and for a plain refund its whole amount.
 */
export type SplitRefund = { id: number; date: string; amountCents: number };

/**
 * The part a split sheet's answer for a refund names: its index in the parts, or null for Not linked ("none")
 * and for an answer that names no part (a missing, blank or out-of-range one).
 */
export function refundPartIndex(
	answer: string | undefined,
	partCount: number,
): number | null {
	if (answer === undefined || !/^\d+$/.test(answer)) return null;
	const index = Number(answer);
	return index < partCount ? index : null;
}

/**
 * The field error on the split sheet when a linked refund has no answer yet: it must go with a part, or be
 * Not linked. Nothing is saved until every refund is answered (decision 99).
 */
export function refundPickMessage(date: string, today: string): string {
	return `Pick which part the refund on ${shortDay(date, today)} goes with, or Not linked.`;
}

/**
 * The field error on the split sheet when a part can't take the refunds chosen for it. `count` is how many refunds are
 * chosen for it, `totalCents` their absolute total, and `partCents` the part's own size (absolute cents).
 */
export function refundPartRoomMessage(
	count: number,
	totalCents: number,
	partName: string,
	partCents: number,
): string {
	const refunds =
		count === 1
			? `The refund is ${formatCents(totalCents)}`
			: `The refunds come to ${formatCents(totalCents)}`;
	return `${refunds}, and ${partName} is only ${formatCents(partCents)}.`;
}

/**
 * The split sheet's refund answers, checked before the save (decision 99). `answers[refundId]` is what the sheet
 * posted for each refund: "none" for Not linked, a part's index, or nothing when no part was chosen. Returns the first
 * refusal in words, or null when every refund is answered and every part has room for the refunds chosen for it. The
 * refunds chosen for a part are totalled together and checked against its own size (absolute cents, so a split's
 * negative parts work too); the first part in sheet order that is too small is the one named.
 */
export function refundAnswersError(
	refunds: SplitRefund[],
	answers: Record<number, string | undefined>,
	parts: { name: string; amountCents: number }[],
	today: string,
): string | null {
	const open = refunds.find(
		(refund) =>
			answers[refund.id] !== "none" &&
			refundPartIndex(answers[refund.id], parts.length) === null,
	);
	if (open) return refundPickMessage(open.date, today);
	for (const [index, part] of parts.entries()) {
		const chosen = refunds.filter(
			(refund) => refundPartIndex(answers[refund.id], parts.length) === index,
		);
		const totalCents = chosen.reduce(
			(sum, refund) => sum + Math.abs(refund.amountCents),
			0,
		);
		const partCents = Math.abs(part.amountCents);
		if (totalCents > partCents)
			return refundPartRoomMessage(
				chosen.length,
				totalCents,
				part.name,
				partCents,
			);
	}
	return null;
}
