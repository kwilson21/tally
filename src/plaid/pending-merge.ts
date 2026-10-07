/**
 * The bank posts a pending transaction under a new id, and the posted one was already stored before
 * its link to the pending one arrived (spec section 6, decision 67). Sync normally lets the pending row
 * take the posted id; here both rows exist, so what a person attached to the pending row moves onto the
 * posted row and the pending row is deleted, all in the page's own batch.
 *
 * What moves, and what wins:
 * - A person's category, note, exclusion and income choice move over a machine's value on the posted
 *   row. Where the posted row already holds a person's choice, it keeps it.
 * - Tally's own answer (Jev's category pick and how sure it was, its transfer, reimbursement and income
 *   answers, decision 79) moves too, when the amount is unchanged and the posted row has no answer or
 *   choice of its own, so the posted row isn't asked again for nothing. A merchant rule's pick doesn't
 *   move: rules run on the posted row as on any new one. An exclusion Plaid put on the posted row is
 *   not an answer of its own (spec section 8.5): Jev's exclusion of the pending row moves over it and
 *   keeps its source, as it does when the pending row simply takes the posted id, so it still holds
 *   if Plaid later stops calling the posted row a transfer.
 * - A bill payment is re-pointed to the posted row unless that row already pays a bill (one bill per
 *   transaction); a refund of the pending row now refunds the posted one, and the pending row's own
 *   refund link moves unless the posted row has one.
 * - A split moves with its parts, which follow the posted date, when the amount is unchanged and the
 *   posted row has no split of its own; when the amount changed it is removed and the posted row says the
 *   amount changed, as for any bank correction (decision 62).
 * Every statement checks that both rows still exist and that this run still holds the Item's lock, so
 * a replay or a lost lock changes nothing.
 */

// Parameters, shared by every statement: 1 the pending id, 2 the posted id, 3 the bank's amount in
// cents now, 4 and 5 the Item row and its lock, 6 to 8 the posted date, bank text and merchant name.
import { hasIncomeAnswerSql } from "../db/income";

/** A person choice or Jev's stored answer means a posted flag already has an answer. */
function hasAnswerSql(personChoice: string, jevAnswer: string) {
	return `(COALESCE((${personChoice}), 0) OR COALESCE((${jevAnswer}), 0))`;
}

const PENDING =
	"(SELECT id FROM transactions WHERE plaid_transaction_id = ?1 AND pending = 1)";
const POSTED = "(SELECT id FROM transactions WHERE plaid_transaction_id = ?2)";
const READY = `${PENDING} IS NOT NULL AND ${POSTED} IS NOT NULL AND EXISTS (
	SELECT 1 FROM plaid_items WHERE id = ?4 AND sync_lock_id = ?5 AND disconnected_at IS NULL)`;

/** A person's choice, as the posted row `transactions` takes it from the pending row `p`. */
const FROM_PENDING = `FROM transactions AS p WHERE p.id = ${PENDING} AND transactions.id = ${POSTED} AND ${READY}`;

// A split part (`transactions`) has a choice of its own only when a person made it on that part (its source
// is 'user', as saving the edit panel on the part records it) and it differs from the pending purchase's
// (`pe`). Anything else is what the part was made with, or what a machine said, and follows the posted row.
// Saving the panel on the purchase changes the purchase and not its parts, so a part still holding what it
// inherited is never its own choice.
const OWN_EXCLUSION = `transactions.excluded_source = 'user'
	AND (transactions.excluded IS NOT pe.excluded OR pe.excluded_source IS NOT 'user')`;
const OWN_INCOME =
	"transactions.income_source = 'user' AND pe.income_source IS NOT 'user'";
const OWN_REVIEW = `transactions.credit_reviewed_by = 'user'
	AND (transactions.credit_reviewed IS NOT pe.credit_reviewed OR pe.credit_reviewed_by IS NOT 'user')`;

