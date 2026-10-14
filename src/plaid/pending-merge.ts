/**
 * The bank posts a pending transaction under a new id, and the posted one was already stored before
 * its link to the pending one arrived (spec section 6, decision 67). Sync normally lets the pending row
 * take the posted id; here both rows exist, so what a person attached to the pending row moves onto the
 * posted row and the pending row is deleted, all in the page's own batch.
 *
 * What moves, and what wins:
 * - A person's category, note, own name (decision 101), exclusion and income choice move over a machine's
 *   value on the posted row. Where the posted row already holds a person's choice, it keeps it.
 * - Tally's own answer (Jev's category pick and how sure it was, its transfer, reimbursement and income
 *   answers, decision 79) moves too, when the amount is unchanged and the posted row has no answer or
 *   choice of its own, so the posted row isn't asked again for nothing. A name the pending row alone got
 *   clears the posted row's Jev answer, since that answer was for the old name, so the night run asks again
 *   with the name; it clears only where Jev can be asked about the row (jevAsksAboutSql), so a row a person or
 *   Plaid took out of the budget keeps its answer. A merchant rule's pick doesn't move: rules run on the posted
 *   row as on any new one. Jev's pick, none-fit and mixed-trip reading also move onto a posted row that keeps a category of its
 *   own (a rule's or a person's) but has no Jev answer; never onto a split purchase.
 *   An exclusion Plaid put on the posted row is not an answer of its own (spec section 8.5): Jev's exclusion
 *   of the pending row moves over it and
 *   keeps its source, as it does when the pending row simply takes the posted id, so it still holds
 *   if Plaid later stops calling the posted row a transfer.
 * - A bill payment is re-pointed to the posted row unless that row already pays a bill (one bill per
 *   transaction); a refund of the pending row now refunds the posted one, and the pending row's own
 *   refund link moves unless the posted row has one. A posted row that takes that link drops its own
 *   note that a bank change unlinked a refund (decision 99). The pending row's note moves too, unless
 *   the posted row has a refund link of its own.
 * - A split moves with its parts, which follow the posted date, when the amount is unchanged and the
 *   posted row has no split of its own; when the amount changed it is removed and the posted row says the
 *   amount changed, as for any bank correction (decision 62). It takes the category the purchase had before
 *   its split, unless a person picked the posted row's own category, and Jev's answers on the posted row are
 *   cleared with it, as in a same-row bank correction (they described the old amount). A split with none
 *   leaves the posted row in Needs category with the note. A refund of one of its parts is unlinked with the
 *   purchase's date (decision 99). When the posted row keeps its own split, a pending part's bill payment stays paid on
 *   the posted part with the same amount and category, and otherwise it is unlinked, with no dismissal, so the matcher
 *   may link it again when it still matches (decisions 99 and 105). A person's own Not this one on a pending part moves
 *   to the posted row, and each posted part starts with it.
 * - Tally's AI log of what it did (spec section 5) follows the category it counts: its row moves to the posted row
 *   only when the pending row's category moves with it, so a person's later change is counted only on a category
 *   Tally still holds. Otherwise the row keeps counting with no transaction. An income row always moves.
 * Every statement checks that both rows still exist and that this run still holds the Item's lock, so
 * a replay or a lost lock changes nothing.
 */

// Parameters, shared by every statement: 1 the pending id, 2 the posted id, 3 the bank's amount in
// cents now, 4 and 5 the Item row and its lock, 6 to 8 the posted date, bank text and merchant name.
import {
	movePartDismissalsSql,
	purchaseDismissalsToPartsSql,
} from "../bills/split-dismissals";
import { UNPAID_BILLS_SQL } from "../bills/unpaid";
import { jevAsksAboutSql, paysBillSql } from "../db/counted-month";
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

/**
 * Whether the posted row pays a bill once the pending row's bill payments have moved onto it (the bill statement below):
 * it pays one already, or a linked payment of the pending row moves to it. A dismissed payment moves too but doesn't pay.
 */
