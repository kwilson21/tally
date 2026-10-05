// How much of a purchase is left to refund, as SQL (spec §6, §8.5, decision 60). Linking a refund is
// one UPDATE whose WHERE re-checks this, so two saves at once can't both fit (the way a bill's name is
// checked inside its own write, src/bills/write.ts). The arithmetic for the message is in
// src/transactions/refund-guards.ts; this is the same rule, in the statements.
//
// A purchase may be refunded up to its amount. Every refund linked to it counts, whether or not it is
// excluded, in absolute cents (refunds are negative, purchases positive), except a linked credit marked
// as income: that one doesn't follow the purchase (src/db/counted-month.ts), so it uses none of it. A
// split refund counts by its parts, never also by its parent; a refund of a split purchase is linked to
// one part, so the part's own amount is the cap. The refund being linked is left out of the sum, so
// saving the link it already has isn't counted against itself.

import { leftToRefundCents } from "../transactions/refund-guards";

/** SQL for whether a row `alias` is a refund that counts toward the purchase it is linked to. */
const counts = (alias: string) =>
	`${alias}.is_split = 0 AND ${alias}.amount_cents < 0 AND ${alias}.flag_income = 0`;

/**
 * SQL for the absolute cents the other refunds linked to `purchase` already took. `purchase` and
 * `refund` are SQL expressions for the two ids, such as `?1` or `t.id`.
 */
export function refundedByOthersSql(purchase: string, refund: string) {
	return `COALESCE((SELECT SUM(ABS(linked.amount_cents)) FROM transactions linked
		WHERE linked.refund_of_id = ${purchase} AND ${counts("linked")} AND linked.id != ${refund}), 0)`;
}

/**
 * SQL for the cents of `refund` that a change of link moves. A split refund moves with the parts that
 * still follow its link (the others were linked elsewhere by a person and stay there); any other
 * refund moves whole.
 */
function movingSql(refund: string) {
	return `CASE WHEN (SELECT me.is_split FROM transactions me WHERE me.id = ${refund}) = 1
		THEN (SELECT COALESCE(SUM(ABS(part.amount_cents)), 0) FROM transactions part
			WHERE part.parent_id = ${refund}
				AND part.refund_of_id IS (SELECT old.refund_of_id FROM transactions old WHERE old.id = ${refund}))
		ELSE ABS((SELECT me.amount_cents FROM transactions me WHERE me.id = ${refund})) END`;
}

/**
 * SQL for whether what moves with `refund` fits what is left of `purchase`. False, as NULL is, when
 * either is missing, so a refund is never linked to a purchase that isn't there. A purchase that was
 * over-refunded before this rule has nothing left, and nothing moving still fits.
 */
export function refundFitsSql(refund: string, purchase: string) {
	return `${movingSql(refund)}
		<= MAX(0, (SELECT pur.amount_cents FROM transactions pur WHERE pur.id = ${purchase}) - ${refundedByOthersSql(purchase, refund)})`;
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

/**
 * A statement for after the bank has corrected a transaction's amount (src/plaid/sync.ts): it unlinks
 * the refunds of the purchases that correction touched (the transaction itself as a purchase, or the
 * purchase it refunds) that no longer fit. A purchase's refunds are taken oldest first, by date then
 * id, and kept while their running total is within the purchase's amount; the rest, the newest ones,
 * lose their link. That is removing the newest first until the others fit. There is no record of when
 * a link was made, so a refund's own date stands in for "newest". A person can link them again, and
 * nothing else about them changes. Purchases the sync didn't touch are left as they are, whatever
 * they hold.
 *
 * Binds the changed transaction's Plaid id twice, then whatever `guard` binds. The sum is taken before
 * any link is removed, as the ids come from a subquery that is read first.
 */
export function unlinkOverRefundedSql(guard: string) {
	return `UPDATE transactions SET refund_of_id = NULL
		WHERE id IN (
			SELECT r.id FROM transactions r JOIN transactions p ON p.id = r.refund_of_id
			WHERE ${counts("r")}
				AND (p.plaid_transaction_id = ?
					OR p.id IN (SELECT t.refund_of_id FROM transactions t WHERE t.plaid_transaction_id = ?))
				AND (SELECT SUM(ABS(o.amount_cents)) FROM transactions o
					WHERE o.refund_of_id = r.refund_of_id AND ${counts("o")}
						AND (o.date < r.date OR (o.date = r.date AND o.id <= r.id))) > p.amount_cents
		) AND ${guard}`;
}
