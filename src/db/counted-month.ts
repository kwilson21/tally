/**
 * Where a transaction counts: its month and its category (spec §6).
 *
 * A bill occurrence moves a payment only when the occurrence is earlier than the bank month.
 * A refund linked to its purchase counts in that purchase's counted month and current
 * category, never its own, while the purchase counts; unlinking it, or excluding the purchase,
 * brings back its own date and category.
 * Every query that uses these expressions adds COUNTED_JOINS, which names the aliases:
 * t (the transaction), bp/b (its bill payment, or for a split part its parent's), rp (the purchase it
 * refunds) and rbp/rb (that purchase's bill payment, read the same way).
 */

/** True when a transaction is a refund that follows its purchase and its review is still valid. */
export const FOLLOWS_PURCHASE =
	"(rp.id IS NOT NULL AND rp.excluded = 0 AND t.amount_cents < 0 AND t.flag_income = 0 AND COALESCE(t.credit_reviewed, 0) = 1)";

/**
 * True when a bill's payment is linked to the transaction `alias` names, or, for a split part, to its
 * parent: the bank transaction that paid the bill was split afterwards, so the whole of it, every part,
 * is that payment. `alias` is a table alias or `transactions` itself (an UPDATE has no alias). A part with
 * a link of its own is the same row, so it is read as paying a bill once, never twice.
 */
export const paysBillSql = (alias: string) =>
	`EXISTS (SELECT 1 FROM bill_payments linked_bill WHERE linked_bill.status = 'linked' AND linked_bill.transaction_id IN (${alias}.id, ${alias}.parent_id))`;

/**
 * True when a transaction isn't left out of the budget (spec §6.1 rule 4, §8.5): it is not excluded, or
 * it pays a bill. A payment linked to a bill counts in Spent whatever its exclusion, so the bill counts
 * once; its exclusion is never written over by the link, so it is as it was when the link goes. A split
 * part counts on its own link or its parent's (the parent itself never counts once split, so a bank
 * transaction is counted by its parts once). Alias `t`.
 */
export const INCLUDED = `(t.excluded = 0 OR ${paysBillSql("t")})`;

/** True when the row pays a bill (see `paysBillSql`), for an UPDATE or subquery on `transactions` itself. */
export const PAYS_A_BILL = paysBillSql("transactions");

/** `INCLUDED` for an UPDATE or subquery on `transactions` itself. */
export const INCLUDED_ROW = `(excluded = 0 OR ${PAYS_A_BILL})`;

/**
 * What counts as spending, once the joins are added (spec §6): not excluded (or paying a bill), not a
 * split parent (its parts count), not income, and not an unreviewed bank credit; a refund that follows
 * its purchase counts. Home's budget rows, last month's amount and Trends all use this one definition.
 */
export const COUNTED_SPENDING = `${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0
	AND (t.amount_cents >= 0 OR t.credit_reviewed = 1 OR ${FOLLOWS_PURCHASE})`;

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

/**
 * Joins, as `payment`, the bill payment the transaction `alias` names pays (see `paysBillSql`): its own
 * link, or for a split part its parent's, so every part counts in the month the whole payment did. A
 * part linked both ways reads its own, so it is one row.
 */
const linkedPaymentJoin = (payment: string, alias: string) =>
	`LEFT JOIN bill_payments ${payment} ON ${payment}.id = COALESCE(
		(SELECT own.id FROM bill_payments own WHERE own.transaction_id=${alias}.id AND own.status='linked'),
		(SELECT whole.id FROM bill_payments whole WHERE whole.transaction_id=${alias}.parent_id AND whole.status='linked'))`;

/** The joins countedMonthSql and countedCategorySql read from. */
export const COUNTED_JOINS = `${linkedPaymentJoin("bp", "t")}
	LEFT JOIN bills b ON b.id=bp.bill_id
	LEFT JOIN transactions rp ON rp.id=t.refund_of_id
	${linkedPaymentJoin("rbp", "rp")}
	LEFT JOIN bills rb ON rb.id=rbp.bill_id`;
