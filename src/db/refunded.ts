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
// saving the link it already has isn't counted against itself. A split's parent keeps its link while its
// parts follow it, or stop following it, so when a split is removed or replaced that link is checked
// like a new one (unlinkSplitOverRefundedSql).

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
 * What is left to refund of a purchase, not counting `refundId`: for the message after a refusal. A split
 * refund's own parts on the purchase are left out too, so the amount is for the whole split ("this refund"
 * in the message). Zero when there is no such purchase.
 */
export async function refundLeftCents(
	db: D1Database,
	purchaseId: number,
	refundId: number,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT amount_cents AS purchaseCents, ${refundedByOthersSql("?1", "?2")}
				- COALESCE((SELECT SUM(ABS(part.amount_cents)) FROM transactions part
					WHERE part.parent_id = ?2 AND part.refund_of_id = ?1 AND ${counts("part")}), 0) AS refundedCents
			FROM transactions WHERE id = ?1`,
		)
		.bind(purchaseId, refundId)
		.first<{ purchaseCents: number; refundedCents: number }>();
	return row ? leftToRefundCents(row.purchaseCents, row.refundedCents) : 0;
}

/**
 * SQL for a linked part of the split refund `parent` that doesn't fit what is left of its own purchase
 * once a review as not income makes it count: an unreviewed credit that counts (not income), whose cents,
 * with the other refunds on that purchase, are more than the purchase has. The part is checked on its own
 * purchase, so two parts on one purchase are checked together (refundedByOthersSql counts the sibling,
 * since counts() ignores review).
 *
 * `oldLink` is the parent's link before the save, as an SQL bind expression (such as `?2`, or NULL when the
 * link stays or there was none). Parts on the old link are left out, since they move with the parent: the
 * link statement's refundFitsSql checks what moves against what is left of the new purchase, counting the
 * parts already there. Every other part is checked here, including the parts already on the purchase the
 * parent is being linked to. Before the move, those parts are checked as they stand. The move runs only when
 * what moves fits what is left, counting those parts, so after it every part there still fits. If the move is
 * refused, nothing changes. So the answer is the same at every statement of the batch. Used with NOT EXISTS
 * (the write's gate) and to name the purchase that refused it (saveEdit), so both give the same answer.
 */
export function splitPartMisfitSql(parent: string, oldLink: string) {
	return `kid.parent_id = ${parent} AND kid.refund_of_id IS NOT NULL
		AND kid.refund_of_id IS NOT ${oldLink}
		AND kid.amount_cents < 0 AND kid.flag_income = 0 AND COALESCE(kid.credit_reviewed, 0) = 0
		AND (${refundFitsSql("kid.id", "kid.refund_of_id")}) IS NOT 1`;
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

/**
 * A statement for when a split refund's parent is about to count, or have its parts count, from its own
 * link: a split is removed, or replaced by new parts that take the link. The parent's link may be stale,
 * since the bank trimmed some of its parts or a person moved them (the parent keeps its link while they
 * do), so the whole refund is checked as a new link is, and the link is cleared when it doesn't fit.
 * Does nothing for a refund with no link, or one marked as income, which doesn't count. Run once the
 * refund's old parts are gone and before new ones are made, so none is counted against the refund.
 *
 * `refund` is a SQL expression for the refund's id, such as `?1`; the refund's own cents are the row's.
 */
export function unlinkSplitOverRefundedSql(refund: string) {
	return `UPDATE transactions SET refund_of_id = NULL
		WHERE id = ${refund} AND refund_of_id IS NOT NULL AND amount_cents < 0 AND flag_income = 0
			AND ABS(amount_cents) > MAX(0,
				(SELECT pur.amount_cents FROM transactions pur WHERE pur.id = transactions.refund_of_id)
				- ${refundedByOthersSql("transactions.refund_of_id", refund)})`;
}
