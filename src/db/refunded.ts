// How much of a purchase is left to refund, as SQL (spec §6, §8.5, decision 60). Linking a refund is
// one UPDATE whose WHERE re-checks this, so two saves at once can't both fit (the way a bill's name is
// checked inside its own write, src/bills/write.ts). The arithmetic for the message is in
// src/transactions/refund-guards.ts; this is the same rule, in the statements.
//
// A purchase may be refunded up to its amount. Every refund linked to it counts, whether or not it is
// excluded, in absolute cents (refunds are negative, purchases positive). A split refund counts by its
// parts, never also by its parent; a refund of a split purchase is linked to one part, so the part's own
// amount is the cap. The refund being linked, and the parts of it, are left out of the sum: its own old
// link says nothing about the purchase it is moving to, and saving the link it already has isn't
// counted against itself.

import { leftToRefundCents } from "../transactions/refund-guards";

/**
 * SQL for the absolute cents the other refunds linked to `purchase` already took. `purchase` and
 * `refund` are SQL expressions for the two ids, such as `?1` or `t.id`.
 */
export function refundedByOthersSql(purchase: string, refund: string) {
	return `COALESCE((SELECT SUM(ABS(linked.amount_cents)) FROM transactions linked
		WHERE linked.refund_of_id = ${purchase} AND linked.is_split = 0 AND linked.amount_cents < 0
			AND linked.id != ${refund} AND linked.parent_id IS NOT ${refund}), 0)`;
}

/**
 * SQL for whether `refund` fits what is left of `purchase`. False, as NULL is, when either is missing,
 * so a refund is never linked to a purchase that isn't there.
 */
export function refundFitsSql(refund: string, purchase: string) {
	return `ABS((SELECT me.amount_cents FROM transactions me WHERE me.id = ${refund}))
		<= (SELECT pur.amount_cents FROM transactions pur WHERE pur.id = ${purchase}) - ${refundedByOthersSql(purchase, refund)}`;
}

/**
 * What is left to refund of a purchase, not counting `refundId`: for the message after a refusal.
 * Zero when there is no such purchase.
 */
export async function refundLeftCents(
	db: D1Database,
	purchaseId: number,
	refundId: number,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT amount_cents AS purchaseCents, ${refundedByOthersSql("?1", "?2")} AS refundedCents
			FROM transactions WHERE id = ?1`,
		)
		.bind(purchaseId, refundId)
		.first<{ purchaseCents: number; refundedCents: number }>();
	return row ? leftToRefundCents(row.purchaseCents, row.refundedCents) : 0;
}
