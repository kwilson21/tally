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
 * FOLLOWS_PURCHASE for a linked credit, in TypeScript, for the edit panel and the route, which decide before a
 * save. It is the credit's own part: the purchase must still be linked and not excluded, which the caller checks.
 * Keep it in step with FOLLOWS_PURCHASE (the tests check that they agree).
 */
export function followsPurchase(credit: {
	amountCents: number;
	income: boolean;
	creditReviewed: boolean;
}): boolean {
	return credit.amountCents < 0 && !credit.income && credit.creditReviewed;
}

/**
 * True when a bill's payment is linked to the transaction `alias` names, or, for a split part, to its
 * parent: the bank transaction that paid the bill was split afterwards, so the whole of it, every part,
 * is that payment. `alias` is a table alias or `transactions` itself (an UPDATE has no alias). A part with
 * a link of its own is the same row, so it is read as paying a bill once, never twice.
 */
export const paysBillSql = (alias: string) =>
	`EXISTS (SELECT 1 FROM bill_payments linked_bill WHERE linked_bill.status = 'linked' AND linked_bill.transaction_id IN (${alias}.id, ${alias}.parent_id))`;

/**
 * True when a planned expense's linked payment is the transaction `alias` names, or, for a split part, its parent
 * (decision 82): the plan twin of paysBillSql. A plan's payment keeps its own category and counts on its own date;
 * the link only keeps an excluded payment in the budget, once, as a bill's link does.
 */
export const paysPlanSql = (alias: string) =>
	`EXISTS (SELECT 1 FROM planned_expenses linked_plan WHERE linked_plan.transaction_id IN (${alias}.id, ${alias}.parent_id))`;

/**
 * The payment group of the transaction `alias` names: the transaction, its split parent and its own parts (decision 82).
 * Two parts of one split are separate money, so a bill and a plan may each take a different part, as two bills may.
 */
const paymentGroupSql = (alias: string) =>
	`SELECT g.id FROM transactions g WHERE g.id IN (${alias}.id, ${alias}.parent_id) OR g.parent_id = ${alias}.id`;

/** True when a bill's payment is in the payment group of `alias` (paymentGroupSql). */
export const paysBillGroupSql = (alias: string) =>
	`EXISTS (SELECT 1 FROM bill_payments group_bill WHERE group_bill.status = 'linked' AND group_bill.transaction_id IN (${paymentGroupSql(alias)}))`;

/** True when a planned expense's payment is in the payment group of `alias` (paymentGroupSql). */
export const paysPlanGroupSql = (alias: string) =>
	`EXISTS (SELECT 1 FROM planned_expenses group_plan WHERE group_plan.transaction_id IN (${paymentGroupSql(alias)}))`;

/** True when the transaction `alias` names pays a bill or a planned expense (paysBillSql, paysPlanSql). */
export const paysBillOrPlanSql = (alias: string) =>
	`(${paysBillSql(alias)} OR ${paysPlanSql(alias)})`;

/**
 * True when a transaction isn't left out of the budget (spec §6.1 rule 4, §8.5): it is not excluded, or
 * it pays a bill or a planned expense. A payment linked to a bill counts in Spent whatever its exclusion, so the bill counts
 * once; its exclusion is never written over by the link, so it is as it was when the link goes. A split
 * part counts on its own link or its parent's (the parent itself never counts once split, so a bank
 * transaction is counted by its parts once). Alias `t`. `paysBill` is the SQL that says the row pays a bill or a
 * planned expense: a merge passes the link it is about to give the row, and the default is the row's own links.
 */
export const includedSql = (
	alias: string,
	paysBill = paysBillOrPlanSql(alias),
) => `(${alias}.excluded = 0 OR ${paysBill})`;

/**
 * includedSql in TypeScript, for a row as a save leaves it: not excluded, or paying a bill or a planned expense.
 * `excluded` is the exclusion once saved (excludedAfterSave in src/transactions/edit.ts), so a lifted Plaid exclusion
 * counts. Keep it in step with includedSql; the callers feed jevAsksAbout's `included` from it.
 */
export function isIncluded(
	excluded: boolean,
	paysBillOrPlan: boolean,
): boolean {
	return !excluded || paysBillOrPlan;
}

/**
 * Whether Jev can be asked about the category of the row `alias` names, as jevAsksAbout (rename.ts) says for a
 * row as a save leaves it: included, not a split, not income, and not a refund that follows its purchase. This
 * is the rows pendingForJev classifies (NEEDS_JEV_CLASSIFICATION and NOT FOLLOWS_PURCHASE in
 * src/db/transactions.ts); keep it in step with them, and with jevAsksAbout. Qualify every column: INCLUDED_ROW
 * is unqualified, so it is ambiguous inside an UPDATE ... FROM transactions AS p. `paysBill` is as includedSql's.
 */
