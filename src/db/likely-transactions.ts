// The transactions that might belong in a category a person has just made from one transaction (spec §8.4,
// decision 76). Same-merchant rows come ticked; Tally's guesses come unticked, and only for a name Tally
// suggested for them (decision 30). Nothing moves until a person adds them (addLikely).
import { STILL_UNPAID_BILLS_SQL } from "../bills/unpaid";
import { monthsBefore } from "../dates";
import { sameName } from "../settings/category-form";
import { shownName } from "../transactions/name-suggestions";
import { tidyName } from "../transactions/tidy-name";
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
	t.split_removed_from_cents AS splitRemovedFromCents, ${STILL_UNPAID_BILLS_SQL("t.split_removed_bills")} AS splitRemovedBills,
	t.pending AS pending, ${sameMerchantSql("t", "src")} AS sameMerchant
	FROM transactions t ${COUNTED_JOINS}
	${MAYBE_CATEGORY_JOINS}
	JOIN transactions src ON src.id = ?1
	LEFT JOIN categories c ON c.id = t.category_id`;

/**
 * The rows still needing a category, this month and last, that the new category might suit. ?4 is the JSON list
 * of the pending suggestions the name matches (matchingSuggestionIds); the status is checked live here too.
 */
const LIKELY_WHERE = `WHERE ${NEEDS_CATEGORY} AND t.id <> src.id AND t.parent_id IS NULL AND t.pending = 0
	AND substr(t.date, 1, 7) IN (?2, ?3)
	AND (${sameMerchantSql("t", "src")} OR t.category_suggestion_id IN (
		SELECT sug.id FROM category_suggestions sug WHERE sug.status = 'pending' AND sug.id IN (SELECT value FROM json_each(?4))))`;

/**
 * The pending suggestions a category named `categoryName` takes in: the same name in any capitals or accents, as
 * createFromSuggestion matches them (sameName, since SQL NOCASE folds ASCII only).
 */
async function matchingSuggestionIds(
	db: D1Database,
	categoryName: string,
): Promise<number[]> {
	const { results } = await db
		.prepare(
			"SELECT id, name FROM category_suggestions WHERE status = 'pending'",
		)
		.all<{ id: number; name: string }>();
	return results
		.filter((sug) => sameName(tidyName(sug.name), categoryName))
		.map((sug) => sug.id);
}

/**
 * The ?1-?4 parameters every likely statement binds: the saved transaction, this month and last month, and the
 * JSON list of matching pending suggestions (matchingSuggestionIds).
 */
async function likelyBinds(
	db: D1Database,
	savedId: number,
	categoryName: string,
	today: string,
): Promise<[number, string, string, string]> {
	const thisMonth = today.slice(0, 7);
	return [
		savedId,
		thisMonth,
		monthsBefore(thisMonth, 1),
		JSON.stringify(await matchingSuggestionIds(db, categoryName)),
	];
}

/** The ticked ids as Add files them: each once, and only whole positive numbers (a bad form field drops out). */
const tickedIds = (ticked: number[]) =>
	[...new Set(ticked)].filter((id) => Number.isInteger(id) && id > 0);

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
	const { names: namesOn, details: detailsOn } = await readAiSwitches(db);
	const { results } = await db
		.prepare(
			`${LIKELY_SELECT} ${LIKELY_WHERE}
			ORDER BY sameMerchant DESC, t.date DESC, t.id DESC LIMIT ${LIKELY_LIMIT}`,
		)
		.bind(...(await likelyBinds(db, savedId, categoryName, today)))
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
 * The ticked ids that Add would still file for a category named `categoryName`, made from `savedId`, as of
 * `today`: the same rules as addLikely, with no six-row limit, so the Add count matches what Add files.
 */
export async function likelyStill(
	db: D1Database,
	input: {
		savedId: number;
		categoryName: string;
		today: string;
		ticked: number[];
	},
): Promise<number[]> {
	const ids = tickedIds(input.ticked);
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT t.id AS id FROM transactions t ${COUNTED_JOINS} JOIN transactions src ON src.id = ?1 ${LIKELY_WHERE}
				AND t.id IN (SELECT value FROM json_each(?5))`,
		)
		.bind(
			...(await likelyBinds(
				db,
				input.savedId,
				input.categoryName,
				input.today,
			)),
			JSON.stringify(ids),
		)
		.all<{ id: number }>();
	return results.map((row) => row.id);
}

/**
 * Files the ticked likely transactions in `categoryId` as the person's own pick (`category_source` user),
 * and leaves every other row as it was. Only rows the panel's rules still allow can move (still needing a
 * category, this month or last, same merchant or a matching pending guess), whatever the six-row limit now
 * shows, so a ticked row that is no longer eligible (already categorized, too old, or never offered) is
 * ignored. Returns how many moved.
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
	const ids = tickedIds(input.ticked);
	if (ids.length === 0) return 0;
	// The write applies the panel's own rules, in the same statement, so a row that changed since the
	// read (excluded, income, pending, or its guess withdrawn) is left alone, and so is every row when the
	// category was archived since the read. ?1-?4 are the panel's parameters (likelyBinds), ?5 and ?6 the
	// category and actor (?5 is checked live in the same statement too), and ?7 the ticked ids as JSON.
	const result = await db
		.prepare(
			`UPDATE transactions SET category_id = ?5, category_source = 'user', category_confidence = NULL,
				jev_none_fit = 0, category_suggestion_id = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?6, updated_at = datetime('now')
			WHERE category_id IS NULL AND EXISTS (SELECT 1 FROM categories WHERE id = ?5 AND archived = 0) AND id IN (
				SELECT t.id FROM transactions t ${COUNTED_JOINS} JOIN transactions src ON src.id = ?1 ${LIKELY_WHERE}
				AND t.id IN (SELECT value FROM json_each(?7)))`,
		)
		.bind(
			...(await likelyBinds(
				db,
				input.savedId,
				input.categoryName,
				input.today,
			)),
			input.categoryId,
			input.actor,
			JSON.stringify(ids),
		)
		.run();
	return result.meta.changes;
}
