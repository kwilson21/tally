// The transactions that might belong in a category a person has just made from one transaction (spec §8.4,
// decision 76). Same-merchant rows come ticked; Tally's guesses come unticked, and only for a name Tally
// suggested for them (decision 30). Nothing moves until a person adds them (addLikely).
import { monthsBefore } from "../dates";
import { shownName } from "../transactions/name-suggestions";
import { readAiSwitches } from "./ai-switches";
import { COUNTED_JOINS, paysBillSql } from "./counted-month";
import { merchantColumnSql, sameMerchantSql } from "./merchant-key";
import {
	BILL_NAME_COLUMN,
	COUNTS_IN_MONTH_COLUMN,
	type ListRow,
	MAYBE_CATEGORY_COLUMNS,
	MAYBE_CATEGORY_JOINS,
	NAME_SUGGESTION_COLUMNS,
	NEEDS_CATEGORY,
	REFUNDED_COLUMN,
} from "./transactions";

/** Most rows the panel offers, same merchant first (decision 79). */
export const LIKELY_LIMIT = 6;

export type LikelyRow = ListRow & {
	/** Ticked by default: the same merchant as the transaction the category was made from. */
	sameMerchant: boolean;
};

/** The columns a likely row reads from the database, before its name is worked out. */
type LikelyRecord = Omit<
	LikelyRow,
	| "displayName"
	| "nameSuggested"
	| "nameFromBank"
	| "pending"
	| "sameMerchant"
	| "excluded"
	| "income"
	| "creditReviewed"
	| "maybeCategoryNew"
	| "noteGuessed"
	| "paysBill"
> & {
	merchantName: string | null;
	suggestedNames: string | null;
	suggestionStatus: string | null;
	merchantKey: string;
	pending: number;
	sameMerchant: number;
	excluded: number;
	income: number;
	creditReviewed: number | null;
	maybeCategoryNew: number;
	noteGuessed: number;
	paysBill: number;
};

// A name is worked out as the list works it (NAME_SUGGESTION_COLUMNS and shownName), and a row's note, Maybe chip,
// refunds and caption as the list draws them (MAYBE_CATEGORY_COLUMNS, REFUNDED_COLUMN, BILL_NAME_COLUMN and
// COUNTS_IN_MONTH_COLUMN, and the caption's refund and bank-change fields), so a row reads the same here.
const LIKELY_SELECT = `SELECT t.id AS id, t.date AS date, t.amount_cents AS amountCents, t.raw_name AS rawName,
	${merchantColumnSql("t", "display_name")} AS merchantName, ${NAME_SUGGESTION_COLUMNS}, t.note AS note, t.note_guessed AS noteGuessed,
	t.excluded AS excluded, t.flag_income AS income, t.credit_reviewed AS creditReviewed,
	t.category_id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
	${MAYBE_CATEGORY_COLUMNS}, ${REFUNDED_COLUMN},
	rp.date AS refundPurchaseDate, t.refund_unlinked_purchase_date AS refundUnlinkedPurchaseDate,
	${paysBillSql("t")} AS paysBill, ${BILL_NAME_COLUMN}, ${COUNTS_IN_MONTH_COLUMN},
	t.split_removed_from_cents AS splitRemovedFromCents,
	t.pending AS pending, ${sameMerchantSql("t", "src")} AS sameMerchant
	FROM transactions t ${COUNTED_JOINS}
	${MAYBE_CATEGORY_JOINS}
	JOIN transactions src ON src.id = ?1
	LEFT JOIN categories c ON c.id = t.category_id`;

/** The rows still needing a category, this month and last, that the new category might suit. */
const LIKELY_WHERE = `WHERE ${NEEDS_CATEGORY} AND t.id <> src.id AND t.parent_id IS NULL AND t.pending = 0
	AND substr(t.date, 1, 7) IN (?2, ?3)
	AND (${sameMerchantSql("t", "src")} OR t.category_suggestion_id IN (
		SELECT sug.id FROM category_suggestions sug WHERE sug.status = 'pending' AND sug.name = ?4 COLLATE NOCASE))`;

/**
 * The likely transactions for a category made from `savedId`, named `categoryName`, as of `today` (the
 * household's date). Same merchant first, then guesses, each newest first, up to LIKELY_LIMIT.
 */
export async function likelyTransactions(
	db: D1Database,
	savedId: number,
	categoryName: string,
	today: string,
): Promise<LikelyRow[]> {
	const thisMonth = today.slice(0, 7);
	const { names: namesOn, details: detailsOn } = await readAiSwitches(db);
	const { results } = await db
		.prepare(
			`${LIKELY_SELECT} ${LIKELY_WHERE}
			ORDER BY sameMerchant DESC, t.date DESC, t.id DESC LIMIT ${LIKELY_LIMIT}`,
		)
		.bind(savedId, thisMonth, monthsBefore(thisMonth, 1), categoryName.trim())
		.all<LikelyRecord>();
	return results.map(
		({
			merchantName,
			suggestedNames,
			suggestionStatus,
			merchantKey,
			...row
		}) => {
			const shown = shownName({
				chosen: merchantName,
				stored: suggestedNames,
				status: suggestionStatus,
				key: merchantKey,
				rawName: row.rawName,
				namesOn,
			});
			return {
				...row,
				// A guessed note is hidden while the details switch is off, and dashed while it is on (as the list does).
				note: row.noteGuessed === 1 && !detailsOn ? null : row.note,
				noteGuessed: detailsOn && row.noteGuessed === 1,
				displayName: shown.name,
				nameSuggested: shown.suggested,
				nameFromBank: shown.fromBank,
				excluded: !!row.excluded,
				income: !!row.income,
				creditReviewed: !!row.creditReviewed,
				maybeCategoryNew: !!row.maybeCategoryNew,
				paysBill: !!row.paysBill,
				pending: !!row.pending,
				sameMerchant: !!row.sameMerchant,
			};
		},
	);
}

/**
 * Files the ticked likely transactions in `categoryId` as the person's own pick (`category_source` user),
 * and leaves every other row as it was. Only rows the panel offers now can move, so a ticked row that
 * isn't on the list (already categorized, too old, or never offered) is ignored. Returns how many moved.
 */
export async function addLikely(
	db: D1Database,
	input: {
		savedId: number;
		categoryId: number;
		categoryName: string;
		ticked: number[];
		today: string;
		actor: string;
	},
): Promise<number> {
	const offered = new Set(
		(
			await likelyTransactions(
				db,
				input.savedId,
				input.categoryName,
				input.today,
			)
		).map((row) => row.id),
	);
	const ids = [...new Set(input.ticked)].filter((id) => offered.has(id));
	if (ids.length === 0) return 0;
	const marks = ids.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL,
				jev_none_fit = 0, category_suggestion_id = NULL, split_removed_from_cents = NULL, updated_by = ?, updated_at = datetime('now')
			WHERE category_id IS NULL AND id IN (${marks})`,
		)
		.bind(input.categoryId, input.actor, ...ids)
		.run();
	return result.meta.changes;
}
