// The rules that keep transfers and card payments out of the budget (spec §8.5, decision 67), in one
// place: sync applies Plaid's to what Plaid sends, and anything that removes a bill link applies both
// Plaid's and Jev's to what is stored.
//
// A machine's exclusion (Plaid's or Jev's) is set aside, not erased, while a bill link stands: a
// payment that pays a bill counts (`excluded = 0`) and keeps its source, so removing the link brings
// the exclusion back. A person's choice (`excluded_source = 'user'`) is never set aside or brought back.

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
 * - A payment linked to a bill is left exactly as it is: it counts while linked, and whatever exclusion
 *   it has been set aside under stays for when the link is removed.
 * - Plaid's transfer rule doesn't apply to a credit a person decided about, which keeps counting.
 * - Otherwise a transfer category excludes the row, with Plaid as the source unless something already
 *   excludes it (Jev's or an older exclusion keeps its source).
 * - A row Plaid excluded is counted again when the rule no longer applies to it; Jev's and a person's
 *   exclusions stay.
 */
export const plaidTransferRuleSql = (category: string, amount: string) => {
	const excludes = `(${isPlaidTransferSql(category)} AND NOT ${personDecided(amount)})`;
	return `excluded = CASE
	WHEN transactions.excluded_source = 'user' OR ${PAYS_A_BILL} THEN transactions.excluded
	WHEN ${excludes} THEN 1
	WHEN transactions.excluded_source = 'plaid' THEN 0
	ELSE transactions.excluded END,
excluded_source = CASE
	WHEN transactions.excluded_source = 'user' OR ${PAYS_A_BILL} THEN transactions.excluded_source
	WHEN ${excludes} THEN CASE WHEN transactions.excluded = 1 THEN transactions.excluded_source ELSE 'plaid' END
	WHEN transactions.excluded_source = 'plaid' THEN NULL
	ELSE transactions.excluded_source END`;
};

/** The column's value on the bank transaction a split part belongs to, null for any other row. */
const ofParent = (column: string) =>
	`(SELECT p.${column} FROM transactions p WHERE p.id = transactions.parent_id)`;

/**
 * Which rows these ids stand for: each of them, and the whole split any of them belongs to (its parent
 * and every part), since a split is one bank transaction and is excluded and put back whole. The ids are
 * numbered parameters ?1 to ?n, each bound once, so a statement binds the list once.
 */
const familyOf = (count: number) => {
	const ids = Array.from({ length: count }, (_, i) => `?${i + 1}`).join(", ");
	const parents = `SELECT g.parent_id FROM transactions g WHERE g.id IN (${ids})`;
	return `(transactions.id IN (${ids}) OR transactions.parent_id IN (${ids})
		OR transactions.id IN (${parents}) OR transactions.parent_id IN (${parents}))`;
};

/** How many ids one statement takes: D1 allows 100 bound values, and each id is bound once. */
const IDS_PER_STATEMENT = 90;
const inChunks = (ids: number[]) => {
	const chunks: number[][] = [];
	for (let at = 0; at < ids.length; at += IDS_PER_STATEMENT)
		chunks.push(ids.slice(at, at + IDS_PER_STATEMENT));
	return chunks;
};

/**
 * Plaid's rule as one statement for these stored transactions and their splits: a part follows its bank
 * transaction's category, and a split a person decided about is left as they set it. At most 90 ids.
 * For a batch, next to the write that frees them; `applyPlaidTransferRule` runs it alone.
 */
export function plaidTransferRuleStatement(
	db: D1Database,
	transactionIds: number[],
): D1PreparedStatement {
	return db
		.prepare(
			`UPDATE transactions SET ${plaidTransferRuleSql(
				`COALESCE(${ofParent("plaid_category")}, transactions.plaid_category)`,
				"transactions.amount_cents",
			)}
			WHERE ${familyOf(transactionIds.length)}
				AND COALESCE(${ofParent("excluded_source")}, '') != 'user'`,
		)
		.bind(...transactionIds);
}

/**
 * Jev's exclusion, brought back for these stored transactions and their splits once nothing holds it
 * back: a row Jev excluded (`excluded_source = 'jev'`) that is counted only because a bill link stood,
 * and still has Jev's transfer or reimbursement flag, is excluded again. A part follows its parent's
 * flags. A person's choice, a payment that still pays a bill and a credit a person decided about are
 * never touched. At most 90 ids.
 */
export function jevExclusionStatement(
	db: D1Database,
	transactionIds: number[],
): D1PreparedStatement {
	const flag = (column: string) =>
		`COALESCE(${ofParent(column)}, transactions.${column}) = 1`;
	return db
		.prepare(
			`UPDATE transactions SET excluded = 1
			WHERE excluded = 0 AND excluded_source = 'jev'
				AND ${familyOf(transactionIds.length)}
				AND (${flag("flag_transfer")} OR ${flag("flag_reimbursement")})
				AND NOT ${PAYS_A_BILL}
				AND NOT ${personDecided("transactions.amount_cents")}`,
		)
		.bind(...transactionIds);
}

/**
 * The statements that give a machine's exclusion back to transactions a bill link no longer holds
 * (Plaid's rule, then Jev's), for the batch of the write that removes the link. Nothing for no ids.
 */
export function restoreExclusionStatements(
	db: D1Database,
	transactionIds: number[],
): D1PreparedStatement[] {
	return inChunks(transactionIds).flatMap((ids) => [
		plaidTransferRuleStatement(db, ids),
		jevExclusionStatement(db, ids),
	]);
}

/** Applies Plaid's rule to stored transactions, for when something that held it back is gone. */
export async function applyPlaidTransferRule(
	db: D1Database,
	transactionIds: number[],
): Promise<void> {
	for (const ids of inChunks(transactionIds))
		await plaidTransferRuleStatement(db, ids).run();
}

/** Gives a machine's exclusion back to stored transactions, on its own (the batched form is the usual one). */
export async function restoreExclusions(
	db: D1Database,
	transactionIds: number[],
): Promise<void> {
	const statements = restoreExclusionStatements(db, transactionIds);
	if (statements.length > 0) await db.batch(statements);
}
