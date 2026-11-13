// When a bank correction clears a transaction's category. The sync's three statements (the insert-or-update of a page's
// transactions, the update of an existing one, and the What AI did log) all say it, so it is written once, here.
//
// Two cases clear a category, and nothing else does (a person's pick, a bill's, and a row with no category stay):
//   1. Jev's guess, when the amount changed, on a whole transaction that was not split away.
//   2. A merchant rule's pick, when the merchant changed, unless a changed amount just un-split the row.
//
// Each function returns SQL text. A caller says how to name the transaction's columns (`ref`) and what "changed" is
// for it (`BankChange`): in an upsert it compares the stored column with `excluded`, in an UPDATE it compares with a
// bound `?`. A bound `?` in a change appears in the order the fragment uses it, so a caller binds the values in that order:
// the amount for each place it is used, then the merchant.
// test/bank-clears-category.test.ts checks them against a plain statement of the two cases, over every row shape.

/** How a statement names one column of the transaction: `transactions.category_source`, or just `category_source`. */
export type ColumnRef = (column: string) => string;

/** A column named bare, as in `UPDATE transactions SET …` or a subquery on the table alone. */
export const bareColumn: ColumnRef = (column) => column;

/** A column named through the table's name or alias, as in an upsert's `DO UPDATE SET` (`transactions.amount_cents`). */
export const columnOf =
	(alias: string): ColumnRef =>
	(column) =>
		`${alias}.${column}`;

/** SQL for "the amount changed" and "the merchant changed", each a condition in the caller's terms. */
export type BankChange = { amount: string; merchant: string };

/** Case 1 alone: Jev's guess is let go of because the amount changed. */
export function jevGuessClearedByAmountSql(
	ref: ColumnRef,
	amountChanged: string,
): string {
	return `(${ref("is_split")} = 0 AND ${ref("category_source")} = 'jev' AND ${ref("split_removed_from_cents")} IS NULL AND ${amountChanged})`;
}

/** Both cases: the category is cleared. */
export function bankClearsCategorySql(
	ref: ColumnRef,
	change: BankChange,
): string {
	return `(${jevGuessClearedByAmountSql(ref, change.amount)} OR (NOT (${ref("is_split")} = 1 AND ${change.amount}) AND ${ref("split_removed_from_cents")} IS NULL AND ${ref("category_source")} = 'merchant_rule' AND ${change.merchant}))`;
}

/** The two assignments of an UPDATE's SET list: the category and its source go to NULL together, or stay. */
export function setCategoryClearedByBankSql(
	ref: ColumnRef,
	change: BankChange,
): string {
	const cleared = bankClearsCategorySql(ref, change);

	return `category_id = CASE WHEN ${cleared} THEN NULL ELSE ${ref("category_id")} END,
		category_source = CASE WHEN ${cleared} THEN NULL ELSE ${ref("category_source")} END`;
}