const POSTED_PAYS_ONCE_MOVED = `(${paysBillSql("transactions")} OR EXISTS (
	SELECT 1 FROM bill_payments moved WHERE moved.status = 'linked' AND moved.transaction_id = ${PENDING}))`;

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

/**
 * Whether the pending row's Kind (or For, the same way) replaces the posted row's. A Kind a person chose or
 * cleared on the posted row always stays. Otherwise a posted row with nothing takes the pending row's, and a
 * posted guess gives way only to a pending person's choice or clear: a pending guess, or an empty Kind with a
 * zero guess flag, never wipes it (#315). A deliberate clear is an answer, so it moves over (#304).
 */
const takesDetailSql = (value: string, guessed: string, cleared: string) =>
	`(transactions.${cleared} = 0 AND (transactions.${value} IS NULL
		OR (transactions.${guessed} = 1 AND (p.${cleared} = 1 OR (p.${value} IS NOT NULL AND p.${guessed} = 0)))))`;
const KIND_TAKEN = takesDetailSql("kind", "kind_guessed", "kind_cleared");
const PERSON_TAKEN = takesDetailSql(
	"for_person_id",
	"for_person_guessed",
	"for_person_cleared",
);

// Which category log row moves with the pending row's category (the first statement below). Each arm mirrors the
// category statement it names, so a change to that statement must change its arm too. `p` is the pending row, `t` the posted.
/** Mirrors the first category statement: a person's pick on the pending row moves onto the posted row. */
const LOG_PERSON_PICK = `p.category_source = 'user' AND p.category_id IS NOT NULL
	AND COALESCE(t.category_source, '') != 'user'`;
/** Mirrors Jev's category statement: Jev's answer moves onto a posted row with no category, at the same amount, never a split. */
const LOG_JEV_PICK = `p.category_confidence IS NOT NULL AND p.amount_cents = ?3
	AND t.category_id IS NULL AND t.category_source IS NULL AND t.category_confidence IS NULL AND t.is_split = 0`;
/** Mirrors the split statement that takes the pre-split category when the amount changed. */
const LOG_SPLIT_CATEGORY = `p.is_split = 1 AND p.amount_cents != ?3
	AND t.is_split = 0 AND t.split_removed_from_cents IS NULL AND COALESCE(t.category_source, '') != 'user'`;

/**
 * The posted row's part a pending part's linked bill payment moves to: its lowest-id part with the same amount and
 * category and no linked payment of its own, as saveSplit keeps one (decision 99). Correlated to the payment's row.
 */
const KEEP_PART = `(SELECT part.id FROM transactions part, transactions pp
	WHERE pp.id = bill_payments.transaction_id AND part.parent_id = ${POSTED}
	AND part.amount_cents = pp.amount_cents AND part.category_id IS pp.category_id
	AND NOT EXISTS (SELECT 1 FROM bill_payments own WHERE own.transaction_id = part.id AND own.status = 'linked')
	ORDER BY part.id LIMIT 1)`;

