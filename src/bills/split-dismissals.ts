// A person's own Not this one (a `dismissed` bill_payments row with matched_by 'user') survives a split change
// (decision 105). Only the person's own dismissals are carried; the parts' other payments go with the parts
// (ON DELETE CASCADE), unlinked and with no dismissal left, as before. Each helper is one statement, so a bank
// change's batch costs no more statements than it did.

/**
 * SQL that moves each Not this one a person made on a part of `from` onto `to`, once per bill and period. Run it
 * before the parts are deleted: a moved row is no longer a part's, and the parts' other payments are deleted with
 * them. A bill and period the purchase already has a Not this one for is not moved again. `guard` is SQL that must
 * hold for the write, such as the caller's lock or amount check. The SQL uses numbered parameters (?1 and up),
 * which the statement binds.
 */
export const movePartDismissalsSql = (
	from: string,
	to: string,
	guard: string,
) => `UPDATE bill_payments SET transaction_id = ${to}
	WHERE id IN (SELECT MIN(bp.id) FROM bill_payments bp JOIN transactions part ON part.id = bp.transaction_id
		WHERE part.parent_id = ${from} AND bp.status = 'dismissed' AND bp.matched_by = 'user' AND ${guard}
		GROUP BY bp.bill_id, bp.period)
	AND NOT EXISTS (SELECT 1 FROM bill_payments own WHERE own.transaction_id = ${to}
		AND own.bill_id = bill_payments.bill_id AND own.period = bill_payments.period
		AND own.status = 'dismissed' AND own.matched_by = 'user')`;

/**
 * SQL that lifts the Not this one a link replaces, for one bill and period, once the payment is linked: the
 * automatic dismissal an earlier build left on the payment itself, and a person's own Not this one on its purchase
 * family, which is the purchase and each of its parts (decision 105). Linking one of a purchase's payments, from the
 * picker or by Undo, lifts a purchase-wide Not this one for every part of it, and no other payment's. `?1` is the
 * bill, `?2` the period and `?3` the payment. It runs after the link is in, and lifts nothing unless the payment is
 * linked for that occurrence.
 */
export const liftNotThisOneSql = `DELETE FROM bill_payments WHERE bill_id = ?1 AND period = ?2 AND status = 'dismissed'
	AND ((matched_by = 'auto' AND transaction_id = ?3) OR (matched_by = 'user' AND transaction_id IN (
		SELECT id FROM transactions WHERE id = COALESCE((SELECT parent_id FROM transactions WHERE id = ?3), ?3)
		OR parent_id = COALESCE((SELECT parent_id FROM transactions WHERE id = ?3), ?3))))
	AND EXISTS (SELECT 1 FROM bill_payments WHERE bill_id = ?1 AND period = ?2 AND transaction_id = ?3 AND status = 'linked')`;

/**
 * SQL that gives each part of `purchase` the purchase's own Not this one, once per bill and period, so every part
 * the purchase has from then on starts with it. Run it after the new parts are in place: saveSplit runs it after a
 * replacement has restored its kept payments, and Change the parts (correctCashSplit) runs it after its inserts.
 * `guard` as above.
 */
export const purchaseDismissalsToPartsSql = (
	purchase: string,
	guard: string,
) => `INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status)
	SELECT DISTINCT bp.bill_id, bp.period, part.id, 'user', 'dismissed'
	FROM bill_payments bp JOIN transactions part ON part.parent_id = ${purchase}
	WHERE bp.transaction_id = ${purchase} AND bp.status = 'dismissed' AND bp.matched_by = 'user' AND ${guard}
	AND NOT EXISTS (SELECT 1 FROM bill_payments own WHERE own.transaction_id = part.id
		AND own.bill_id = bp.bill_id AND own.period = bp.period
		AND own.status = 'dismissed' AND own.matched_by = 'user')`;
