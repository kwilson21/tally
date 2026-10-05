// The rule that keeps transfers and card payments out of the budget (spec §8.5, decision 67), in one
// place: sync applies it to what Plaid sends, and anything that frees a transaction from a rule that
// held it back (a bill link coming off) applies it to what is stored.

/** Plaid categories for money that only moves between a family's own accounts or pays down a loan or card. */
const TRANSFER_CATEGORIES = ["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"];

/** SQL that is true when a Plaid category (a column or a bound value) is one of those. The names are constants, never input. */
export const isPlaidTransferSql = (category: string) =>
	`${category} IN (${TRANSFER_CATEGORIES.map((name) => `'${name}'`).join(", ")})`;

/** True when a bill's payment is linked to this transaction: it keeps counting, so the bill isn't paid by something nothing counts. */
export const PAYS_A_BILL =
	"EXISTS (SELECT 1 FROM bill_payments WHERE bill_payments.transaction_id = transactions.id AND bill_payments.status = 'linked')";

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
 * - Plaid's transfer rule doesn't apply to a payment linked to a bill or to a credit a person decided
 *   about, so those keep counting.
 * - Otherwise a transfer category excludes the row, with Plaid as the source unless something already
 *   excludes it (Jev's or an older exclusion keeps its source).
 * - A row Plaid excluded is counted again when the rule no longer applies to it; Jev's and a person's
 *   exclusions stay.
 */
export const plaidTransferRuleSql = (category: string, amount: string) => {
	const excludes = `(${isPlaidTransferSql(category)} AND NOT ${PAYS_A_BILL} AND NOT ${personDecided(amount)})`;
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

/**
 * The rule as one statement for these stored transactions and the parts of any that are split: a part
 * follows its bank transaction's category, and a split a person decided about is left as they set it.
 * For a batch, next to the write that frees them; `applyPlaidTransferRule` runs it alone.
 */
export function plaidTransferRuleStatement(
	db: D1Database,
	transactionIds: number[],
): D1PreparedStatement {
	const ids = transactionIds.map(() => "?").join(", ");
	const ofParent = (column: string) =>
		`(SELECT p.${column} FROM transactions p WHERE p.id = transactions.parent_id)`;
	return db
		.prepare(
			`UPDATE transactions SET ${plaidTransferRuleSql(
				`COALESCE(${ofParent("plaid_category")}, transactions.plaid_category)`,
				"transactions.amount_cents",
			)}
			WHERE (id IN (${ids}) OR parent_id IN (${ids}))
				AND COALESCE(${ofParent("excluded_source")}, '') != 'user'`,
		)
		.bind(...transactionIds, ...transactionIds);
}

/** Applies the rule to stored transactions, for when something that held it back is gone. */
export async function applyPlaidTransferRule(
	db: D1Database,
	transactionIds: number[],
): Promise<void> {
	if (transactionIds.length === 0) return;
	await plaidTransferRuleStatement(db, transactionIds).run();
}