const STATEMENTS = [
	// Tally's log of the pending row's category (spec section 5) moves to the posted row only when that category moves with
	// it: a person's pick, Jev's answer at the same amount onto a posted row with no category, or a removed split's category.
	// Otherwise the row stays on the pending id (see the income and delete statements below). It runs before the category
	// statements, which change the columns Jev's arm tests.
	`UPDATE OR IGNORE ai_log SET transaction_id = ${POSTED}
	 WHERE kind = 'category' AND transaction_id = ${PENDING} AND ${READY}
	 AND EXISTS (SELECT 1 FROM transactions AS p, transactions AS t
		WHERE p.id = ${PENDING} AND t.id = ${POSTED}
		AND (${LOG_PERSON_PICK} OR ${LOG_JEV_PICK} OR ${LOG_SPLIT_CATEGORY}))`,
	// Category: a person's pick on the pending row wins over anything but a person's pick on the posted one.
	`UPDATE transactions SET category_id = p.category_id, category_source = 'user', category_confidence = NULL
	 ${FROM_PENDING} AND p.category_source = 'user' AND p.category_id IS NOT NULL
	 AND COALESCE(transactions.category_source, '') != 'user'`,
	// Note: a note the posted row already has is kept.
	`UPDATE transactions SET note = p.note, note_guessed = p.note_guessed
	 ${FROM_PENDING} AND COALESCE(p.note, '') != '' AND COALESCE(transactions.note, '') = ''`,
	// Kept details beat guesses; a posted person's answer, or a clear, always wins.
	`UPDATE transactions SET
		kind = CASE WHEN ${KIND_TAKEN} THEN p.kind ELSE transactions.kind END,
		kind_guessed = CASE WHEN ${KIND_TAKEN} THEN p.kind_guessed ELSE transactions.kind_guessed END,
		kind_cleared = CASE WHEN ${KIND_TAKEN} THEN p.kind_cleared ELSE transactions.kind_cleared END,
		for_person_id = CASE WHEN ${PERSON_TAKEN} THEN p.for_person_id ELSE transactions.for_person_id END,
		for_person_guessed = CASE WHEN ${PERSON_TAKEN} THEN p.for_person_guessed ELSE transactions.for_person_guessed END,
		for_person_cleared = CASE WHEN ${PERSON_TAKEN} THEN p.for_person_cleared ELSE transactions.for_person_cleared END,
		details_asked = MAX(transactions.details_asked, p.details_asked),
		note_worth_writing = COALESCE(transactions.note_worth_writing, p.note_worth_writing),
		note_guessed = CASE WHEN COALESCE(transactions.note, '') = '' AND COALESCE(p.note, '') != '' THEN p.note_guessed ELSE transactions.note_guessed END,
		note_tried_at = COALESCE(transactions.note_tried_at, p.note_tried_at),
		note_failed_at = COALESCE(transactions.note_failed_at, p.note_failed_at),
		note_dismissed = MAX(transactions.note_dismissed, p.note_dismissed)
	 ${FROM_PENDING} AND (p.kind IS NOT NULL OR p.for_person_id IS NOT NULL OR p.details_asked = 1 OR p.kind_cleared = 1 OR p.for_person_cleared = 1 OR p.note_tried_at IS NOT NULL OR p.note_dismissed = 1)`,
	// Jev's unsure transfer score goes before the exclusions below: a copied exclusion would otherwise look like
	// the posted row's own answer, and the score would be lost (#309).
	`UPDATE transactions SET transfer_confidence = p.transfer_confidence
	 ${FROM_PENDING} AND p.transfer_confidence IS NOT NULL AND p.amount_cents = ?3
	 AND NOT ${hasAnswerSql(
			"transactions.excluded_source = 'user'",
			"transactions.excluded_source = 'jev' OR transactions.transfer_confidence IS NOT NULL",
		)}`,
	// Exclusion, with the flags it came with.
	`UPDATE transactions SET excluded = p.excluded, excluded_source = 'user',
		flag_transfer = p.flag_transfer, flag_reimbursement = p.flag_reimbursement
	 ${FROM_PENDING} AND p.excluded_source = 'user' AND COALESCE(transactions.excluded_source, '') != 'user'`,
	// Income choice, and a credit's review.
	`UPDATE transactions SET flag_income = p.flag_income, income_source = 'user'
	 ${FROM_PENDING} AND p.income_source = 'user' AND COALESCE(transactions.income_source, '') != 'user'`,
	`UPDATE transactions SET credit_reviewed = p.credit_reviewed, credit_reviewed_by = 'user'
	 ${FROM_PENDING} AND p.credit_reviewed_by = 'user' AND COALESCE(transactions.credit_reviewed_by, '') != 'user'`,
	// A name a person gave the pending row alone clears Tally's answer on the posted row, which was made for the old
	// name, so the night run asks again with it. Only Jev's pick and an empty category (an unsure answer included):
	// a person's pick and a merchant rule's stay. Only where Jev can be asked about the posted row and the pending
	// one as they now stand, after the person's exclusion, income and review moves above: a row taken out of the
	// budget keeps its answer. The posted row is judged as the bill payments below will leave it (POSTED_PAYS_ONCE_MOVED),
	// since a linked payment can take an excluded row into the budget (#408); the pending row is judged as it stands, before
	// they move off it. It runs before the name moves, since moving the name is the condition it reads.
	`UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL,
		category_suggestion_id = NULL, jev_category_id = NULL, jev_none_fit = 0, jev_mixed = NULL, jev_also_category_id = NULL
	 ${FROM_PENDING} AND p.own_name IS NOT NULL AND transactions.own_name IS NULL
	 AND (transactions.category_source = 'jev' OR (transactions.category_id IS NULL
		AND transactions.category_source IS NULL))
	 AND ${jevAsksAboutSql("transactions", POSTED_PAYS_ONCE_MOVED)} AND ${jevAsksAboutSql("p")}`,
	// This one only (decision 101): a name a person gave the pending row alone is kept, unless the posted row has its own.
	`UPDATE transactions SET own_name = p.own_name
	 ${FROM_PENDING} AND p.own_name IS NOT NULL AND transactions.own_name IS NULL`,
	// Tally's own answer, after the person's choices above, so it only fills what's still unanswered. Each
	// answer was made for the pending amount, so it moves only while the amount is unchanged; a changed
	// amount is a new question, as for any bank correction.
	// Jev's category: a confident pick, or one below the threshold kept with its confidence (decision 27).
	// A split purchase takes none of Jev's answers, here or in the statement below.
	`UPDATE transactions SET category_id = p.category_id, category_source = p.category_source,
		category_confidence = p.category_confidence, jev_category_id = p.jev_category_id,
		jev_none_fit = p.jev_none_fit, jev_mixed = p.jev_mixed, jev_also_category_id = p.jev_also_category_id
	 ${FROM_PENDING} AND p.category_confidence IS NOT NULL AND p.amount_cents = ?3
	 AND transactions.category_id IS NULL AND transactions.category_source IS NULL
	 AND transactions.category_confidence IS NULL AND transactions.is_split = 0`,
	// Jev's pick, none-fit and mixed-trip reading move onto a posted row with a category of its own and no Jev answer, which
	// the category statement above leaves alone. A split purchase keeps no mixed-trip reading, so it takes none. It moves no category, so it needs no ai_log arm.
	`UPDATE transactions SET jev_category_id = p.jev_category_id, jev_none_fit = p.jev_none_fit, jev_mixed = p.jev_mixed,
		jev_also_category_id = p.jev_also_category_id
	 ${FROM_PENDING} AND p.amount_cents = ?3
	 AND (p.jev_category_id IS NOT NULL OR p.jev_none_fit = 1 OR p.jev_mixed IS NOT NULL)
	 AND transactions.jev_category_id IS NULL AND transactions.jev_none_fit = 0 AND transactions.jev_mixed IS NULL
	 AND transactions.category_confidence IS NULL AND transactions.is_split = 0`,
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
	`UPDATE transactions SET credit_reviewed = 1
	 ${FROM_PENDING} AND p.amount_cents < 0 AND p.amount_cents = ?3 AND p.credit_reviewed = 1
	 AND p.credit_reviewed_by IS NULL AND p.category_confidence IS NOT NULL
	 AND COALESCE(transactions.credit_reviewed, 0) = 0 AND transactions.credit_reviewed_by IS NULL`,
	`UPDATE transactions SET updated_by = p.updated_by
	 ${FROM_PENDING} AND p.updated_by IS NOT NULL AND transactions.updated_by IS NULL`,
	// A No on a Maybe income or transfer (decision 101) is the person's choice, so it moves with their other choices
	// whatever the amount, as the same-row sync keeps it when the amount changes: the posted row isn't asked again.
	`UPDATE transactions SET income_maybe_declined = MAX(transactions.income_maybe_declined, p.income_maybe_declined),
		transfer_maybe_declined = MAX(transactions.transfer_maybe_declined, p.transfer_maybe_declined)
	 ${FROM_PENDING} AND (p.income_maybe_declined = 1 OR p.transfer_maybe_declined = 1)`,
	// A bill payment (and a dismissal) moves, unless the posted row is already linked to a bill.
	`UPDATE bill_payments SET transaction_id = ${POSTED}
	 WHERE transaction_id = ${PENDING} AND ${READY}
	 AND (status = 'dismissed' OR NOT EXISTS (
		SELECT 1 FROM bill_payments other WHERE other.transaction_id = ${POSTED} AND other.status = 'linked'))`,
	// Refunds, both ways.
	`UPDATE transactions SET refund_of_id = ${POSTED}
	 WHERE refund_of_id = ${PENDING} AND id != ${POSTED} AND ${READY}`,
	`UPDATE transactions SET refund_of_id = p.refund_of_id, refund_unlinked_purchase_date = NULL
	 ${FROM_PENDING} AND p.refund_of_id IS NOT NULL AND p.refund_of_id != transactions.id
	 AND transactions.refund_of_id IS NULL`,
	`UPDATE transactions SET refund_unlinked_purchase_date = p.refund_unlinked_purchase_date
	 ${FROM_PENDING} AND p.refund_unlinked_purchase_date IS NOT NULL AND transactions.refund_of_id IS NULL
	 AND transactions.refund_unlinked_purchase_date IS NULL`,
	// A split: its parts move when the amount is unchanged and the posted row has none of its own. A split
	// is one bank transaction, so a part follows the posted row's exclusion and review (the columns saving
	// a split copies from its purchase): else a purchase a person excluded while pending but included once
	// posted would have neither it nor its parts counted. A part keeps a choice of its own (above), per group:
	// exclusion with its source, income source, credit review with who made it. The pending row is still
	// unchanged here.
	// The posted row is a narrow CTE, not a second copy of transactions: D1 refuses an UPDATE ... FROM whose tables
	// add up to more than 100 columns, and transactions has 50.
	`WITH ne(id, is_split, excluded, excluded_source, income_source, credit_reviewed, credit_reviewed_by) AS (
		SELECT id, is_split, excluded, excluded_source, income_source, credit_reviewed, credit_reviewed_by
		FROM transactions WHERE id = ${POSTED})
	 UPDATE transactions SET parent_id = ne.id, date = ?6, raw_name = ?7, merchant_name = ?8,
		excluded = CASE WHEN ${OWN_EXCLUSION} THEN transactions.excluded ELSE ne.excluded END,
		excluded_source = CASE WHEN ${OWN_EXCLUSION} THEN transactions.excluded_source ELSE ne.excluded_source END,
		income_source = CASE WHEN ${OWN_INCOME} THEN transactions.income_source ELSE ne.income_source END,
		credit_reviewed = CASE WHEN ${OWN_REVIEW} THEN transactions.credit_reviewed ELSE ne.credit_reviewed END,
		credit_reviewed_by = CASE WHEN ${OWN_REVIEW} THEN transactions.credit_reviewed_by ELSE ne.credit_reviewed_by END
	 -- Only the columns read come from the pending row, and the posted row is the narrow CTE above: whole copies
	 -- of transactions in one UPDATE ... FROM go past D1's 100-column limit ("too many columns in result set").
	 FROM (SELECT id, is_split, amount_cents, excluded, excluded_source, income_source, credit_reviewed, credit_reviewed_by
	       FROM transactions WHERE plaid_transaction_id = ?1 AND pending = 1) AS pe, ne
	 WHERE ne.id = ${POSTED} AND transactions.parent_id = pe.id AND ${READY}
	 AND pe.is_split = 1 AND pe.amount_cents = ?3 AND ne.is_split = 0
	 AND NOT EXISTS (SELECT 1 FROM transactions part WHERE part.parent_id = ne.id)`,
	`UPDATE transactions SET is_split = 1, split_removed_from_cents = NULL, split_removed_bills = NULL, jev_mixed = NULL, jev_also_category_id = NULL
	 WHERE id = ${POSTED} AND is_split = 0 AND ${READY}
	 AND EXISTS (SELECT 1 FROM transactions part WHERE part.parent_id = ${POSTED})`,
	// When the amount changed instead, the posted row says its split was removed (the parts go with the pending row),
	// and takes the category the pending purchase had before its split, as sync does (decision 99), nulls included,
	// so a split with no category leaves it in Needs category with the note. A person's pick on the posted row stays.
	// Jev's answers described the old amount, so they are cleared as in a same-row bank correction, unless a person
	// picked the posted row's category.
	`UPDATE transactions SET split_removed_from_cents = p.amount_cents,
		split_removed_bills = ${UNPAID_BILLS_SQL(PENDING)},
		category_id = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.category_id ELSE p.category_id END,
		category_source = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.category_source ELSE p.category_source END,
		category_confidence = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.category_confidence ELSE NULL END,
		category_suggestion_id = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.category_suggestion_id ELSE NULL END,
		jev_category_id = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.jev_category_id ELSE NULL END,
		jev_none_fit = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.jev_none_fit ELSE 0 END,
		jev_mixed = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.jev_mixed ELSE NULL END,
		jev_also_category_id = CASE WHEN COALESCE(transactions.category_source, '') = 'user' THEN transactions.jev_also_category_id ELSE NULL END
	 ${FROM_PENDING} AND p.is_split = 1 AND p.amount_cents != ?3
	 AND transactions.is_split = 0 AND transactions.split_removed_from_cents IS NULL`,
	// A refund of one of those parts is unlinked, and its row says which purchase changed, with the pending
	// purchase's date, until a person links it again (decision 99), as sync does. Its parts are deleted below.
	`UPDATE transactions SET refund_of_id = NULL, refund_unlinked_purchase_date = (SELECT p.date FROM transactions p WHERE p.id = ${PENDING})
	 WHERE refund_of_id IN (SELECT part.id FROM transactions part WHERE part.parent_id = ${PENDING})
	 AND EXISTS (SELECT 1 FROM transactions p WHERE p.id = ${PENDING} AND p.is_split = 1 AND p.amount_cents != ?3)
	 AND ${READY}`,
	// When the posted row keeps its own split, a pending part's linked bill payment stays paid on the posted part with the
	// same amount and category that has no payment of its own, as saveSplit keeps one (decision 99). When no such part is
	// left for it (two pending payments for one posted part), OR IGNORE leaves it on the pending part, which unlinks it below.
	`UPDATE OR IGNORE bill_payments SET transaction_id = ${KEEP_PART}
	 WHERE status = 'linked' AND transaction_id IN (SELECT id FROM transactions WHERE parent_id = ${PENDING})
	 AND ${READY} AND ${KEEP_PART} IS NOT NULL`,
	// A person's own Not this one on a pending part moves to the posted row, and each posted part starts with the posted
	// row's (decision 105). Both run while the pending parts still hang under the pending row, before the delete below.
	movePartDismissalsSql(PENDING, POSTED, READY),
	purchaseDismissalsToPartsSql(POSTED, READY),
	// A pending part's bill payment that the posted part didn't keep goes with the pending row's delete below, with no
	// dismissal, so the matcher may link it again when it still matches (decisions 99 and 105). The parts that moved to
	// the posted row are not the pending row's parts any more, so their payments stay with them.
	// Tally's log of the pending row's income moves to the posted row (spec section 5). It always moves, since the tally
	// never reads the transaction of an income row, so it can't miscount. A category row moved above, with its category.
	`UPDATE OR IGNORE ai_log SET transaction_id = ${POSTED} WHERE kind = 'income' AND transaction_id = ${PENDING} AND ${READY}`,
	// A log row of the pending row whose kind the posted row already has is dropped with it: the posted row's own row already
	// counts that purchase, so one purchase is never counted twice (spec section 8.6, one category row and one income row per
	// transaction). A category row that neither moved nor collided stays on the pending id. The trigger ai_log_forget_deleted
	// (migration 0041) clears its transaction_id when the final DELETE below removes the pending row, so it still counts, with
	// no transaction. No statement here sets that id to NULL itself (sync.ts does, for a Jev category a bank correction clears).
	`DELETE FROM ai_log WHERE transaction_id = ${PENDING} AND ${READY}
	 AND EXISTS (SELECT 1 FROM ai_log own WHERE own.transaction_id = ${POSTED} AND own.kind = ai_log.kind)`,
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