export const jevAsksAboutSql = (
	alias: string,
	paysBill = paysBillOrPlanSql(alias),
) =>
	`(${includedSql(alias, paysBill)} AND ${alias}.is_split = 0 AND ${alias}.flag_income = 0
		AND NOT (${alias}.amount_cents < 0 AND COALESCE(${alias}.credit_reviewed, 0) = 1
			AND EXISTS (SELECT 1 FROM transactions jrp WHERE jrp.id = ${alias}.refund_of_id AND jrp.excluded = 0)))`;

/** Tally or the bank marked it as a transfer. */
export const markedTransferSql = (alias: string) =>
	`(${alias}.flag_transfer = 1 OR COALESCE(${alias}.excluded_source = 'plaid', 0))`;

export const INCLUDED = includedSql("t");

/** True when the row pays a bill or a planned expense, for an UPDATE or subquery on `transactions` itself. */
export const PAYS_A_BILL_OR_PLAN = paysBillOrPlanSql("transactions");

/** `INCLUDED` for an UPDATE or subquery on `transactions` itself. */
export const INCLUDED_ROW = `(excluded = 0 OR ${PAYS_A_BILL_OR_PLAN})`;

/**
 * What counts as spending, once the joins are added (spec §6): not excluded (or paying a bill), not a
 * split parent (its parts count), not income, and not an unreviewed bank credit; a refund that follows
 * its purchase counts. Home's budget rows, last month's amount and Trends all use this one definition.
 */
export const COUNTED_SPENDING = `${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0
	AND (t.amount_cents >= 0 OR t.credit_reviewed = 1 OR ${FOLLOWS_PURCHASE})`;

/** Any transaction that contributes to a month, including income and counted refunds. */
export const COUNTED_TRANSACTION = `${INCLUDED} AND t.is_split = 0
	AND (t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE})`;

/**
 * The month a bill occurrence is for, as SQL (billPeriodMonth is the TypeScript twin): a yearly bill's anchor
 * month, a quarter's first month, a week's or fortnight's month (its period is the date), else the period itself.
 * `period` is the SQL for the payment's period and `bill` the alias of its bill row.
 */
export function occurrenceMonthSql(period: string, bill: string) {
	const quarterMonth = `printf('%s-%02d',substr(${period},1,4),(((${bill}.anchor_month-1+(((CAST(substr(${period},7,1) AS INTEGER)-(((${bill}.anchor_month-1)/3)+1)+4)%4)*3))%12)+1))`;
	return `CASE WHEN ${bill}.frequency='yearly' THEN ${period} || '-' || printf('%02d',${bill}.anchor_month) WHEN ${bill}.frequency IN ('weekly','biweekly') THEN substr(${period},1,7) WHEN ${bill}.frequency='quarterly' THEN ${quarterMonth} ELSE ${period} END`;
}

/** The month a transaction's own date and bill payment put it in. */
function billMonthSql(transaction: string, payment: string, bill: string) {
	const bankMonth = `substr(${transaction}.date,1,7)`;
	const occurrenceMonth = occurrenceMonthSql(`${payment}.period`, bill);
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

/** A bill, as the counting rule reads it: its frequency and, for a yearly or quarterly bill, its anchor month. */
export type CountedBill = {
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchorMonth: number | null;
};

/**
 * The month a bill's period is for, in TypeScript, as occurrenceMonthSql reads it (the SQL that billMonthSql and
 * occurrenceUnpaidSql use): a yearly bill's anchor month, a quarter's first month, a week's or fortnight's month
 * (its period is the date), else the period itself. The bills page works this out before a payment is linked.
 * Keep it in step with occurrenceMonthSql; the refunds test checks that they agree for every frequency.
 */
export function billPeriodMonth(bill: CountedBill, period: string): string {
	if (bill.frequency === "yearly")
		return `${period}-${String(bill.anchorMonth ?? 1).padStart(2, "0")}`;
	if (bill.frequency === "weekly" || bill.frequency === "biweekly")
		return period.slice(0, 7);
	if (bill.frequency === "quarterly") {
		const anchor = bill.anchorMonth ?? 1;
		const firstQuarter = Math.floor((anchor - 1) / 3) + 1;
		const quarter = Number(period.slice(6, 7));
		const month =
			((anchor - 1 + ((quarter - firstQuarter + 4) % 4) * 3) % 12) + 1;
		return `${period.slice(0, 4)}-${String(month).padStart(2, "0")}`;
	}
	return period;
}

/**
 * The month a linked bill payment counts in, in TypeScript, as countedMonthSql() reads it: the period's month
 * when that is earlier than the bank's month, else the bank's month. `bankMonth` is YYYY-MM. Keep it in step with
 * countedMonthSql(); the refunds test checks that they agree for every frequency, early and late payments alike.
 */
export function billPaymentMonth(
	bill: CountedBill,
	period: string,
	bankMonth: string,
): string {
	const occurrence = billPeriodMonth(bill, period);
	return occurrence < bankMonth ? occurrence : bankMonth;
}