const STATEMENTS = [
	// Category: a person's pick on the pending row wins over anything but a person's pick on the posted one.
	`UPDATE transactions SET category_id = p.category_id, category_source = 'user', category_confidence = NULL
	 ${FROM_PENDING} AND p.category_source = 'user' AND p.category_id IS NOT NULL
	 AND COALESCE(transactions.category_source, '') != 'user'`,
	// Note: a note the posted row already has is kept.
	`UPDATE transactions SET note = p.note
	 ${FROM_PENDING} AND COALESCE(p.note, '') != '' AND COALESCE(transactions.note, '') = ''`,
	// Exclusion, with the flags it came with.
	`UPDATE transactions SET excluded = p.excluded, excluded_source = 'user',
		flag_transfer = p.flag_transfer, flag_reimbursement = p.flag_reimbursement
	 ${FROM_PENDING} AND p.excluded_source = 'user' AND COALESCE(transactions.excluded_source, '') != 'user'`,
	// Income choice, and a credit's review.
	`UPDATE transactions SET flag_income = p.flag_income, income_source = 'user'
	 ${FROM_PENDING} AND p.income_source = 'user' AND COALESCE(transactions.income_source, '') != 'user'`,
	`UPDATE transactions SET credit_reviewed = p.credit_reviewed, credit_reviewed_by = 'user'
	 ${FROM_PENDING} AND p.credit_reviewed_by = 'user' AND COALESCE(transactions.credit_reviewed_by, '') != 'user'`,
	// Tally's own answer, after the person's choices above, so it only fills what's still unanswered. Each
	// answer was made for the pending amount, so it moves only while the amount is unchanged; a changed
	// amount is a new question, as for any bank correction.
	// Jev's category: a confident pick, or one below the threshold kept with its confidence (decision 27).
	`UPDATE transactions SET category_id = p.category_id, category_source = p.category_source,
		category_confidence = p.category_confidence, jev_category_id = p.jev_category_id,
		jev_none_fit = p.jev_none_fit
	 ${FROM_PENDING} AND p.category_confidence IS NOT NULL AND p.amount_cents = ?3
	 AND transactions.category_id IS NULL AND transactions.category_source IS NULL
	 AND transactions.category_confidence IS NULL`,
	// A transfer or reimbursement flag that excluded it, which a person can undo on the posted row as before.
	// It moves onto a row nothing excludes, and onto one Plaid excluded (a transfer category on the posted
	// row), where it takes over the source: Jev's exclusion stands if Plaid drops the category later.
	`UPDATE transactions SET excluded = p.excluded, excluded_source = 'jev',
		flag_transfer = p.flag_transfer, flag_reimbursement = p.flag_reimbursement
	 ${FROM_PENDING} AND p.excluded_source = 'jev' AND p.amount_cents = ?3
	 AND (transactions.excluded_source = 'plaid'
		OR (transactions.excluded = 0 AND transactions.excluded_source IS NULL))`,
	// Its income answer, and the credit review a confident answer gives a credit.
	`UPDATE transactions SET flag_income = p.flag_income, income_source = 'jev'
	 ${FROM_PENDING} AND p.income_source = 'jev' AND p.amount_cents = ?3
	 AND transactions.income_source IS NULL AND transactions.flag_income = 0
	 AND transactions.credit_reviewed_by IS NULL`,
	// Uncertain flag answers move only when the posted row has no confidence of its own, like category_confidence.
	`UPDATE transactions SET income_confidence = p.income_confidence
	 ${FROM_PENDING} AND p.income_confidence IS NOT NULL AND p.amount_cents = ?3
		AND NOT (${hasIncomeAnswerSql("transactions")} OR transactions.income_confidence IS NOT NULL OR (COALESCE(?9 = 'INCOME', 0) AND ?3 < 0))`,
	`UPDATE transactions SET transfer_confidence = p.transfer_confidence
	 ${FROM_PENDING} AND p.transfer_confidence IS NOT NULL AND p.amount_cents = ?3
	 AND NOT ${hasAnswerSql(
			"transactions.excluded_source = 'user'",
			"transactions.excluded_source = 'jev' OR transactions.transfer_confidence IS NOT NULL",
		)}`,
	`UPDATE transactions SET credit_reviewed = 1
	 ${FROM_PENDING} AND p.amount_cents < 0 AND p.amount_cents = ?3 AND p.credit_reviewed = 1
	 AND p.credit_reviewed_by IS NULL AND p.category_confidence IS NOT NULL
	 AND COALESCE(transactions.credit_reviewed, 0) = 0 AND transactions.credit_reviewed_by IS NULL`,
	`UPDATE transactions SET updated_by = p.updated_by
	 ${FROM_PENDING} AND p.updated_by IS NOT NULL AND transactions.updated_by IS NULL`,
	// A bill payment (and a dismissal) moves, unless the posted row is already linked to a bill.
	`UPDATE bill_payments SET transaction_id = ${POSTED}
	 WHERE transaction_id = ${PENDING} AND ${READY}
	 AND (status = 'dismissed' OR NOT EXISTS (
		SELECT 1 FROM bill_payments other WHERE other.transaction_id = ${POSTED} AND other.status = 'linked'))`,
	// Refunds, both ways.
	`UPDATE transactions SET refund_of_id = ${POSTED}
	 WHERE refund_of_id = ${PENDING} AND id != ${POSTED} AND ${READY}`,
	`UPDATE transactions SET refund_of_id = p.refund_of_id
	 ${FROM_PENDING} AND p.refund_of_id IS NOT NULL AND p.refund_of_id != transactions.id
	 AND transactions.refund_of_id IS NULL`,
	// A split: its parts move when the amount is unchanged and the posted row has none of its own. A split
	// is one bank transaction, so a part follows the posted row's exclusion and review (the columns saving
	// a split copies from its purchase): else a purchase a person excluded while pending but included once
	// posted would have neither it nor its parts counted. A part keeps a choice of its own (above), per group:
	// exclusion with its source, income source, credit review with who made it. The pending row is still
	// unchanged here.
	`UPDATE transactions SET parent_id = ne.id, date = ?6, raw_name = ?7, merchant_name = ?8,
		excluded = CASE WHEN ${OWN_EXCLUSION} THEN transactions.excluded ELSE ne.excluded END,
		excluded_source = CASE WHEN ${OWN_EXCLUSION} THEN transactions.excluded_source ELSE ne.excluded_source END,
		income_source = CASE WHEN ${OWN_INCOME} THEN transactions.income_source ELSE ne.income_source END,
		credit_reviewed = CASE WHEN ${OWN_REVIEW} THEN transactions.credit_reviewed ELSE ne.credit_reviewed END,
		credit_reviewed_by = CASE WHEN ${OWN_REVIEW} THEN transactions.credit_reviewed_by ELSE ne.credit_reviewed_by END
	 FROM transactions AS pe, transactions AS ne
	 WHERE pe.id = ${PENDING} AND ne.id = ${POSTED} AND transactions.parent_id = pe.id AND ${READY}
	 AND pe.is_split = 1 AND pe.amount_cents = ?3 AND ne.is_split = 0
	 AND NOT EXISTS (SELECT 1 FROM transactions part WHERE part.parent_id = ne.id)`,
	`UPDATE transactions SET is_split = 1, split_removed_from_cents = NULL
	 WHERE id = ${POSTED} AND is_split = 0 AND ${READY}
	 AND EXISTS (SELECT 1 FROM transactions part WHERE part.parent_id = ${POSTED})`,
	// When the amount changed instead, the posted row says its split was removed (the parts go with the pending row).
	`UPDATE transactions SET split_removed_from_cents = p.amount_cents
	 ${FROM_PENDING} AND p.is_split = 1 AND p.amount_cents != ?3
	 AND transactions.is_split = 0 AND transactions.split_removed_from_cents IS NULL`,
	// Last, the pending row goes, with whatever didn't move (its parts, a bill link, a refund link).
	`DELETE FROM transactions WHERE id = ${PENDING} AND ${READY}`,
];

/** The statements that move a pending row's attachments onto the posted row already stored, then delete it. */
export function mergePendingIntoPosted(
	db: D1Database,
	itemRowId: number,
	lockId: string,
	pendingId: string,
	posted: {
		id: string;
		cents: number;
		date: string;
		name: string;
		merchantName: string | null;
		plaidCategory: string | null;
	},
): D1PreparedStatement[] {
	const values = [
		pendingId,
		posted.id,
		posted.cents,
		itemRowId,
		lockId,
		posted.date,
		posted.name,
		posted.merchantName,
		posted.plaidCategory,
	];
	// D1 wants exactly as many values as the statement's highest numbered parameter.
	return STATEMENTS.map((sql) =>
		db.prepare(sql).bind(...values.slice(0, highestParameter(sql))),
	);
}

const highestParameter = (sql: string) =>
	Math.max(...[...sql.matchAll(/\?(\d)/g)].map((found) => Number(found[1])));
