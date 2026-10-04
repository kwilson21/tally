/**
 * SQL expression for the month a transaction affects.
 *
 * A bill occurrence moves a payment only when the occurrence is earlier than
 * the bank month. Alias arguments make this one rule reusable by every query.
 */
export function countedMonthSql(
	transaction = "t",
	payment = "bp",
	bill = "b",
	refundPurchase = "rp",
) {
	const bankMonth = `substr(${transaction}.date,1,7)`;
	const occurrenceMonth = `CASE WHEN ${bill}.frequency='yearly' THEN ${payment}.period || '-' || printf('%02d',${bill}.anchor_month) ELSE ${payment}.period END`;
	return `CASE WHEN ${transaction}.refund_of_id IS NOT NULL THEN substr(${refundPurchase}.date,1,7) WHEN ${payment}.period IS NOT NULL AND (${occurrenceMonth}) < ${bankMonth} THEN (${occurrenceMonth}) ELSE ${bankMonth} END`;
}
