/**
 * Where a transaction counts: its month and its category (spec §6).
 *
 * A bill occurrence moves a payment only when the occurrence is earlier than the bank month.
 * A refund linked to its purchase counts in that purchase's counted month and current
 * category, never its own, while the purchase counts; unlinking it, or excluding the purchase,
 * brings back its own date and category.
 * Every query that uses these expressions adds COUNTED_JOINS, which names the aliases:
 * t (the transaction), bp/b (its bill payment), rp (the purchase it refunds) and rbp/rb
 * (that purchase's bill payment).
 */

/** True when a transaction is a refund that follows its purchase and its review is still valid. */
export const FOLLOWS_PURCHASE =
	"(rp.id IS NOT NULL AND rp.excluded = 0 AND t.amount_cents < 0 AND t.flag_income = 0 AND COALESCE(t.credit_reviewed, 0) = 1)";

/** The month a transaction's own date and bill payment put it in. */
function billMonthSql(transaction: string, payment: string, bill: string) {
	const bankMonth = `substr(${transaction}.date,1,7)`;
	const occurrenceMonth = `CASE WHEN ${bill}.frequency='yearly' THEN ${payment}.period || '-' || printf('%02d',${bill}.anchor_month) ELSE ${payment}.period END`;
	return `CASE WHEN ${payment}.period IS NOT NULL AND (${occurrenceMonth}) < ${bankMonth} THEN (${occurrenceMonth}) ELSE ${bankMonth} END`;
}

/** SQL for the month a transaction counts in. */
export function countedMonthSql() {
	return `CASE WHEN ${FOLLOWS_PURCHASE} THEN ${billMonthSql("rp", "rbp", "rb")} ELSE ${billMonthSql("t", "bp", "b")} END`;
}

/** SQL for the category a transaction counts in: a linked refund's purchase's, otherwise its own. */
export function countedCategorySql() {
	return `CASE WHEN ${FOLLOWS_PURCHASE} THEN rp.category_id ELSE t.category_id END`;
}

/** The joins countedMonthSql and countedCategorySql read from. */
export const COUNTED_JOINS = `LEFT JOIN bill_payments bp ON bp.transaction_id=t.id AND bp.status='linked'
	LEFT JOIN bills b ON b.id=bp.bill_id
	LEFT JOIN transactions rp ON rp.id=t.refund_of_id
	LEFT JOIN bill_payments rbp ON rbp.transaction_id=rp.id AND rbp.status='linked'
	LEFT JOIN bills rb ON rb.id=rbp.bill_id`;
