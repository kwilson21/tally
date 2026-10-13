import { occurrenceAmountSql } from "../db/bill-amounts";
import { occurrenceMonthSql } from "../db/counted-month";

/**
 * A bill whose payment a split change unlinked (decision 99): the bill's name and the occurrence its payment
 * paid, keyed as bill_payments keys it: `2026`, `2026-09`, `2026-Q3`, or a due date `2026-09-14`.
 */
export type UnpaidBill = { name: string; period: string };

/** The occurrence in words: "2026", "September 2026", "Q3 2026" or "Sep 14, 2026". */
function occurrenceWords(period: string): string {
	const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
	if (quarter) return `Q${quarter[2]} ${quarter[1]}`;
	if (/^\d{4}$/.test(period)) return period;
	if (/^\d{4}-\d{2}$/.test(period))
		return new Intl.DateTimeFormat("en-US", {
			month: "long",
			year: "numeric",
			timeZone: "UTC",
		}).format(new Date(`${period}-01T00:00:00Z`));
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${period}T00:00:00Z`));
}

/**
 * What a split change says about the bill payments it unlinked, or "" for none: one names the bill and its
 * occurrence, two or more are counted (decision 99).
 */
export function unpaidBillsSentence(bills: UnpaidBill[]): string {
	if (bills.length > 1) return `${bills.length} bills are no longer paid.`;
	const [bill] = bills;
	if (!bill) return "";
	return `The ${bill.name} bill for ${occurrenceWords(bill.period)} is no longer paid.`;
}

const isUnpaidBill = (value: unknown): value is UnpaidBill =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as UnpaidBill).name === "string" &&
	typeof (value as UnpaidBill).period === "string";

/** The bills a purchase's bank change stored, read back for its note; nothing for none or a damaged value. */
export function parseUnpaidBills(
	stored: string | null | undefined,
): UnpaidBill[] {
	if (!stored) return [];
	try {
		const parsed: unknown = JSON.parse(stored);
		return Array.isArray(parsed) ? parsed.filter(isUnpaidBill) : [];
	} catch {
		return [];
	}
}

/** The sentence a purchase's note adds for the bills its bank change unlinked: " The … is no longer paid.", or "". */
export function unpaidBillsNote(stored: string | null | undefined): string {
	const sentence = unpaidBillsSentence(parseUnpaidBills(stored));
	return sentence ? ` ${sentence}` : "";
}

/**
 * SQL for the bills the linked payments of a purchase's parts pay, as the JSON that
 * transactions.split_removed_bills stores, or NULL when none. One entry per bill occurrence, however many of its
 * parts' payments pay it (decision 101). `parent` is the SQL for the purchase's id.
 * It must run before those parts are deleted, since their payments go with them.
 */
export const UNPAID_BILLS_SQL = (parent: string) =>
	`NULLIF((SELECT json_group_array(json_object('billId', billId, 'name', name, 'period', period)) FROM (
		SELECT b.id AS billId, b.name AS name, bp.period AS period FROM bill_payments bp
		JOIN bills b ON b.id = bp.bill_id JOIN transactions part ON part.id = bp.transaction_id
		WHERE part.parent_id = ${parent} AND bp.status = 'linked' GROUP BY b.id, bp.period ORDER BY MIN(bp.id))), '[]')`;

/**
 * SQL that is true while a bill occurrence is still unpaid: its linked payments add up to less than 90% of its
 * amount (decision 74), which is occurrencePaid (src/bills/status.ts) negated, in integer cents. It counts every
 * linked payment, not only a purchase's parts, and judges against the amount the month had (occurrenceAmountSql).
 * A linked payment a bank later turned into a credit counts as $0 (MAX(0, amount)), as the JS sums do.
 * `billId` and `period` are SQL expressions. A bill row that is gone reads as unpaid, so its entry stays.
 */
export const occurrenceUnpaidSql = (billId: string, period: string) =>
	`COALESCE((SELECT (SELECT COALESCE(SUM(MAX(0, pt.amount_cents)), 0) FROM bill_payments paid
			JOIN transactions pt ON pt.id = paid.transaction_id
			WHERE paid.bill_id = ub.id AND paid.period = ${period} AND paid.status = 'linked') * 10
		< ${occurrenceAmountSql("ub.id", occurrenceMonthSql(period, "ub"))} * 9
	FROM bills ub WHERE ub.id = ${billId}), 1)`;

/**
 * SQL for the bills in a stored split_removed_bills value (`column`) that are still unpaid, as the same JSON, or
 * NULL when none. An entry drops once its occurrence is Paid again (decision 105, decision 74's 90%, occurrenceUnpaidSql).
 * An entry without a billId can't be checked, so it stays.
 */
export const STILL_UNPAID_BILLS_SQL = (column: string) =>
	`(SELECT NULLIF(json_group_array(json(e.value)), '[]') FROM json_each(${column}) e
		WHERE json_extract(e.value, '$.billId') IS NULL OR ${occurrenceUnpaidSql("json_extract(e.value, '$.billId')", "json_extract(e.value, '$.period')")})`;
