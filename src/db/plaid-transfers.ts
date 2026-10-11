// The rule that keeps transfers and card payments out of the budget at sync (spec §8.5, decision 67).
//
// It decides only the exclusion a row has. A payment linked to a bill counts in Spent whatever that
// exclusion is (spec §6.1 rule 4), decided where spending is read (`INCLUDED` in counted-month.ts), so
// this rule needs no exception for bill payments, and removing a link leaves the exclusion as it was.

/** Plaid categories for money that only moves between a family's own accounts or pays down a loan or card. */
const TRANSFER_CATEGORIES = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"];

/** SQL that is true when a Plaid category (a column or a bound value) is one of those. The names are constants, never input. */
export const isPlaidTransferSql = (category: string) =>
	`${category} IN (${TRANSFER_CATEGORIES.map((name) => `'${name}'`).join(", ")})`;

/**
 * True when a person decided what this transaction is (decision 70): income they chose, which stays
 * counted as income, or a credit they reviewed, but only while it is still a credit. `amount` is SQL
 * for the row's amount after this write, so a reviewed credit the bank turns into money out loses
 * the exception.
 */
const personDecided = (amount: string) =>
	`((COALESCE(transactions.income_source, '') = 'user' AND transactions.flag_income = 1) OR (${amount} < 0 AND COALESCE(transactions.credit_reviewed_by, '') = 'user'))`;

/**
 * The `excluded` and `excluded_source` assignments of an UPDATE of `transactions` (spec §8.5).
 * `category` and `amount` are SQL for the row's Plaid category and its amount after this write; each
 * repeats once per assignment, so bound values go in as category, amount, category, amount.
 * - A person's exclude or include is never touched.
 * - Plaid's transfer rule doesn't apply to a credit a person decided about, which keeps counting.
 * - Otherwise a transfer category excludes the row, with Plaid as the source unless something already
 *   excludes it (Jev's or an older exclusion keeps its source).
 * - A row Plaid excluded is counted again when the rule no longer applies to it; Jev's and a person's
 *   exclusions stay.
 */
export const plaidTransferRuleSql = (category: string, amount: string) => {
	const excludes = `(${isPlaidTransferSql(category)} AND NOT ${personDecided(amount)})`;
	return `excluded = CASE
	WHEN transactions.excluded_source = 'user' THEN transactions.excluded
	WHEN ${excludes} THEN 1
	WHEN transactions.excluded_source = 'plaid' THEN 0
	ELSE transactions.excluded END,
excluded_source = CASE
	WHEN transactions.excluded_source = 'user' THEN 'user'
	WHEN ${excludes} THEN CASE WHEN transactions.excluded = 1 THEN transactions.excluded_source ELSE 'plaid' END
	WHEN transactions.excluded_source = 'plaid' THEN NULL
	ELSE transactions.excluded_source END`;
};
