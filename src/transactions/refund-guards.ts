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
