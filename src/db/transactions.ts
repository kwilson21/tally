import { JEV_THRESHOLD, type JevInput } from "../ai/categorize";
import { confidenceBasisPoints } from "../ai/confidence";
import type { Decision } from "../ai/decide";
import { unsureBounds } from "../ai/maybe";
import {
	movePartDismissalsSql,
	purchaseDismissalsToPartsSql,
} from "../bills/split-dismissals";
import {
	parseUnpaidBills,
	STILL_UNPAID_BILLS_SQL,
	type UnpaidBill,
} from "../bills/unpaid";
import { householdToday } from "../dates";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import {
	type Edit,
	followsPurchaseAfterSave,
	merchantRuleChange,
} from "../transactions/edit";
import {
	type AmountSearch,
	type Filters,
	likePattern,
	type SearchMatch,
	type Show,
	searchAmount,
} from "../transactions/filters";
import {
	type NameSource,
	nameSource,
	offeredNames,
	shownName,
	usableSuggestedNames,
} from "../transactions/name-suggestions";
import { type OwnedRow, oneOffGuessesAgain } from "../transactions/rename";
import type { SplitPart } from "../transactions/split";
import { tidyName } from "../transactions/tidy-name";
import { JEV_ANSWER_LOG_SQL, KEPT_NAME_LOG_SQL } from "./ai-log";
import { readAiSwitches, STILL_ON_SQL, stillOnKeys } from "./ai-switches";
import {
	COUNTED_JOINS,
	COUNTED_SPENDING,
	countedCategorySql,
	countedMonthSql,
	FOLLOWS_PURCHASE,
	followsPurchase,
	INCLUDED,
	INCLUDED_ROW,
	includedSql,
	jevAsksAboutSql,
	markedTransferSql,
	PAYS_A_BILL,
	paysBillSql,
} from "./counted-month";
import { maybeIncomeConfidenceSql, plaidSetIncomeSql } from "./income";
import {
	merchantColumnSql,
	merchantKeySql,
	sameMerchantSql,
} from "./merchant-key";
import { SETTLE_SUGGESTION_SQL } from "./merchant-names";
import { CLEAR_MERCHANT_RULE_SQL } from "./merchant-rules";
import { neverSuggestedSql } from "./never-suggest";
import { ownNameSql } from "./own-name";
import {
	refundedByOthersSql,
	refundFitsSql,
	refundLeftCents,
	splitPartMisfitSql,
	unlinkSplitOverRefundedSql,
} from "./refunded";

/** A note is empty only when it contains no non-space text; Jev, Workers AI and saves share this rule. */
const EMPTY_NOTE = "(t.note IS NULL OR trim(t.note) = '')";

const COUNTED_MONTH = countedMonthSql();
const COUNTED_CATEGORY = countedCategorySql();
// A split part is its own row, stored as posted; it is as pending as its parent (the purchase), read
// from the parent so there's nothing to keep in sync. Needs the parent joined as `p`.
const PENDING_SQL =
	"CASE WHEN t.parent_id IS NOT NULL THEN p.pending ELSE t.pending END";

export type ListRow = {
	id: number;
	date: string;
	amountCents: number;
	rawName: string;
	displayName: string;
	note: string | null;
	noteGuessed?: boolean;
	/** As stored: a person's or a machine's exclusion. A payment linked to a bill counts all the same (`paysBill`). */
	excluded: boolean;
	/** Linked to a bill's occurrence: it counts in Spent whatever its exclusion, and isn't shown as excluded. */
	paysBill?: boolean;
	/** The linked bill whose payment this transaction is. */
	billName?: string | null;
	income: boolean;
	incomeConfidence?: number | null;
	creditReviewed: boolean;
	categoryId: number | null;
	categoryName: string | null;
	categoryIcon: string | null;
	categoryColor: string | null;
	countsInMonth?: string | null;
	parentId?: number | null;
	parentName?: string | null;
	parentBillName?: string | null;
	isSplit?: boolean;
	splitRemovedFromCents?: number | null;
	/** The bills a bank change's removed split unlinked, as JSON (decision 99); read with parseUnpaidBills. */
	splitRemovedBills?: string | null;
	refundOfId?: number | null;
	refundPurchaseDate?: string | null;
	/** The purchase's date when a bank change unlinked this refund, until a person links it again (decision 99). */
	refundUnlinkedPurchaseDate?: string | null;
	/** A linked refund whose purchase counts, so it takes that purchase's month and category. */
	followsPurchase?: boolean;
	refundedCents?: number;
	/** The bank hasn't finished it: it counts like any other, and says "Pending" (decision 67). */
	pending?: boolean;
	/** The name is a suggestion nobody has chosen yet, so the row draws it dashed (P29 A, decision 64). */
	nameSuggested?: boolean;
	maybeCategoryName?: string | null;
	maybeCategoryNew?: boolean;
	/** The suggested name is the bank's own, so it has no sparkles icon (P87 B, decision 80). */
	nameFromBank?: boolean;
};

/** What a row needs from its merchant to decide the name it shows (src/transactions/name-suggestions.ts). */
export const NAME_SUGGESTION_COLUMNS = `${merchantColumnSql("t", "suggested_name")} AS suggestedNames, ${merchantColumnSql("t", "suggestion_status")} AS suggestionStatus, ${merchantKeySql("t")} AS merchantKey`;
type NameSuggestionColumns = {
	suggestedNames: string | null;
	suggestionStatus: string | null;
	merchantKey: string;
};

// What a row's Maybe chip and "$X refunded" caption read. The list, the edit panel and the likely
// transactions panel all draw rows from these, so a row looks the same in each (src/views/transaction-row.tsx).
/** The joins behind the Maybe chip: Tally's category guess, and the pending suggestion a new category came from. */
export const MAYBE_CATEGORY_JOINS = `LEFT JOIN categories maybeCat ON maybeCat.id = t.jev_category_id AND maybeCat.archived=0
	LEFT JOIN category_suggestions cs ON cs.id = t.category_suggestion_id AND cs.status = 'pending' AND NOT ${neverSuggestedSql("t", "new_category")}`;
/** The Maybe chip's category name (a new one as "new:name"), and whether it is a new one; needs MAYBE_CATEGORY_JOINS. */
export const MAYBE_CATEGORY_COLUMNS = `CASE WHEN cs.id IS NOT NULL AND t.category_id IS NULL AND t.category_source IS NULL THEN 'new:' || cs.name WHEN t.category_id IS NULL AND t.category_source IS NULL AND t.category_confidence < ${JEV_THRESHOLD} THEN maybeCat.name END AS maybeCategoryName,
	CASE WHEN cs.id IS NOT NULL THEN 1 ELSE 0 END AS maybeCategoryNew`;
/** What the refunds linked to a purchase add up to, for its "$X refunded" caption. */
export const REFUNDED_COLUMN = `(SELECT COALESCE(-SUM(r.amount_cents),0) FROM transactions r WHERE r.refund_of_id=t.id AND r.is_split=0 AND r.excluded=0 AND r.amount_cents<0 AND r.flag_income=0 AND COALESCE(r.credit_reviewed,0)=1 AND t.excluded=0) AS refundedCents`;
/** The bill a payment is linked to, for its "paid … bill" caption; needs `t`. */
export const BILL_NAME_COLUMN = `(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=t.id AND bp.status='linked' LIMIT 1) AS billName`;
/** The month a bill moved the row into, for its "Counts in …" caption, when it isn't the row's own month; needs COUNTED_JOINS. */
export const COUNTS_IN_MONTH_COLUMN = `CASE WHEN ${COUNTED_MONTH} != substr(t.date,1,7) THEN ${COUNTED_MONTH} END AS countsInMonth`;

/**
 * True when a merchant's pending, unchosen suggested names (one per line) hold the search text; one `?`.
 * With the names switch off only the bank's own name is offered (a suggestion equal to the merchant's
 * key, src/transactions/name-suggestions.ts), so only that one can match.
 */
const suggestedNameMatch = (namesOn: boolean) =>
	`EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("t")} AND m.suggestion_status = 'pending' AND m.display_name IS NULL${namesOn ? "" : " AND m.suggested_name = m.raw_name"} AND m.suggested_name LIKE ? ESCAPE '\\')`;

/** The note a row shows; with the details switch off a guessed note is hidden (#314). Needs `t`. */
const visibleNoteSql = (detailsOn: boolean) =>
	detailsOn
		? "t.note"
		: "CASE WHEN t.note_guessed = 1 THEN NULL ELSE t.note END";

export const PAGE_SIZE = 25;

// "Needs category" mirrors Home's effective category: linked refunds follow the purchase,
// while held credits and income stay out of spending classification.
/** A transaction that still needs a category (Home's count, Organize's list). Needs `t` and COUNTED_JOINS. */
export const NEEDS_CATEGORY = `${COUNTED_CATEGORY} IS NULL AND ${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE} AND (t.amount_cents >= 0 OR t.credit_reviewed = 1)`;
export const OLDER_NEEDS_CATEGORY_SQL = `SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS}
	WHERE (t.date < ?1 OR (t.date >= ?1 AND t.date < ?2 AND ${COUNTED_MONTH} < ?3))
	AND ${NEEDS_CATEGORY}`;
const bankRowSql = (sql: string) => sql.replaceAll(" AND t.is_split = 0", "");
// Jev must be allowed to classify a new credit as income or another known kind of credit.
const NEEDS_JEV_CLASSIFICATION = `${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND (((COALESCE(t.income_source, '') != 'user' AND COALESCE(t.credit_reviewed_by, '') != 'user') AND ((t.category_id IS NULL AND t.category_source IS NULL) OR (t.amount_cents < 0 AND COALESCE(t.credit_reviewed, 0) = 0))) OR (t.category_id IS NULL AND t.category_source IS NULL AND t.amount_cents < 0 AND t.credit_reviewed = 1 AND (t.income_source = 'user' OR t.credit_reviewed_by = 'user')))`;

/**
 * What each Show choice holds (spec §8.4, decision 74), once COUNTED_JOINS and the split parent `p`
 * are joined. The kinds can overlap: a refund that follows its purchase is both Spending and a Refund.
 * "In the budget" is `INCLUDED` throughout: a payment linked to a bill counts whatever its exclusion
 * (decision 83), so it is never Excluded, and Refunds and Excluded never share a row.
 * - Spending: what Home counts, so the list adds up to Home's Spent.
 * - Income: flagged income.
 * - Refunds: money in (a negative amount) that isn't income or a transfer and is in the budget or
 *   waiting to be, so a refund nobody linked and a credit nobody has identified are here. A credit
 *   linked to a bill is here whatever its transfer flag or exclusion, since it is never Excluded
 *   (spec §8.5). A split refund shows by its parts, as it counts; a part doesn't carry its parent's
 *   income or transfer flag, so it is a refund only when its parent isn't income or a transfer either.
 * - Excluded: left out of the budget, where transfers and card payments go (the old Excluded chip),
 *   so not a payment linked to a bill (spec §8.5). A split shows by its parts, as the others do, so
 *   it lists exactly what How Tally works' excluded count counts (`excludedBreakdown`).
 */
const SHOW_SQL: Record<Show, string | null> = {
	all: null,
	spending: `(${COUNTED_SPENDING})`,
	income: "t.flag_income = 1",
	refunds: `(t.amount_cents < 0 AND t.flag_income = 0 AND COALESCE(p.flag_income, 0) = 0 AND t.is_split = 0
		AND (${paysBillSql("t")} OR (t.excluded = 0 AND t.flag_transfer = 0 AND COALESCE(p.flag_transfer, 0) = 0)))`,
	excluded: `(NOT ${INCLUDED} AND t.is_split = 0)`,
};
const RAW_SHOW_SQL: Record<Show, string | null> = {
	...SHOW_SQL,
	spending: bankRowSql(SHOW_SQL.spending ?? ""),
	refunds: bankRowSql(SHOW_SQL.refunds ?? ""),
	excluded: bankRowSql(SHOW_SQL.excluded ?? ""),
};

/**
 * What the filters match, as SQL (#211, #321): the joins their terms read, and the terms with their binds,
 * in order, to be AND-ed. The list and Select all share it, so a filter added later reaches both.
 */
export function filterMatch(
	f: Filters,
	namesOn: boolean,
	detailsOn: boolean,
	ids?: number[],
) {
	const where: string[] = [];
	const args: (string | number)[] = [];
	const rowMonth = f.raw ? "substr(t.date,1,7)" : COUNTED_MONTH;
	const rowCategory = f.raw ? "t.category_id" : COUNTED_CATEGORY;
	if (f.month !== "all") {
		where.push(`${rowMonth} = ?`);
		args.push(f.month);
	}
	if (f.category !== null) {
		where.push(`${rowCategory} = ?`);
		if (!f.raw) where.push("t.is_split = 0");
		args.push(f.category);
	}
	if (f.account !== null) {
		where.push("t.account_id = ?");
		args.push(f.account);
	}
	if (f.uncategorized && !f.raw) where.push(NEEDS_CATEGORY);
	// The bank sent one transaction; a split's parts are a person's own division of it (the demo's raw view).
	if (f.raw) where.push("t.parent_id IS NULL");
	// Ticked rows that are not in the list on screen (#350): split parents have no tick, and an unknown id drops out.
	if (ids) {
		where.push("t.is_split = 0 AND t.id IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(ids));
	}
	const shown = (f.raw ? RAW_SHOW_SQL : SHOW_SQL)[f.show];
	if (shown) where.push(shown);
	// The search's pattern when it looks in categories too (#211), so the count can say whether one matched.
	let categoryPattern: string | null = null;
	// The search's amount, when it looks at amounts, so the count can say whether every row matched by one.
	let amountSearch: AmountSearch | null = null;
	if (f.q) {
		if (f.raw) {
			where.push("t.raw_name LIKE ? ESCAPE '\\'");
			args.push(likePattern(f.q));
		} else {
			// The raw text also matches with each * read as a space, as its tidied name shows it (#93):
			// "google youtube" finds "GOOGLE *YOUTUBE". A name the row shows as a suggestion matches too,
			// while it is offered (the bank's own always, Tally's guesses while the names switch is on), so what a
			// row says can be searched for. A row with its own name shows that instead (shownName), so neither its
			// suggestion nor its merchant's chosen name matches: the chosen name reads own name first, as the list does (#414).
			// A search also finds a category by its name (#211), and an amount (decision 79). A plain whole
			// number matches its amount and the words, so "42" finds "STORE 42" as well as $42.00 to $42.99;
			// with a "$" or a decimal point the search is the amount alone.
			const amount = searchAmount(f.q);
			amountSearch = amount;
			const pattern = likePattern(f.q);
			const alternatives: string[] = [];
			if (amount === null || amount.plain) {
				categoryPattern = pattern;
				alternatives.push(
					`(COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")}, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(t.raw_name, '*', ' '), '  ', ' '), '  ', ' ') LIKE ? ESCAPE '\\' OR COALESCE(${visibleNoteSql(detailsOn)}, '') LIKE ? ESCAPE '\\' OR (${ownNameSql("t")} IS NULL AND ${suggestedNameMatch(namesOn)}) OR c.name LIKE ? ESCAPE '\\')`,
				);
				args.push(pattern, pattern, pattern, pattern, pattern, pattern);
			}
			if (amount) {
				alternatives.push("ABS(t.amount_cents) BETWEEN ? AND ?");
				args.push(amount.low, amount.high);
			}
			where.push(`(${alternatives.join(" OR ")})`);
		}
	}

	return {
		joins: `${COUNTED_JOINS}
			LEFT JOIN categories c ON c.id = ${COUNTED_CATEGORY}
			${MAYBE_CATEGORY_JOINS}
			LEFT JOIN transactions p ON p.id = t.parent_id`,
		where,
		args,
		categoryPattern,
		amountSearch,
	};
}

/** One page of transactions matching the filters, newest first. A page past the end shows the last page. */
export async function listTransactions(
	db: D1Database,
	f: Filters,
	/** Only these transactions, unpaged and whatever the filters (see listRowsByIds). */
	ids?: number[],
): Promise<{
	rows: ListRow[];
	total: number;
	page: number;
	pages: number;
	/** What the rows matched the search by, for the count's note (#211). */
	matched: SearchMatch;
}> {
	const {
		names: namesOn,
		details: detailsOn,
		income: incomeOn,
	} = await readAiSwitches(db);
	const { joins, where, args, categoryPattern, amountSearch } = filterMatch(
		f,
		namesOn,
		detailsOn,
		ids,
	);
	// The row shows the category it counts in, so a linked refund shows its purchase's.
	const from = `FROM transactions t
			${joins}
			${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`;

	// What the rows matched, in the same statement as the count (#211): whether any counted row matched by its
	// category's name (an archived category counts too, as the search does), and, for a plain number, whether
	// every counted row matched by its amount. A row that matched by its words alone breaks the second; with no
	// row counted it holds, as it does for an amount-only search, so the count names the amount then.
	const countColumns = ["COUNT(*) AS n"];
	const countArgs: (string | number)[] = [];
	if (amountSearch?.plain) {
		countColumns.push(
			"COALESCE(MIN(CASE WHEN ABS(t.amount_cents) BETWEEN ? AND ? THEN 1 ELSE 0 END), 1) AS allAmount",
		);
		countArgs.push(amountSearch.low, amountSearch.high);
	}
	if (categoryPattern !== null) {
		countColumns.push(
			"MAX(CASE WHEN c.name LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS categoryHit",
		);
		countArgs.push(categoryPattern);
	}
	const counted = await db
		.prepare(`SELECT ${countColumns.join(", ")} ${from}`)
		.bind(...countArgs, ...args)
		.first<{
			n: number;
			allAmount?: number | null;
			categoryHit?: number | null;
		}>();
	const total = counted?.n ?? 0;
	const matched: SearchMatch = {
		category: counted?.categoryHit === 1,
		allByAmount:
			amountSearch !== null &&
			(!amountSearch.plain || counted?.allAmount === 1),
	};
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(f.page, pages);

	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				${merchantColumnSql("t", "display_name")} AS merchantName, ${ownNameSql("t")} AS ownName, ${NAME_SUGGESTION_COLUMNS}, ${f.raw ? "NULL" : visibleNoteSql(detailsOn)} AS note, ${f.raw ? "0" : `CASE WHEN t.note_guessed = 1 AND ${detailsOn ? "1" : "0"} = 1 THEN 1 ELSE 0 END`} AS noteGuessed, t.parent_id AS parentId,
				t.is_split AS isSplit, ${merchantColumnSql("p", "display_name")} AS parentMerchantName, ${ownNameSql("p")} AS parentOwnName, ${merchantColumnSql("p", "suggested_name")} AS parentSuggestedNames, ${merchantColumnSql("p", "suggestion_status")} AS parentSuggestionStatus, ${merchantKeySql("p")} AS parentMerchantKey, p.raw_name AS parentRawName,
				t.split_removed_from_cents AS splitRemovedFromCents, ${STILL_UNPAID_BILLS_SQL("t.split_removed_bills")} AS splitRemovedBills,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, t.refund_unlinked_purchase_date AS refundUnlinkedPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				${REFUNDED_COLUMN},
				t.excluded, ${paysBillSql("t")} AS paysBill,
				${BILL_NAME_COLUMN},
				(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=p.id AND bp.status='linked' LIMIT 1) AS parentBillName,
				${PENDING_SQL} AS pending, t.flag_income AS income, t.credit_reviewed AS creditReviewed, ${maybeIncomeConfidenceSql("t")} AS incomeConfidence,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
				${MAYBE_CATEGORY_COLUMNS},
				${COUNTS_IN_MONTH_COLUMN}
			${from}
			ORDER BY t.date DESC, t.id DESC
			${ids ? "" : `LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`}`,
		)
		.bind(...args)
		.all<
			Omit<
				ListRow,
				| "excluded"
				| "paysBill"
				| "income"
				| "creditReviewed"
				| "noteGuessed"
				| "displayName"
				| "isSplit"
				| "followsPurchase"
				| "pending"
			> &
				NameSuggestionColumns & {
					merchantName: string | null;
					ownName: string | null;
					parentMerchantName: string | null;
					parentOwnName: string | null;
					parentSuggestedNames: string | null;
					parentSuggestionStatus: string | null;
					parentMerchantKey: string | null;
					parentRawName: string | null;
					excluded: number;
					paysBill: number;
					income: number;
					creditReviewed: number;
					incomeConfidence: number | null;
					isSplit: number;
					followsPurchase: number;
					pending: number;
					noteGuessed: number;
				}
		>();

	// A person's chosen name wins; until then the first pending suggestion, shown dashed; otherwise the
	// bank's raw text, tidied for display (spec §7). A split part's "Split from" caption names its
	// parent the same way, so it reads as the parent's own row does.
	const rows = results.map(
		({
			merchantName,
			ownName,
			parentMerchantName,
			parentOwnName,
			parentSuggestedNames,
			parentSuggestionStatus,
			parentMerchantKey,
			parentRawName,
			suggestedNames,
			suggestionStatus,
			merchantKey,
			...r
		}) => {
			const shown = shownName({
				chosen: merchantName,
				ownName,
				stored: suggestedNames,
				status: suggestionStatus,
				key: merchantKey,
				rawName: r.rawName,
				namesOn,
			});
			return {
				...r,
				parentName: parentRawName
					? shownName({
							chosen: parentMerchantName,
							ownName: parentOwnName,
							stored: parentSuggestedNames,
							status: parentSuggestionStatus,
							key: parentMerchantKey ?? parentRawName,
							rawName: parentRawName,
							namesOn,
						}).name
					: null,
				excluded: r.excluded === 1,
				paysBill: r.paysBill === 1,
				income: r.income === 1,
				incomeConfidence: incomeOn ? r.incomeConfidence : null,
				creditReviewed: r.creditReviewed === 1,
				isSplit: r.isSplit === 1,
				followsPurchase: r.followsPurchase === 1,
				pending: r.pending === 1,
				noteGuessed: r.noteGuessed === 1,
				displayName: shown.name,
				nameSuggested: shown.suggested,
				nameFromBank: shown.fromBank,
			};
		},
	);
	return { rows, total, page, pages, matched };
}

/**
 * The given transactions as list rows, whatever the filters: the ticks that aren't on the list on screen
 * (#350). A split parent and an unknown id drop out, so only what the bar can act on is counted.
 */
export async function listRowsByIds(
	db: D1Database,
	ids: number[],
): Promise<ListRow[]> {
	if (ids.length === 0) return [];
	const { rows } = await listTransactions(
		db,
		{
			q: "",
			month: "all",
			category: null,
			account: null,
			show: "all",
			uncategorized: false,
			page: 1,
			raw: false,
		},
		ids,
	);
	return rows;
}

/**
 * The rows a bulk action can change (no split parent) that the filters match, whatever the page (#321): what
 * Select all means. Counted on every request, so a changed filter or a new transaction changes the set.
 */
export async function selectableMatchIds(
	db: D1Database,
	f: Filters,
): Promise<number[]> {
	const { names: namesOn, details: detailsOn } = await readAiSwitches(db);
	const match = filterMatch(f, namesOn, detailsOn);
	const { results } = await db
		.prepare(
			`SELECT t.id FROM transactions t ${match.joins} WHERE ${["t.is_split = 0", ...match.where].join(" AND ")}`,
		)
		.bind(...match.args)
		.all<{ id: number }>();
	return results.map((row) => row.id);
}

/**
 * The given ids that are still rows a bulk action can change (not deleted, not a split parent), in the order
 * given: the rule listTransactions' `ids` uses, so a stale tick drops out before anything reads it (#350).
 * One bind for the whole list, so there is no cap on how many.
 */
export async function selectableTickIds(
	db: D1Database,
	ids: number[],
): Promise<number[]> {
	if (ids.length === 0) return [];
	const { results } = await db
		.prepare(
			"SELECT id FROM transactions WHERE is_split = 0 AND id IN (SELECT value FROM json_each(?))",
		)
		.bind(JSON.stringify(ids))
		.all<{ id: number }>();
	const selectable = new Set(results.map((row) => row.id));
	return ids.filter((id) => selectable.has(id));
}

/** How many transactions need a category in a month ('YYYY-MM' or 'all'): the chip and Home's band. */
export async function needsCategoryCount(
	db: D1Database,
	month: string,
	raw = false,
): Promise<number> {
	if (raw) {
		const inMonth = month === "all" ? "" : "substr(t.date,1,7) = ? AND ";
		const statement = db.prepare(
			`SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS} WHERE ${inMonth}t.parent_id IS NULL`,
		);
		const row = await (month === "all"
			? statement
			: statement.bind(month)
		).first<{ n: number }>();
		return row?.n ?? 0;
	}
	const inMonth = month === "all" ? "" : `${COUNTED_MONTH} = ? AND `;
	const statement = db.prepare(
		`SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS} WHERE ${inMonth}${NEEDS_CATEGORY}`,
	);
	const row = await (month === "all"
		? statement
		: statement.bind(month)
	).first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

/** How many uncategorized transactions count before this month, using bounded transaction-date ranges. */
export async function olderNeedsCategoryCount(
	db: D1Database,
	monthStart: string,
): Promise<number> {
	const [year = 0, month = 1] = monthStart.slice(0, 7).split("-").map(Number);
	const nextMonthStart = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`;
	const row = await db
		.prepare(OLDER_NEEDS_CATEGORY_SQL)
		.bind(monthStart, nextMonthStart, monthStart.slice(0, 7))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Months that have transactions, newest first, for the month filter. */
export async function monthsWithTransactions(
	db: D1Database,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT ${COUNTED_MONTH} AS month FROM transactions t
			 ${COUNTED_JOINS} ORDER BY month DESC`,
		)
		.all<{ month: string }>();
	return results.map((r) => r.month);
}

/** What the household's empty list means before anything has arrived (spec §8.5). */
export type FirstVisit = "no-bank" | "importing";

/**
 * Null once the household has a transaction in any month. With none at all, "importing" when a
 * connected bank (not disconnected) is linked and "no-bank" when not. Rows aren't scoped to a user,
 * so this is one cheap statement over everything; run it only when the list on screen is empty.
 */
export async function firstVisitState(
	db: D1Database,
): Promise<FirstVisit | null> {
	const row = await db
		.prepare(
			`SELECT CASE
				WHEN EXISTS (SELECT 1 FROM transactions) THEN NULL
				WHEN EXISTS (SELECT 1 FROM plaid_items WHERE disconnected_at IS NULL) THEN 'importing'
				ELSE 'no-bank'
			END AS state`,
		)
		.first<{ state: FirstVisit | null }>();
	return row?.state ?? null;
}

export type TransactionDetail = ListRow & {
	detailsVisible: boolean;
	noteGuessed: boolean;
	kind: "subscription" | "one_off" | "bill" | "transfer" | null;
	kindGuessed: boolean;
	forPersonId: number | null;
	forPersonName: string | null;
	forPersonGuessed: boolean;
	/** A person explicitly reviewed this credit as non-income; Jev's settled state is separate. */
	creditReviewedByUser: boolean;
	/** Who last settled the income answer ("user" or "jev"), or null when nothing has. */
	incomeSource: string | null;
	accountName: string;
	bankName: string | null;
	accountMask: string | null;
	accountType: string;
	/** The merchant's chosen display name, or null when it falls back to the raw name. */
	merchantName: string | null;
	/** The name given to this transaction alone (decision 101), or null; a split part shows its purchase's. */
	ownName: string | null;
	/** What the store's rows read without a name of their own. */
	storeName: string;
	categorySource: "user" | "merchant_rule" | "bill" | "jev" | null;
	merchantRuleCategoryId: number | null;
	/** The rule's category name, archived or not (the edit panel's chips list only active ones), or null. */
	merchantRuleCategoryName: string | null;
	/** Jev's confidence when Jev picked (or looked at) the category; null otherwise. */
	categoryConfidence: number | null;
	suggestedCategoryId: number | null;
	suggestedCategoryName: string | null;
	/** What the Name row offers (P29 A, decision 101): the suggestions, the store's own name, and the Rename list's counts. */
	nameChoices: NameChoices;
};

export type NameChoices = {
	/** The suggested names still waiting (up to three), in order. */
	names: string[];
	/** Where the names came from: the bank sent them, or Tally guessed (P87 B). */
	source: NameSource;
	/** The store's own name: the bank's text as the list shows it without a choice. */
	tidied: string;
	/** The bank's text as it was sent, which the store's own name line quotes. */
	rawName: string;
	/** The merchant's name as the list shows it: its chosen name, else the store's own name. */
	merchantLabel: string;
	/** Transactions from the merchant, split purchases counted once, this one included unless it is a split part (its purchase is counted). */
	total: number;
	/**
	 * The other transactions from the merchant that have a name of their own (decision 79), newest first;
	 * a split part with its own name is among them, marked `part`.
	 */
	owned: OwnedRow[];
	/** This transaction's own name, or null. */
	thisOwn: string | null;
	/** Tally picked this transaction's category, or it has none and no one set one: a one-off name makes Tally guess again (oneOffGuessesAgain). */
	tallyCategory: boolean;
};

export type RefundPurchase = {
	id: number;
	date: string;
	amountCents: number;
	categoryId: number | null;
	categoryName: string | null;
	/** An excluded purchase isn't offered, and a refund stops following it (it counts on its own). */
	excluded: number;
};

/**
 * The purchases a refund can link to: same merchant (by merchant key, so a "TARGET 1234" purchase is
 * offered for a "TARGET 5678" refund; or by raw name when either has no merchant name, as before Plaid's
 * merchant name was stored, never across two different merchant names), on or before it, within 90 days; a split purchase gives way to its parts. A purchase
 * with nothing left to refund (other refunds already took every cent) isn't offered, since no refund
 * fits it (spec §8.5). The purchase it's linked to now is always included, so it can be kept.
 */
export async function refundPurchases(
	db: D1Database,
	refund: Pick<
		TransactionDetail,
		"id" | "date" | "amountCents" | "income" | "isSplit" | "refundOfId"
	>,
): Promise<RefundPurchase[]> {
	const isRefund = refund.amountCents < 0 && !refund.income && !refund.isSplit;
	if (!isRefund && refund.refundOfId == null) return [];
	const { results } = await db
		.prepare(`SELECT t.id,t.date,t.amount_cents AS amountCents,t.category_id AS categoryId,c.name AS categoryName,t.excluded
		FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
		WHERE t.id = ?1 OR (?2 AND t.amount_cents>0 AND t.is_split=0 AND t.excluded=0
			AND EXISTS (SELECT 1 FROM transactions r WHERE r.id=?4 AND ${sameMerchantSql("t", "r")})
			AND t.date<=?3 AND t.date>=date(?3,'-90 days') AND t.id!=?4
			AND t.amount_cents > ${refundedByOthersSql("t.id", "?4")})
		ORDER BY t.date DESC,t.id DESC`)
		.bind(refund.refundOfId ?? null, isRefund ? 1 : 0, refund.date, refund.id)
		.all<RefundPurchase>();
	return results;
}

/** One transaction with what the edit panel shows: account, merchant name, and category source. */
export async function getTransaction(
	db: D1Database,
	id: number,
): Promise<TransactionDetail | null> {
	const r = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				${merchantColumnSql("t", "display_name")} AS merchantName, ${ownNameSql("t")} AS ownName, t.own_name AS thisOwnName, ${merchantColumnSql("t", "default_category_id")} AS merchantRuleCategoryId, (SELECT rc.name FROM categories rc WHERE rc.id = ${merchantColumnSql("t", "default_category_id")}) AS merchantRuleCategoryName, ${NAME_SUGGESTION_COLUMNS}, t.note, t.parent_id AS parentId,
				(SELECT COUNT(*) FROM transactions m WHERE m.parent_id IS NULL AND ${merchantKeySql("m")} = ${merchantKeySql("t")}) AS merchantTotal,
				(SELECT json_group_array(json_object('name', o.own_name, 'date', o.date, 'part', o.parent_id IS NOT NULL)) FROM transactions o WHERE o.id != t.id AND o.own_name IS NOT NULL AND ${merchantKeySql("o")} = ${merchantKeySql("t")}) AS ownedJson,
				t.note_guessed AS noteGuessed, t.kind, t.kind_guessed AS kindGuessed,
				t.for_person_id AS forPersonId, (SELECT name FROM household_people WHERE id = t.for_person_id) AS forPersonName, t.for_person_guessed AS forPersonGuessed,
				t.is_split AS isSplit, NULL AS parentName,
				t.split_removed_from_cents AS splitRemovedFromCents, ${STILL_UNPAID_BILLS_SQL("t.split_removed_bills")} AS splitRemovedBills,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, t.refund_unlinked_purchase_date AS refundUnlinkedPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				${REFUNDED_COLUMN},
				t.excluded, ${paysBillSql("t")} AS paysBill,
				${BILL_NAME_COLUMN},
				${PENDING_SQL} AS pending, t.flag_income AS income, ${maybeIncomeConfidenceSql("t")} AS incomeConfidence, t.category_source AS categorySource, t.category_confidence AS categoryConfidence,
				t.credit_reviewed AS creditReviewed, (t.credit_reviewed_by = 'user') AS creditReviewedByUser, t.income_source AS incomeSource,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
				t.jev_category_id AS suggestedCategoryId, maybeCat.name AS suggestedCategoryName,
				${MAYBE_CATEGORY_COLUMNS},
				CASE WHEN ${COUNTED_MONTH} != substr(t.date,1,7) THEN ${COUNTED_MONTH} END AS countsInMonth,
				a.name AS accountName, a.mask AS accountMask, a.type AS accountType, pi.institution_name AS bankName
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN plaid_items pi ON pi.id = a.plaid_item_id
			-- The panel edits the transaction's own category; a linked refund's purchase's is shown separately.
			LEFT JOIN categories c ON c.id = t.category_id
			${MAYBE_CATEGORY_JOINS}
			LEFT JOIN transactions p ON p.id = t.parent_id
			${COUNTED_JOINS}
			WHERE t.id = ?`,
		)
		.bind(id)
		.first<
			Omit<
				TransactionDetail,
				| "excluded"
				| "paysBill"
				| "income"
				| "creditReviewed"
				| "noteGuessed"
				| "kindGuessed"
				| "forPersonGuessed"
				| "creditReviewedByUser"
				| "displayName"
				| "storeName"
				| "nameChoices"
				| "isSplit"
				| "followsPurchase"
				| "pending"
			> &
				NameSuggestionColumns & {
					merchantTotal: number;
					/** A JSON array of the other own-named transactions from this merchant (parts included): name, date and whether a part. */
					ownedJson: string;
					/** This row's own name only (a split part's inherited name is not its own), read for the Rename list. */
					thisOwnName: string | null;
					excluded: number;
					paysBill: number;
					income: number;
					creditReviewed: number;
					creditReviewedByUser: number;
					incomeConfidence: number | null;
					isSplit: number;
					followsPurchase: number;
					pending: number;
					noteGuessed: number;
					kindGuessed: number;
					forPersonGuessed: number;
				}
		>();
	if (!r) return null;
	// A person's chosen name wins; until then the first pending suggestion, shown dashed; otherwise the
	// bank's raw text is tidied for display (spec §7). The panel offers every pending suggestion.
	const {
		suggestedNames,
		suggestionStatus,
		merchantKey,
		merchantTotal,
		ownedJson,
		thisOwnName,
		...row
	} = r;
	const {
		names: namesOn,
		details: detailsOn,
		income: incomeOn,
	} = await readAiSwitches(db);
	const merchant = {
		stored: suggestedNames,
		status: suggestionStatus,
		key: merchantKey,
		namesOn,
	};
	const shown = shownName({
		...merchant,
		chosen: r.merchantName,
		ownName: r.ownName,
		rawName: r.rawName,
	});
	const storeName = shownName({
		...merchant,
		chosen: r.merchantName,
		rawName: r.rawName,
	}).name;
	const offered = r.merchantName ? [] : offeredNames(merchant, r.rawName);
	const tidied = tidyName(r.rawName);
	const owned = (
		JSON.parse(ownedJson) as { name: string; date: string; part: number }[]
	)
		.map(({ name, date, part }) => ({ name, date, part: part === 1 }))
		.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
	return {
		...row,
		detailsVisible: detailsOn,
		excluded: r.excluded === 1,
		paysBill: r.paysBill === 1,
		income: r.income === 1,
		incomeConfidence: incomeOn ? r.incomeConfidence : null,
		creditReviewed: r.creditReviewed === 1,
		note: r.noteGuessed === 1 && !detailsOn ? null : r.note,
		noteGuessed: r.noteGuessed === 1 && detailsOn,
		kind: r.kindGuessed === 1 && !detailsOn ? null : r.kind,
		kindGuessed: r.kindGuessed === 1 && detailsOn,
		forPersonId: r.forPersonGuessed === 1 && !detailsOn ? null : r.forPersonId,
		forPersonName:
			r.forPersonGuessed === 1 && !detailsOn ? null : r.forPersonName,
		forPersonGuessed: r.forPersonGuessed === 1 && detailsOn,
		creditReviewedByUser: r.creditReviewedByUser === 1,
		isSplit: r.isSplit === 1,
		followsPurchase: r.followsPurchase === 1,
		pending: r.pending === 1,
		displayName: shown.name,
		storeName,
		nameSuggested: shown.suggested,
		nameFromBank: shown.fromBank,
		nameChoices: {
			names: offered,
			source: nameSource(offered, merchantKey),
			tidied,
			rawName: r.rawName,
			merchantLabel: r.merchantName ?? tidied,
			total: merchantTotal,
			owned,
			thisOwn: thisOwnName,
			tallyCategory:
				r.categorySource === "jev" ||
				(r.categoryId === null && r.categorySource === null),
		},
	};
}

/** Sets `excluded`, recording a person as its source only when the value changes. */
const EXCLUDE =
	"excluded_source = CASE WHEN excluded = ? THEN excluded_source ELSE 'user' END, excluded = ?";

/**
 * Gives a merchant's rule category to every transaction a person hasn't chosen (§7), except a split
 * purchase and a purchase a bank change sent back to its earlier category (§6.1, decision 99). Binds
 * the category, the actor, then what `keyCondition` binds (`= ?` for one key); callers add their own
 * last condition.
 */
export function applyMerchantRuleSql(keyCondition: string): string {
	return `UPDATE transactions SET category_id = ?, category_source = 'merchant_rule', category_confidence = NULL,
	updated_by = ?, updated_at = datetime('now')
WHERE ${merchantKeySql("transactions")} ${keyCondition} AND COALESCE(category_source, '') != 'user'
	AND is_split = 0 AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL)`;
}

export const APPLY_MERCHANT_RULE_SQL = applyMerchantRuleSql("= ?");

/**
 * What saving the edit panel did. A refund link that is more than what's left of its purchase is
 * refused (spec §8.5) with nothing saved, and `refundLeftCents` is what the purchase has left. A split
 * refund with a part that doesn't fit its own purchase (a review as not income makes it count) is refused
 * the same way: `refundPurchase` is the purchase of the first such part, and `refundLeftCents` is what that
 * purchase has left for the whole split. A cash amount is refused when it breaks its parts (`amountCents`
 * is the parts' total) or its linked refunds (`refundCents` is their total, the smallest amount that would
 * fit).
 */
export type SaveEditResult =
	| { saved: true }
	| {
			saved: false;
			refundLeftCents: number;
			refundPurchase?: {
				id: number;
				date: string;
				amountCents: number;
				categoryName: string | null;
			};
	  }
	| { saved: false; personMissing: true }
	| { saved: false; cashError: "split"; amountCents: number }
	| { saved: false; cashError: "refund"; refundCents: number };

/**
 * Saves the edit panel in one atomic batch: the category (marked as a person's choice when it
 * changes), the note, whether it's excluded, the merchant's display name, and, if asked, the merchant rule, which also
 * recategorizes the merchant's other transactions except ones a person chose (spec §7).
 *
 * Linking a refund to a purchase (spec §6, §8.5) is the one write that can be refused, and so is
 * turning off "Count as income", or reviewing the credit as not income, on a credit that stays linked,
 * which makes it count against its purchase. The check is an UPDATE that changes nothing unless what moves
 * with the refund fits what's left of the purchase (src/db/refunded.ts), so two saves at once can't both
 * fit. A split credit reviewed as not income is checked part by part, each linked part against its own
 * purchase (splitPartMisfitSql), since each part counts there. Every other write in the batch applies only
 * once that has, so a refusal saves nothing, and an error anywhere rolls the link back too. A person
 * linking a refund includes it in the budget, even when it was excluded
 * (`excluded = 0`, `excluded_source = 'user'`); a link that isn't changing is left alone. A For person
 * removed since the panel loaded the household list is refused the same way (`personMissing`).
 */
export async function saveEdit(
	db: D1Database,
	id: number,
	edit: Edit,
	actor: string,
): Promise<SaveEditResult> {
	const current = await db
		.prepare(
			`SELECT ${merchantKeySql("transactions")} AS merchantKey, raw_name AS rawName, amount_cents AS amountCents, category_id AS categoryId, category_source AS categorySource, flag_income AS income, income_source AS incomeSource, credit_reviewed AS creditReviewed, credit_reviewed_by AS creditReviewedBy, excluded, ${paysBillSql("transactions")} AS paysBill, (SELECT rp.excluded FROM transactions rp WHERE rp.id = transactions.refund_of_id) AS purchaseExcluded, refund_of_id AS refundOfId, is_split AS isSplit, note, note_guessed AS noteGuessed, kind, kind_guessed AS kindGuessed, for_person_id AS forPersonId, for_person_guessed AS forPersonGuessed FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<{
			merchantKey: string;
			rawName: string;
			amountCents: number;
			categoryId: number | null;
			categorySource: string | null;
			income: number;
			incomeSource: string | null;
			creditReviewed: number | null;
			creditReviewedBy: string | null;
			excluded: number;
			paysBill: number;
			/** The linked purchase's exclusion (1 or 0), or null when nothing is linked. */
			purchaseExcluded: number | null;
			refundOfId: number | null;
			isSplit: number;
			note: string | null;
			noteGuessed: number;
			kind: string | null;
			kindGuessed: number;
			forPersonId: number | null;
			forPersonGuessed: number;
		}>();
	if (!current) throw new Error(`No transaction ${id}`);

	// The purchase this refund is being linked to now: undefined when its link stays as it is, null
	// when it's being unlinked.
	const noteChanged =
		edit.noteProvided !== false &&
		edit.note !== current.note &&
		(current.noteGuessed === 0 ||
			edit.detailsVisible !== false ||
			edit.noteProvided === true);
	const newLink =
		edit.refundOfId !== undefined && edit.refundOfId !== current.refundOfId
			? edit.refundOfId
			: undefined;
	const linking = typeof newLink === "number";
	const incomeChanged =
		edit.incomeWas === undefined
			? (edit.income ? 1 : 0) !== current.income
			: edit.income !== edit.incomeWas;
	const creditReviewChoice = edit.creditReviewed ? 1 : 0;
	const creditReviewChanged =
		edit.creditReviewedProvided === false
			? false
			: edit.creditReviewedWas === undefined
				? edit.creditReviewed !== (current.creditReviewedBy === "user")
				: edit.creditReviewed !== edit.creditReviewedWas;
	const creditReviewByUser =
		creditReviewChanged && !edit.income && creditReviewChoice === 1;
	// A linked credit counts with its purchase once it is reviewed and not income (followsPurchase), so a save
	// that makes it start counting, with the link staying, is checked like a link. followsPurchaseAfterSave says
	// whether it counts once saved, whether by a review as not income or by clearing its income. A save that
	// clears a linked credit's income is checked as it always was, even when the review leaves it uncounted. A
	// panel that still shows income off, saving only a note, clears nothing. (A split parent never counts, only
	// its parts do, and the cap ignores whether a refund is excluded or reviewed.)
	const storedCredit = {
		amountCents: current.amountCents,
		refundOfId: current.refundOfId,
		income: current.income === 1,
		incomeSource: current.incomeSource,
		creditReviewed: current.creditReviewed === 1,
		creditReviewedByUser: current.creditReviewedBy === "user",
	};
	const startsCounting =
		!followsPurchase(storedCredit) &&
		followsPurchaseAfterSave(storedCredit, edit);
	const recounting =
		newLink === undefined &&
		current.refundOfId !== null &&
		current.isSplit === 0 &&
		(startsCounting ||
			(current.income === 1 &&
				(incomeChanged || creditReviewByUser) &&
				!edit.income))
			? current.refundOfId
			: null;

	// Every other write waits on that check and on the parts check below (baseGate), so a refusal writes
	// nothing at all, and an error anywhere in the batch rolls everything back, link included. For a link, once
	// it has taken the refund's `refund_of_id` is the new purchase, and when it was refused it is not. For a
	// credit that counts again, the same amount check is made by each write. The check's two parameters are
	// numbered from `n`, after the statement's own.
	const linkGate: { sql: (n: number) => string; args: unknown[] } = linking
		? {
				sql: (n) =>
					` AND EXISTS (SELECT 1 FROM transactions WHERE id = ?${n} AND refund_of_id = ?${n + 1})`,
				args: [id, newLink],
			}
		: recounting !== null
			? {
					sql: (n) => ` AND ${refundFitsSql(`?${n}`, `?${n + 1}`)}`,
					args: [id, recounting],
				}
			: { sql: () => "", args: [] };
	// The cash check on its own: the entry is still a cash entry at the amount it's given, its parts add up
	// to it, and its refunds fit within it. The two linking writes wait on this check and the parts check
	// (baseGate), but not on the link check, because the link check reads the link they set. The cash check's
	// answer is the same before or after they run, since it counts refunds of this entry, not of the purchase
	// it links to.
	const cashGate: { sql: (n: number) => string; args: unknown[] } =
		edit.cashAmountCents === undefined
			? { sql: () => "", args: [] }
			: {
					sql: (n) =>
						` AND EXISTS (SELECT 1 FROM transactions cash WHERE cash.id = ?${n} AND cash.parent_id IS NULL AND cash.account_id IN (SELECT id FROM accounts WHERE type='cash') AND (cash.is_split = 0 OR (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions part WHERE part.parent_id = cash.id) = ?${n + 1}) AND COALESCE((SELECT SUM(ABS(refund.amount_cents)) FROM transactions refund WHERE refund.refund_of_id = cash.id AND refund.is_split = 0 AND refund.amount_cents < 0 AND refund.flag_income = 0), 0) <= ?${n + 1})`,
					args: [id, edit.cashAmountCents],
				};
	// A split credit reviewed as not income makes each of its linked parts count against its own purchase, so
	// each one is checked (splitPartMisfitSql). The parts on the parent's old link are left out, since they move
	// with the parent, and the link statement checks what moves against what is left of the new purchase, counting
	// the parts already there. The parts already on the new purchase are checked here as they stand. So the gate
	// gives the same answer at every statement of the batch: the move runs only when it fits what is left,
	// counting those parts, and if it is refused nothing changes.
	const splitReview = creditReviewByUser && current.isSplit === 1;
	const partsGate: { sql: (n: number) => string; args: unknown[] } = splitReview
		? {
				sql: (n) =>
					` AND NOT EXISTS (SELECT 1 FROM transactions kid WHERE ${splitPartMisfitSql(`?${n}`, `?${n + 1}`)})`,
				args: [id, newLink === undefined ? null : current.refundOfId],
			}
		: { sql: () => "", args: [] };
	// Every write waits on the parts check and the cash check, and on the link's check too (gate).
	const baseGate = {
		sql: (n: number) =>
			`${partsGate.sql(n)}${cashGate.sql(n + partsGate.args.length)}`,
		args: [...partsGate.args, ...cashGate.args],
	};
	const gate = {
		sql: (n: number) =>
			`${linkGate.sql(n)}${baseGate.sql(n + linkGate.args.length)}`,
		args: [...linkGate.args, ...baseGate.args],
	};
	/** A statement with the gate on its WHERE (before `tail`), binding `args` and then the gate's. */
	const gated = (sql: string, args: unknown[], tail = "") =>
		db
			.prepare(`${sql}${gate.sql(args.length + 1)}${tail}`)
			.bind(...args, ...gate.args);
	/** A statement with the parts and cash checks on its WHERE, binding `args` and then their own. */
	const cashGated = (sql: string, args: unknown[]) =>
		db
			.prepare(`${sql}${baseGate.sql(args.length + 1)}`)
			.bind(...args, ...baseGate.args);

	const changed =
		edit.categoryId !== null && edit.categoryId !== current.categoryId;
	// Changing the exclusion makes it a person's choice, which Jev never overrides. A refund being
	// linked counts, whatever the panel's Exclude chip held (it was drawn from the old state).
	const excluded = edit.excluded && !linking ? 1 : 0;
	const excludeArgs = [excluded, excluded];
	// The review and income parameters the panel's own UPDATE shares between its two forms.
	const reviewArgs = [
		creditReviewByUser || incomeChanged ? 1 : 0,
		incomeChanged && edit.income ? 1 : 0,
		incomeChanged || creditReviewByUser ? 1 : 0,
		creditReviewByUser ? 1 : 0,
		creditReviewChanged ? 1 : 0,
		creditReviewChoice,
		creditReviewChanged ? 1 : 0,
		creditReviewChoice,
		incomeChanged ? 1 : 0,
		creditReviewChoice,
		creditReviewByUser ? 1 : 0,
		creditReviewChanged ? 1 : 0,
		creditReviewChoice,
		actor,
		id,
	];

	const statements: D1PreparedStatement[] = [];
	if (linking) {
		// First, so what follows can depend on it. The parts of a split refund move with it, only while
		// they still follow its old link; one a person linked to another purchase keeps its own choice.
		// That runs before the refund's own update, which changes the link they are compared with. Both
		// check that what moves fits what is left of the purchase, and both wait on the cash check like
		// the panel's other writes, so a refused save links nothing.
		statements.push(
			cashGated(
				`UPDATE transactions SET refund_of_id = ?1, refund_unlinked_purchase_date = NULL
					WHERE parent_id = ?2 AND refund_of_id IS (SELECT refund_of_id FROM transactions WHERE id = ?2)
						AND ${refundFitsSql("?2", "?1")}`,
				[newLink, id],
			),
			// A person linking it makes it a reviewed refund that counts, as their choice. This is the
			// statement whose result says whether the link was refused.
			cashGated(
				`UPDATE transactions SET refund_of_id = ?1, refund_unlinked_purchase_date = NULL,
						credit_reviewed = CASE WHEN amount_cents < 0 THEN 1 ELSE credit_reviewed END,
						credit_reviewed_by = CASE WHEN amount_cents < 0 THEN 'user' ELSE credit_reviewed_by END,
						excluded_source = CASE WHEN excluded = 1 THEN 'user' ELSE excluded_source END,
						excluded = 0
					WHERE id = ?2 AND ${refundFitsSql("?2", "?1")}`,
				[newLink, id],
			),
		);
	}
	// The panel's own update comes next, so for a credit that counts again its result says whether it
	// was refused (it is the first statement then).
	statements.push(
		changed
			? gated(
					`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
						note = CASE WHEN ? = 1 THEN ? ELSE note END, ${EXCLUDE}, flag_income = CASE WHEN ? = 1 THEN ? ELSE flag_income END,
						income_source = CASE WHEN ? = 1 OR ? = 1 THEN 'user' ELSE income_source END,
						credit_reviewed = CASE WHEN amount_cents < 0 AND ? = 1 AND ? = 1 THEN 1 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN 0 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND income_source = 'jev' THEN 0 ELSE credit_reviewed END,
						credit_reviewed_by = CASE WHEN ? = 1 THEN 'user' WHEN ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN NULL ELSE credit_reviewed_by END,
						updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					[
						edit.categoryId,
						noteChanged ? 1 : 0,
						edit.note,
						...excludeArgs,
						...reviewArgs,
					],
				)
			: gated(
					`UPDATE transactions SET note = CASE WHEN ? = 1 THEN ? ELSE note END, ${edit.categoryId !== null ? "split_removed_from_cents = NULL, split_removed_bills = NULL," : ""} ${EXCLUDE}, flag_income = CASE WHEN ? = 1 THEN ? ELSE flag_income END,
				income_source = CASE WHEN ? = 1 OR ? = 1 THEN 'user' ELSE income_source END,
					credit_reviewed = CASE WHEN amount_cents < 0 AND ? = 1 AND ? = 1 THEN 1 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN 0 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND income_source = 'jev' THEN 0 ELSE credit_reviewed END,
					credit_reviewed_by = CASE WHEN ? = 1 THEN 'user' WHEN ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN NULL ELSE credit_reviewed_by END,
					updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					[noteChanged ? 1 : 0, edit.note, ...excludeArgs, ...reviewArgs],
				),
	);
	// A guessed name a person keeps is logged before the merchant's suggestion settles (spec §8.6).
	if (
		edit.nameChanged !== false &&
		edit.displayName &&
		nameSource([edit.displayName], current.merchantKey) === "tally"
	)
		statements.push(
			gated(KEPT_NAME_LOG_SQL, [
				await householdToday(db),
				current.merchantKey,
				edit.displayName,
			]),
		);
	// A name a person gives settles the merchant's pending suggestion: accepted when it is one of the
	// suggested names, rejected when it is their own (spec §7). A form that gave no name leaves the
	// merchant's name and suggestion alone; its row is still made, which a rule needs.
	// "This one only" (decision 101) names just this transaction: its own_name is set, and the merchant's
	// name and suggestions wait as they are. "All" renames the merchant, and this transaction's own name
	// (if it has one) is replaced too, while other transactions' own names stay.
	const oneOnly = edit.nameChanged !== false && edit.nameScope === "one";
	const renamesMerchant = edit.nameChanged !== false && !oneOnly;
	statements.push(
		renamesMerchant
			? gated(
					"INSERT INTO merchants (raw_name, display_name) SELECT ?, ? WHERE 1",
					[current.merchantKey, edit.displayName],
					` ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name, ${SETTLE_SUGGESTION_SQL}`,
				)
			: gated(
					"INSERT INTO merchants (raw_name) SELECT ? WHERE 1",
					[current.merchantKey],
					" ON CONFLICT(raw_name) DO NOTHING",
				),
	);
	// The store's own name has no displayName, so this row takes the bank's text tidied, which is what it
	// shows and what the save's toast names; the merchant's own name stays as it was.
	if (oneOnly)
		statements.push(
			gated(
				"UPDATE transactions SET own_name = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
				[edit.displayName ?? tidyName(current.rawName), actor, id],
			),
		);
	if (renamesMerchant)
		statements.push(
			gated(
				"UPDATE transactions SET own_name = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND own_name IS NOT NULL",
				[actor, id],
			),
		);
	// "Keep the bank's name": the tidied text stays and the suggestions are turned down, never offered again.
	if (edit.keepBankName && edit.displayName === null && renamesMerchant)
		statements.push(
			gated(
				"UPDATE merchants SET suggestion_status = 'rejected' WHERE raw_name = ? AND suggestion_status = 'pending'",
				[current.merchantKey],
			),
		);
	// A credit a person newly marks as income, or newly reviews as a refund or other non-income credit,
	// is theirs to count (decision 70), so an exclusion Plaid put on it (a transfer category) comes off,
	// even though the panel sends its Exclude chip as it was drawn, on. This runs after the panel's own
	// update: a chip the person turned off already made the exclusion theirs, and a person's or Jev's
	// exclusion is never Plaid's to lift.
	if ((edit.income && current.income === 0) || creditReviewByUser)
		statements.push(
			gated(
				`UPDATE transactions SET excluded = 0, excluded_source = NULL, updated_by = ?, updated_at = datetime('now')
				WHERE id = ? AND amount_cents < 0 AND excluded_source = 'plaid'`,
				[actor, id],
			),
		);
	// A split credit is one bank transaction and only its parts count, so a person reviewing it from
	// the split's own panel reviews its parts too, and Plaid's exclusion comes off them. A part that is
	// income keeps that, and so does one a person or Jev excluded.
	if (creditReviewByUser && current.isSplit === 1)
		statements.push(
			gated(
				`UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user',
					excluded = CASE WHEN excluded_source = 'plaid' THEN 0 ELSE excluded END,
					excluded_source = CASE WHEN excluded_source = 'plaid' THEN NULL ELSE excluded_source END,
					updated_by = ?, updated_at = datetime('now')
				WHERE parent_id = ? AND amount_cents < 0 AND flag_income = 0`,
				[actor, id],
			),
		);
	if (newLink === null) {
		// Unlinking: the parts of a split refund that still follow its link go too, before its own
		// update changes it; one a person linked to another purchase keeps its own choice. The
		// credit's review stays as it was.
		statements.push(
			gated(
				"UPDATE transactions SET refund_of_id = NULL WHERE parent_id = ?1 AND refund_of_id IS (SELECT refund_of_id FROM transactions WHERE id = ?1)",
				[id],
			),
			gated("UPDATE transactions SET refund_of_id = NULL WHERE id = ?", [id]),
		);
	} else if (linking) {
		// An explicit human link is also a review of this credit as a refund. The link was written
		// first, with that review, but the category update after it applies the panel's review chip,
		// which a person linking a refund hasn't ticked, so the review is made again here. It stays on
		// a split parent, so its parts inherit the reviewed link as one bank transaction.
		statements.push(
			gated(
				`UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user'
					WHERE id = ? AND amount_cents < 0 AND refund_of_id = ?`,
				[id, newLink],
			),
		);
	}
	// A one-off name makes Tally guess the category again, from the purchase's own name (decision 101): a category
	// Tally picked, or no category at all (an unsure answer included), is cleared so the next answer can take its
	// place, unless the same save ticks the merchant rule, which settles the category (oneOffGuessesAgain).
	// A pending new-category suggestion the row is behind is released with it, so the row leaves the
	// suggestion and Jev is asked again. Only on a row Jev can be asked about (jevAsksAboutSql, as the row stands
	// once the writes above have run), which is the same test as oneOffGuessesAgain's, so the clear and the words agree.
	const askable = {
		included: excluded === 0 || current.paysBill === 1,
		isSplit: current.isSplit === 1,
		income:
			incomeChanged || creditReviewByUser
				? incomeChanged && edit.income
				: current.income === 1,
		// A new link is taken as one that counts (the route refuses an excluded purchase); a kept link counts
		// while its purchase isn't excluded.
		followsPurchase:
			(newLink === undefined
				? current.refundOfId !== null && current.purchaseExcluded === 0
				: newLink !== null) && followsPurchaseAfterSave(storedCredit, edit),
	};
	if (
		oneOffGuessesAgain({
			edit,
			current: {
				categoryId: current.categoryId,
				categorySource: current.categorySource,
			},
			postedCategory: edit.categoryId,
			row: askable,
		})
	)
		statements.push(
			gated(
				`UPDATE transactions SET category_id = NULL, category_source = NULL, category_confidence = NULL,
					category_suggestion_id = NULL, jev_category_id = NULL, jev_none_fit = 0, updated_by = ?, updated_at = datetime('now')
				WHERE id = ? AND (category_source = 'jev' OR (category_id IS NULL AND category_source IS NULL))
					AND ${jevAsksAboutSql("transactions")}`,
				[actor, id],
			),
		);
	// A split is one bank transaction: excluding any part of it excludes the purchase and
	// all its parts. Child audit fields change only when the choice does.
	// A Kind or For that differs from the stored one changes it and clears Jev's category confidence
	// (kindChanged, personChanged). A pick is the person's choice even when it is the stored guess (kindTaken,
	// personTaken, #377): with Details hidden the panel drew the guess as Not known, so a posted value that
	// differs from what was drawn (detailsFieldChanged) is a pick, whatever the stored value is.
	const kindChanged =
		edit.kind !== undefined &&
		edit.kind !== current.kind &&
		(current.kindGuessed === 0 ||
			edit.detailsVisible !== false ||
			edit.detailsFieldChanged === true);
	const kindTaken =
		kindChanged ||
		(edit.kind !== undefined &&
			current.kindGuessed === 1 &&
			edit.detailsFieldChanged === true);
	const personChanged =
		edit.forPersonId !== undefined &&
		edit.forPersonId !== current.forPersonId &&
		(current.forPersonGuessed === 0 ||
			edit.detailsVisible !== false ||
			edit.detailsFieldChanged === true);
	const personTaken =
		personChanged ||
		(edit.forPersonId !== undefined &&
			current.forPersonGuessed === 1 &&
			edit.detailsFieldChanged === true);
	if (noteChanged || kindTaken || personTaken || edit.keepDetails) {
		statements.push(
			gated(
				`UPDATE transactions SET
					kind = CASE WHEN ? = 1 THEN ? ELSE kind END,
					kind_guessed = CASE WHEN ? = 1 OR ? = 1 THEN 0 ELSE kind_guessed END,
					kind_cleared = CASE WHEN ? = 1 THEN ? ELSE kind_cleared END,
					for_person_id = CASE WHEN ? = 1 THEN ? ELSE for_person_id END,
					for_person_guessed = CASE WHEN ? = 1 OR ? = 1 THEN 0 ELSE for_person_guessed END,
					for_person_cleared = CASE WHEN ? = 1 THEN ? ELSE for_person_cleared END,
					note = CASE WHEN ? = 1 THEN ? ELSE note END,
					note_guessed = CASE WHEN ? = 1 OR ? = 1 THEN 0 ELSE note_guessed END,
					note_tried_at = CASE WHEN ? = 1 AND trim(COALESCE(?, '')) = '' THEN datetime('now') ELSE note_tried_at END,
					note_dismissed = CASE WHEN ? = 1 AND ? = 1 AND trim(COALESCE(?, '')) = '' THEN 1 ELSE note_dismissed END,
					category_confidence = CASE WHEN ? = 1 OR ? = 1 THEN NULL ELSE category_confidence END,
					updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
				[
					kindChanged ? 1 : 0,
					edit.kind ?? null,
					kindTaken ? 1 : 0,
					edit.keepDetails ? 1 : 0,
					kindChanged ? 1 : 0,
					edit.kind === null ? 1 : 0,
					personChanged ? 1 : 0,
					edit.forPersonId ?? null,
					personTaken ? 1 : 0,
					edit.keepDetails ? 1 : 0,
					personChanged ? 1 : 0,
					edit.forPersonId === null ? 1 : 0,
					noteChanged ? 1 : 0,
					edit.note,
					noteChanged ? 1 : 0,
					edit.keepDetails ? 1 : 0,
					noteChanged ? 1 : 0,
					edit.note,
					noteChanged ? 1 : 0,
					current.noteGuessed,
					edit.note,
					kindChanged ? 1 : 0,
					personChanged ? 1 : 0,
					actor,
					id,
				],
			),
		);
	}
	if (excluded !== current.excluded)
		statements.push(
			gated(
				`UPDATE transactions SET excluded = ?1, excluded_source = 'user', updated_by = ?2, updated_at = datetime('now')
				WHERE id != ?3 AND (
					parent_id = ?3
					OR id = (SELECT parent_id FROM transactions WHERE id = ?3)
					OR parent_id = (SELECT parent_id FROM transactions WHERE id = ?3)
				)`,
				[excluded, actor, id],
			),
		);
	const ruleChange = merchantRuleChange(
		edit.alwaysWas ?? false,
		edit.alwaysForMerchant,
		edit.merchantRuleWas,
		edit.categoryId,
	);
	if (ruleChange.action === "set" && edit.categoryId !== null) {
		statements.push(
			gated("UPDATE merchants SET default_category_id = ? WHERE raw_name = ?", [
				edit.categoryId,
				current.merchantKey,
			]),
		);
		if (ruleChange.recategorize)
			statements.push(
				gated(`${APPLY_MERCHANT_RULE_SQL} AND id != ?`, [
					edit.categoryId,
					actor,
					current.merchantKey,
					id,
				]),
			);
	} else if (ruleChange.action === "clear" && edit.merchantRuleWas != null) {
		statements.push(
			gated(`${CLEAR_MERCHANT_RULE_SQL} AND default_category_id = ?`, [
				current.merchantKey,
				edit.merchantRuleWas,
			]),
		);
	}
	let cashChangeIndex: number | null = null;
	if (edit.cashDate !== undefined && edit.cashAmountCents !== undefined) {
		cashChangeIndex = statements.length;
		statements.push(
			gated(
				"UPDATE transactions SET date = ?, amount_cents = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
				[edit.cashDate, edit.cashAmountCents, actor, id],
			),
			gated(
				"UPDATE transactions SET date = ?, updated_by = ?, updated_at = datetime('now') WHERE parent_id = ?",
				[edit.cashDate, actor, id],
			),
		);
	}
	// A For person removed after the panel's household list loaded fails the details write on its foreign
	// key. The batch is atomic, so that failure saved nothing: it is a refusal, and the person is named.
	const results = await db.batch(statements).catch(async (error: unknown) => {
		if (
			personChanged &&
			typeof edit.forPersonId === "number" &&
			!(await db
				.prepare("SELECT 1 FROM household_people WHERE id = ?")
				.bind(edit.forPersonId)
				.first())
		)
			return null;
		throw error;
	});
	if (!results) return { saved: false, personMissing: true };
	// A split review with a part that doesn't fit its own purchase is refused by the parts check, which leaves
	// the statement that decides unchanged (the link's, for a link; the panel's otherwise). The first such part
	// names its purchase; with none, the cash and link checks below say why.
	if (splitReview && !results[linking ? 1 : 0]?.meta.changes) {
		const part = await db
			.prepare(
				`SELECT kid.refund_of_id AS id, buy.date AS date, buy.amount_cents AS amountCents, c.name AS categoryName
				FROM transactions kid JOIN transactions buy ON buy.id = kid.refund_of_id
				LEFT JOIN categories c ON c.id = buy.category_id
				WHERE ${splitPartMisfitSql("?1", "?2")} ORDER BY kid.id LIMIT 1`,
			)
			.bind(...partsGate.args)
			.first<{
				id: number;
				date: string;
				amountCents: number;
				categoryName: string | null;
			}>();
		if (part)
			return {
				saved: false,
				refundLeftCents: await refundLeftCents(db, part.id, id),
				refundPurchase: part,
			};
	}
	if (cashChangeIndex !== null && !results[cashChangeIndex]?.meta.changes) {
		const state = await db
			.prepare(
				`SELECT COALESCE((SELECT SUM(amount_cents) FROM transactions part WHERE part.parent_id = cash.id), 0) AS parts,
				COALESCE((SELECT SUM(ABS(refund.amount_cents)) FROM transactions refund WHERE refund.refund_of_id = cash.id AND refund.is_split = 0 AND refund.amount_cents < 0 AND refund.flag_income = 0), 0) AS refunds
				FROM transactions cash WHERE cash.id = ?`,
			)
			.bind(id)
			.first<{ parts: number; refunds: number }>();
		// The row is there unless it was deleted during the save, and then nothing says why it was refused.
		if (!state) throw new Error(`No transaction ${id}`);
		if (current.isSplit && state.parts !== edit.cashAmountCents)
			return { saved: false, cashError: "split", amountCents: state.parts };
		return { saved: false, cashError: "refund", refundCents: state.refunds };
	}
	// The statement that decides is the refund's own link, the second one, when there is a link; for a
	// credit that counts again it is the panel's own update, the first. No change means the amount
	// didn't fit, and then none of the others applied either.
	const purchase = linking ? newLink : recounting;
	if (typeof purchase === "number" && !results[linking ? 1 : 0]?.meta.changes)
		return {
			saved: false,
			refundLeftCents: await refundLeftCents(db, purchase, id),
		};
	return { saved: true };
}

/**
 * Sets a merchant's category rule the way the edit panel's tick does, for a save that has no
 * row of its own to skip: the rule reaches every transaction a person hasn't chosen.
 */
export async function setMerchantRule(
	db: D1Database,
	merchantKey: string,
	categoryId: number,
	actor: string,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)
			ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id`,
			)
			.bind(merchantKey, categoryId),
		db.prepare(APPLY_MERCHANT_RULE_SQL).bind(categoryId, actor, merchantKey),
	]);
}

/**
 * A refund linked to a purchase or one of its parts. A split refund's own row is `isSplit`; its parts are the refunds,
 * marked `isPart`. `follows` is FOLLOWS_PURCHASE: a credit that still counts against its purchase.
 */
export type LinkedRefund = {
	id: number;
	date: string;
	amountCents: number;
	isSplit: boolean;
	isPart: boolean;
	follows: boolean;
};

/**
 * The refunds linked to a purchase or its parts, oldest first: the ones a split change affects.
 * `self` includes refunds of the purchase itself.
 */
export async function linkedRefunds(
	db: D1Database,
	id: number,
	self: boolean,
): Promise<LinkedRefund[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.is_split AS isSplit,
				t.parent_id IS NOT NULL AS isPart, ${FOLLOWS_PURCHASE} AS follows
			FROM transactions t JOIN transactions rp ON rp.id = t.refund_of_id
			WHERE t.refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ?1${self ? " OR id = ?1" : ""})
			ORDER BY t.date, t.id`,
		)
		.bind(id)
		.all<{
			id: number;
			date: string;
			amountCents: number;
			isSplit: number;
			isPart: number;
			follows: number;
		}>();
	return results.map((row) => ({
		id: row.id,
		date: row.date,
		amountCents: row.amountCents,
		isSplit: row.isSplit === 1,
		isPart: row.isPart === 1,
		follows: row.follows === 1,
	}));
}

/**
 * Whether the split sheet asks which part a linked refund goes with, and saveSplit moves it (decision 99): a plain
 * refund that still follows its purchase. A split refund's own row is never offered, nor are its parts, since its
 * parts are what count. A credit that no longer follows (income, unreviewed, or on an excluded purchase) isn't asked
 * about: a split unlinks it, and the toast names it.
 */
export const offeredToSplit = (refund: LinkedRefund) =>
	!refund.isSplit && !refund.isPart && refund.follows;

/**
 * The bills the linked payments of a purchase's parts pay, oldest payment first. Read before a change
 * removes the parts, which unlinks those payments (decision 99).
 */
async function partBills(
	db: D1Database,
	parentId: number,
): Promise<PartPayment[]> {
	const { results } = await db
		.prepare(
			`SELECT bp.id AS paymentId, b.id AS billId, b.name AS name, bp.period AS period,
			part.amount_cents AS amountCents, part.category_id AS categoryId
			FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id JOIN transactions part ON part.id = bp.transaction_id
			WHERE part.parent_id = ? AND bp.status = 'linked' ORDER BY bp.id`,
		)
		.bind(parentId)
		.all<PartPayment>();
	return results;
}

/** A linked payment on a part, with the part's amount and category: what a replacement can keep it by. */
type PartPayment = UnpaidBill & {
	billId: number;
	paymentId: number;
	amountCents: number;
	categoryId: number | null;
};

/**
 * Pairs each linked payment with the first unused new part of the same amount and category, oldest payment
 * first (decision 99). A payment with no such part is lost: its bill is unpaid, and it is named.
 */
function keepPayments(payments: PartPayment[], parts: SplitPart[]) {
	const used = new Set<number>();
	const kept: { paymentId: number; index: number }[] = [];
	const lost: PartPayment[] = [];
	for (const payment of payments) {
		const index = parts.findIndex(
			(part, i) =>
				!used.has(i) &&
				part.amountCents === payment.amountCents &&
				part.categoryId === payment.categoryId,
		);
		if (index === -1) {
			lost.push(payment);
		} else {
			used.add(index);
			kept.push({ paymentId: payment.paymentId, index });
		}
	}
	return { kept, lost };
}

/**
 * The occurrences a change's lost payments paid, once each: two parts' payments can pay one occurrence (decision
 * 101), and that is still one bill. Bound as the JSON stillUnpaidStatement reads.
 */
const lostOccurrences = (bills: PartPayment[]) => [
	...new Map(
		bills.map(({ billId, name, period }) => [
			`${billId}:${period}`,
			{ billId, name, period },
		]),
	).values(),
];

/**
 * The last statement of a split change's batch: which of the lost occurrences are still unpaid once the batch's
 * writes are in (STILL_UNPAID_BILLS_SQL), so a payment the change kept, or one the rest of the payments still
 * covers, names nothing (decisions 74 and 105). It must follow every write it reads.
 */
const stillUnpaidStatement = (db: D1Database, lost: PartPayment[]) =>
	db
		.prepare(`SELECT ${STILL_UNPAID_BILLS_SQL("?")} AS bills`)
		.bind(JSON.stringify(lostOccurrences(lost)));

/** The bills a batch's stillUnpaidStatement returned, as the toast names them: a name and an occurrence. */
function unpaidBillsFrom(result: D1Result | undefined): UnpaidBill[] {
	const row = result?.results[0] as { bills: string | null } | undefined;
	return parseUnpaidBills(row?.bills).map(({ name, period }) => ({
		name,
		period,
	}));
}

/**
 * Creates every child and marks its parent in one D1 batch. A human-confirmed refund link follows
 * each new part, if the whole refund still fits its purchase (src/db/refunded.ts), and is dropped if
 * not; refunds linked to replaced parts are unlinked in the same batch. A refund a bank change unlinked
 * keeps its unlink date on each new part, so the parts still say why (decision 99). The bill payments
 * of replaced parts are unlinked, with no dismissal left, so the matcher may link a bill again; the bills still
 * unpaid after the change are returned by name (decisions 99 and 105). A person's own Not this one is kept on the
 * purchase, and each new part starts with it.
 *
 * `choices` says which part each linked refund goes with (decision 99): the part's index in `parts`, or null for
 * Not linked. Only an offered refund (offeredToSplit) can be chosen; the others are unlinked, and named. A refund left
 * out of `choices`, or whose part is not among `parts`, is unlinked, as before. A chosen refund is parked on the
 * purchase before the old parts are deleted, so it is checked where it is in the batch: it moves to its part only if
 * it is still linked to the purchase or its parts, still a plain, top-level refund that follows the purchase
 * (FOLLOWS_PURCHASE), and the whole refund still fits that part (refundFitsSql), counting the refunds already moved
 * there in this batch. A chosen refund that a competing save relinked or unlinked since the read stays as it is, and
 * is named in neither list. One that was parked but doesn't move is unlinked, and is listed in `unlinked` like any
 * other. `moved` lists the chosen refunds that moved, by the date the save wrote them; `unlinked` lists the refunds
 * this save unlinked, by date.
 */
export async function saveSplit(
	db: D1Database,
	parentId: number,
	parts: SplitPart[],
	by: string,
	choices: Record<number, number | null> = {},
): Promise<{
	saved: boolean;
	unlinked: string[];
	bills: UnpaidBill[];
	moved: { date: string; part: number }[];
}> {
	const parent = await db
		.prepare("SELECT id FROM transactions WHERE id = ? AND parent_id IS NULL")
		.bind(parentId)
		.first();
	if (!parent) throw new Error(`No transaction ${parentId}`);
	// Every child reads its parent inside the atomic batch, so date, exclusion and review edits
	// made after the route validation are reflected in the children.
	const total = parts.reduce((sum, part) => sum + part.amountCents, 0);
	const unchanged =
		"EXISTS (SELECT 1 FROM transactions WHERE id = ? AND amount_cents = ?)";
	// The same check with numbered parameters, for the statements that keep a person's Not this one (decision 105).
	const unchangedNumbered =
		"EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND amount_cents = ?2)";
	const reviewColumns = ", income_source, credit_reviewed, credit_reviewed_by";
	const reviewValues =
		", (SELECT income_source FROM transactions WHERE id = ?), (SELECT credit_reviewed FROM transactions WHERE id = ?), (SELECT credit_reviewed_by FROM transactions WHERE id = ?)";
	const linked = await linkedRefunds(db, parentId, true);
	// A chosen refund goes with its part: only an offered refund can move. Each move is checked in the batch
	// (refundFitsSql), and only the ones that fit move.
	const moves = linked.flatMap((refund) => {
		const part = choices[refund.id] ?? null;
		return offeredToSplit(refund) &&
			part !== null &&
			Number.isInteger(part) &&
			part >= 0 &&
			part < parts.length
			? [{ refundId: refund.id, part }]
			: [];
	});
	const chosenIds = JSON.stringify(moves.map((move) => move.refundId));
	const payments = await partBills(db, parentId);
	const { kept, lost } = keepPayments(payments, parts);
	const linkedPurchase = await db
		.prepare(
			"SELECT refund_of_id AS refundOfId, date FROM transactions WHERE id = ?",
		)
		.bind(parentId)
		.first<{ refundOfId: number | null; date: string }>();
	const inheritedRefundLink =
		"CASE WHEN refund_of_id IS NOT NULL AND EXISTS (SELECT 1 FROM transactions rp WHERE rp.id = transactions.refund_of_id) THEN refund_of_id ELSE NULL END";
	// A kept payment is parked on the purchase as dismissed, out of the way of the parts it leaves, and moved to its
	// new part last. Only linked rows are unique, so the parked row can't clash (decision 99).
	const park =
		kept.length > 0
			? [
					db
						.prepare(
							`UPDATE bill_payments SET transaction_id = ?, status = 'dismissed'
							WHERE id IN (SELECT value FROM json_each(?)) AND status = 'linked' AND ${unchanged}`,
						)
						.bind(
							parentId,
							JSON.stringify(kept.map((keep) => keep.paymentId)),
							parentId,
							total,
						),
				]
			: [];
	const unlinkRefund = db
		.prepare(
			`${unlinkSplitOverRefundedSql("?1")} AND EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND amount_cents = ?2)`,
		)
		.bind(parentId, total);
	// Each kept payment moves to the new part at its position in the sheet, which the new parts' ids follow.
	const restore = kept.map((keep) =>
		db
			.prepare(
				`UPDATE bill_payments SET transaction_id = (SELECT id FROM transactions WHERE parent_id = ? ORDER BY id LIMIT 1 OFFSET ?), status = 'linked'
				WHERE id = ? AND transaction_id = ? AND status = 'dismissed' AND ${unchanged}`,
			)
			.bind(parentId, keep.index, keep.paymentId, parentId, parentId, total),
	);
	const markParent = db
		.prepare(
			"UPDATE transactions SET is_split = 1, category_suggestion_id=NULL, jev_none_fit=0, split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND amount_cents = ?",
		)
		.bind(by, parentId, total);
	const stillUnpaid = stillUnpaidStatement(db, lost);
	// The new part at a sheet index (its id order, as restore finds a kept payment's part). ?1 is the purchase.
	const partAt = (index: string) =>
		`(SELECT id FROM transactions WHERE parent_id = ?1 ORDER BY id LIMIT 1 OFFSET ${index})`;
	// A chosen refund is parked on the purchase before the old parts go, so a part's delete can't unlink it, and the
	// move below checks it is still there. Only a link that is still on the purchase or its parts parks (changes a row):
	// one a competing save moved or unlinked since the read doesn't, and stays as it is.
	const parkStatements = moves.map((move) => ({
		move,
		statement: db
			.prepare(
				`UPDATE transactions SET refund_of_id = ?1
				WHERE id = ?3 AND refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ?1 OR id = ?1) AND ${unchangedNumbered}`,
			)
			.bind(parentId, total, move.refundId),
	}));
	// A chosen refund moves onto its part once the parts exist. It moves only if it is still on the purchase (parked
	// above), still a plain, top-level refund that follows the purchase (a competing save can split or change the credit
	// after the read), and the whole refund still fits that part (refundFitsSql), counting the refunds moved before it in
	// this batch. A refusal leaves it on the purchase, where the sweep below unlinks it. RETURNING gives the row it
	// moved, with the date the save wrote it.
	const moveStatements = moves.map((move) => ({
		move,
		statement: db
			.prepare(
				`UPDATE transactions SET refund_of_id = ${partAt("?4")}
				WHERE id = ?3 AND refund_of_id = ?1 AND ${refundFitsSql("?3", partAt("?4"))} AND ${unchangedNumbered}
				AND EXISTS (SELECT 1 FROM transactions t JOIN transactions rp ON rp.id = t.refund_of_id WHERE t.id = ?3 AND ${FOLLOWS_PURCHASE} AND t.is_split = 0 AND t.parent_id IS NULL)
				RETURNING id, date`,
			)
			.bind(parentId, total, move.refundId, move.part),
	}));
	// A chosen refund that parked and didn't move is still on the purchase: it is unlinked, and named. One that moved is not.
	const sweepRefused = db
		.prepare(
			`UPDATE transactions SET refund_of_id = NULL
			WHERE id IN (SELECT value FROM json_each(?3)) AND refund_of_id = ?1 AND ${unchangedNumbered}
			RETURNING id, date`,
		)
		.bind(parentId, total, chosenIds);
	// Every refund still linked to the purchase or its parts is unlinked, except the chosen ones, which are parked
	// above and move below. RETURNING names each one it unlinks, including one a competing save linked after the read.
	const unlinkLinked = db
		.prepare(
			`UPDATE transactions SET refund_of_id = NULL
			WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ?1 OR id = ?1) AND id NOT IN (SELECT value FROM json_each(?3)) AND ${unchangedNumbered}
			RETURNING id, date`,
		)
		.bind(parentId, total, chosenIds);
	const statements = [
		...parkStatements.map(({ statement }) => statement),
		unlinkLinked,
		// A person's own Not this one on a part moves onto the purchase before the parts go (decision 105). It runs before
		// park, since a payment a person linked by hand is parked as a dismissal on the purchase and would hide that one.
		db
			.prepare(movePartDismissalsSql("?1", "?1", unchangedNumbered))
			.bind(parentId, total),
		...park,
		// The replaced parts go with their bill payments, which are unlinked with no dismissal left (decision 105).
		// Kept ones moved above.
		db
			.prepare(`DELETE FROM transactions WHERE parent_id = ? AND ${unchanged}`)
			.bind(parentId, parentId, total),
		// With the old parts gone and before the new ones take the parent's link: if the whole refund
		// no longer fits its purchase, the link goes, and the new parts start unlinked.
		unlinkRefund,
		...parts.map((part) =>
			db
				.prepare(`INSERT INTO transactions
			(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded, excluded_source${reviewColumns}, refund_of_id, refund_unlinked_purchase_date, parent_id, plaid_transaction_id, updated_by)
			SELECT account_id, date, ?, raw_name, merchant_name, ?, 'user', excluded, excluded_source${reviewValues},
				${inheritedRefundLink}, refund_unlinked_purchase_date, id, NULL, ?
			FROM transactions WHERE id = ? AND amount_cents = ?`)
				.bind(
					part.amountCents,
					part.categoryId,
					parentId,
					parentId,
					parentId,
					by,
					parentId,
					total,
				),
		),
		...restore,
		...moveStatements.map(({ statement }) => statement),
		sweepRefused,
		// Each new part starts with the purchase's own Not this one (decision 105), once the kept payments are restored.
		db
			.prepare(purchaseDismissalsToPartsSql("?1", unchangedNumbered))
			.bind(parentId, total),
		markParent,
		stillUnpaid,
	];
	const results = await db.batch(statements);
	const saved =
		(results[statements.indexOf(markParent)]?.meta.changes ?? 0) > 0;
	const changed = (statement: D1PreparedStatement) =>
		(results[statements.indexOf(statement)]?.meta.changes ?? 0) > 0;
	// The rows a statement returned with RETURNING: the refunds it changed.
	const returnedRows = (statement: D1PreparedStatement) =>
		(results[statements.indexOf(statement)]?.results ?? []) as {
			id: number;
			date: string;
		}[];
	// A refund's own link is kept by its new parts, unless it no longer fit: then it is the one unlinked.
	const refundUnlinked = changed(unlinkRefund);
	return {
		saved,
		unlinked: !saved
			? []
			: !linkedPurchase?.refundOfId
				? [...returnedRows(unlinkLinked), ...returnedRows(sweepRefused)]
						.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
						.map((row) => row.date)
				: refundUnlinked
					? [linkedPurchase.date]
					: [],
		// Only the bills a person's split change unlinked and that are still unpaid are named (decisions 99 and 105).
		bills: saved
			? unpaidBillsFrom(results[statements.indexOf(stillUnpaid)])
			: [],
		// A chosen refund that moved returned its row, which it does only once it passed every check in the batch.
		moved: saved
			? moveStatements.flatMap(({ move, statement }) =>
					returnedRows(statement).map((row) => ({
						date: row.date,
						part: move.part,
					})),
				)
			: [],
	};
}

/** One part of a split cash entry's correction: `id` is the saved part it updates, null for a new one. */
export type CashSplitPart = {
	id: number | null;
	categoryId: number;
	amountCents: number;
};

/**
 * Change the parts (spec §8.4): saves a split cash entry's new total and its corrected parts in one
 * atomic batch. Saved parts are updated in place by id and new ones are added, so the split and every
 * refund linked to a part stay linked (decision 79: a cash entry's split is never reset). Unlike saveSplit,
 * nothing is deleted or unlinked; a new part starts with the purchase's own Not this one (decision 105).
 *
 * Every statement carries the same gate, so a refusal writes nothing, except the copy of the Not this one
 * to the new parts, which guards on the parts' count instead (see below). The gate checks that the entry is
 * still the split it was drawn as (`amountWasCents`, or the new total once the parent statement has set
 * it), that every posted saved part is still one of its parts, that the refunds linked to the entry and to
 * its parts together fit the new total, that the refunds linked to each part still fit its new amount
 * (src/db/refunded.ts), and that the entry has no parts but the saved ones. The parent's amount is set
 * first and the new parts are inserted last among the gated statements, in one statement, so nothing the
 * gate reads changes under an earlier statement: a part another save added in the meantime refuses every
 * statement, and no statement can pass after an earlier one refused. Returns `refundTotalCents` (what the
 * refunds linked to the entry and its parts together take) when those are more than the new total, which
 * moving the parts can't fix.
 * Returns `refundPart` (the part's 1-based position and what its refunds take) when a part's refunds don't
 * fit; throws when the entry or its parts are no longer as they were drawn, so the save is an error.
 */
export async function correctCashSplit(
	db: D1Database,
	parentId: number,
	edit: { totalCents: number; amountWasCents: number; parts: CashSplitPart[] },
	by: string,
): Promise<
	| { saved: true }
	| { saved: false; refundTotalCents: number }
	| { saved: false; refundPart: { part: number; refundCents: number } }
> {
	const { totalCents, amountWasCents, parts } = edit;
	const partsTotal = parts.reduce((sum, part) => sum + part.amountCents, 0);
	if (partsTotal !== totalCents)
		throw new Error(`The parts of ${parentId} don't add up to ${totalCents}`);
	const savedParts = parts.flatMap((part, index) =>
		part.id === null
			? []
			: [{ id: part.id, cents: part.amountCents, position: index + 1 }],
	);
	const savedJson = JSON.stringify(savedParts);
	const current = await db
		.prepare("SELECT id FROM transactions WHERE parent_id = ? ORDER BY id")
		.bind(parentId)
		.all<{ id: number }>();
	const savedIds = savedParts.map((part) => part.id).sort((x, y) => x - y);
	const currentIds = current.results.map((row) => row.id);
	if (
		savedIds.length !== currentIds.length ||
		savedIds.some((id, index) => id !== currentIds[index])
	)
		throw new Error(`Split ${parentId} changed while it was being corrected`);

	// The gate's parameters are numbered from `n`, after the statement's own. Its entry amount is either the
	// drawn one or the new total, which the parent statement sets first, so the gate reads the same thing
	// before and after every statement that can pass. No statement adds a part before the last one.
	const gate = (n: number) => `EXISTS (SELECT 1 FROM transactions cash
			WHERE cash.id = ?${n} AND cash.parent_id IS NULL AND cash.is_split = 1 AND cash.amount_cents IN (?${n + 1}, ?${n + 2})
				AND cash.account_id IN (SELECT id FROM accounts WHERE type = 'cash'))
		AND NOT EXISTS (SELECT 1 FROM json_each(?${n + 3}) AS saved
			WHERE (SELECT parent_id FROM transactions WHERE id = json_extract(saved.value, '$.id')) IS NOT ?${n})
		AND NOT EXISTS (SELECT 1 FROM json_each(?${n + 3}) AS saved
			WHERE ${refundedByOthersSql("json_extract(saved.value, '$.id')", "0")} > json_extract(saved.value, '$.cents'))
		AND (${refundedByOthersSql(`?${n}`, "0")}
			+ COALESCE((SELECT SUM(${refundedByOthersSql("json_extract(saved.value, '$.id')", "0")}) FROM json_each(?${n + 3}) AS saved), 0)) <= ?${n + 2}
		AND NOT EXISTS (SELECT 1 FROM transactions WHERE parent_id = ?${n}
			AND id NOT IN (SELECT json_extract(saved.value, '$.id') FROM json_each(?${n + 3}) AS saved))`;
	const gateArgs = [parentId, amountWasCents, totalCents, savedJson];
	const gated = (sql: string, args: unknown[]) =>
		db
			.prepare(`${sql} AND ${gate(args.length + 1)}`)
			.bind(...args, ...gateArgs);

	const parentStatement = gated(
		"UPDATE transactions SET amount_cents = ?1, updated_by = ?2, updated_at = datetime('now') WHERE id = ?3",
		[totalCents, by, parentId],
	);
	const partStatements = parts.flatMap((part) =>
		part.id === null
			? []
			: [
					gated(
						"UPDATE transactions SET amount_cents = ?1, category_id = ?2, category_source = 'user', updated_by = ?3, updated_at = datetime('now') WHERE id = ?4 AND parent_id = ?5",
						[part.amountCents, part.categoryId, by, part.id, parentId],
					),
				],
	);
	// Every new part in one statement, so the count the gate reads is still the saved parts' count until it runs.
	// The copy of the purchase's Not this one below is the one statement after it, and it is not gated.
	const newParts = parts.flatMap((part) =>
		part.id === null
			? [{ cents: part.amountCents, categoryId: part.categoryId }]
			: [],
	);
	const insertStatements =
		newParts.length === 0
			? []
			: [
					gated(
						`INSERT INTO transactions
					(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded, excluded_source, income_source, credit_reviewed, credit_reviewed_by, refund_of_id, refund_unlinked_purchase_date, parent_id, plaid_transaction_id, updated_by)
				SELECT t.account_id, t.date, json_extract(p.value, '$.cents'), t.raw_name, t.merchant_name, json_extract(p.value, '$.categoryId'), 'user', t.excluded, t.excluded_source, t.income_source, t.credit_reviewed, t.credit_reviewed_by, NULL, t.refund_unlinked_purchase_date, t.id, NULL, ?1
				FROM json_each(?2) AS p, transactions t
				WHERE t.id = ?3`,
						[by, JSON.stringify(newParts), parentId],
					),
				];
	// The copy of the purchase's Not this one to the new parts (decision 105) follows the insert and is not gated: the
	// gate's last check fails once the new parts exist. It guards on the parts' count instead, which is the posted count
	// only if the insert ran, so a refused batch still writes nothing.
	const purchaseDismissals =
		newParts.length === 0
			? []
			: [
					db
						.prepare(
							purchaseDismissalsToPartsSql(
								"?1",
								"EXISTS (SELECT 1 FROM transactions cash WHERE cash.id = ?1 AND cash.is_split = 1 AND cash.amount_cents = ?3) AND (SELECT COUNT(*) FROM transactions WHERE parent_id = ?1) = ?2",
							),
						)
						.bind(parentId, parts.length, totalCents),
				];
	// The parent's amount is set first, so a refusal by any statement leaves the batch with nothing written. The
	// purchase's Not this one copy runs last, after the insert, and only when a part was added.
	const results = await db.batch([
		parentStatement,
		...partStatements,
		...insertStatements,
		...purchaseDismissals,
	]);
	if ((results[0]?.meta.changes ?? 0) > 0) return { saved: true };

	// Nothing changed. If the entry is still as it was drawn, the refunds linked to the entry and to its
	// parts together come first, since moving its parts can't make them fit; then the first part whose
	// refunds no longer fit (in the sheet's order) is the reason. Otherwise the entry changed, which is an error.
	const linked = await db
		.prepare(
			`SELECT ${refundedByOthersSql("?1", "0")} + COALESCE((SELECT SUM(${refundedByOthersSql("json_extract(saved.value, '$.id')", "0")}) FROM json_each(?2) AS saved), 0) AS refundCents
			FROM transactions cash
			WHERE cash.id = ?1 AND cash.parent_id IS NULL AND cash.is_split = 1 AND cash.amount_cents = ?3`,
		)
		.bind(parentId, savedJson, amountWasCents)
		.first<{ refundCents: number }>();
	if (linked && linked.refundCents > totalCents)
		return { saved: false, refundTotalCents: linked.refundCents };
	const misfit = `${refundedByOthersSql("json_extract(saved.value, '$.id')", "0")} > json_extract(saved.value, '$.cents')`;
	const refused = await db
		.prepare(
			`SELECT json_extract(saved.value, '$.position') AS part,
				${refundedByOthersSql("json_extract(saved.value, '$.id')", "0")} AS refundCents
			FROM json_each(?1) AS saved
			WHERE EXISTS (SELECT 1 FROM transactions cash WHERE cash.id = ?2 AND cash.parent_id IS NULL AND cash.is_split = 1 AND cash.amount_cents = ?3)
				AND ${misfit}
			ORDER BY json_extract(saved.value, '$.position') LIMIT 1`,
		)
		.bind(savedJson, parentId, amountWasCents)
		.first<{ part: number; refundCents: number }>();
	if (refused)
		return {
			saved: false,
			refundPart: { part: refused.part, refundCents: refused.refundCents },
		};
	throw new Error(`Split ${parentId} changed while it was being corrected`);
}

/**
 * Deletes a split and restores its parent atomically, unlinking refunds of its parts and unlinking the bill
 * payments of its parts with no dismissal left, so the matcher may link them to the purchase again (decisions
 * 99 and 105). A person's own Not this one on a part is kept on the purchase. Returns the refunds' dates and
 * the bills still unpaid after it, by name (decision 105). A split refund's parent is whole again and counts by
 * its own link, so that link is checked like a new one (src/db/refunded.ts) and dropped if the refund no longer
 * fits; its date is returned too.
 */
export async function removeSplit(
	db: D1Database,
	parentId: number,
	by: string,
): Promise<{ unlinked: string[]; bills: UnpaidBill[] }> {
	const unlinked = (await linkedRefunds(db, parentId, false)).map(
		(refund) => refund.date,
	);
	const bills = await partBills(db, parentId);
	const parent = await db
		.prepare("SELECT date FROM transactions WHERE id = ?")
		.bind(parentId)
		.first<{ date: string }>();
	const unlinkRefund = db
		.prepare(unlinkSplitOverRefundedSql("?1"))
		.bind(parentId);
	const stillUnpaid = stillUnpaidStatement(db, bills);
	const statements = [
		db
			.prepare(
				"UPDATE transactions SET refund_of_id=NULL WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=?)",
			)
			.bind(parentId),
		// A person's own Not this one on a part moves onto the purchase before the parts go (decision 105).
		db.prepare(movePartDismissalsSql("?1", "?1", "1")).bind(parentId),
		db.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(parentId),
		db
			.prepare(
				"UPDATE transactions SET is_split = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(by, parentId),
		unlinkRefund,
		stillUnpaid,
	];
	const results = await db.batch(statements);
	const refundUnlinked =
		(results[statements.indexOf(unlinkRefund)]?.meta.changes ?? 0) > 0;
	return {
		unlinked: parent && refundUnlinked ? [...unlinked, parent.date] : unlinked,
		bills: unpaidBillsFrom(results[statements.indexOf(stillUnpaid)]),
	};
}

/**
 * Applies merchant rules to uncategorized transactions and bill categories (spec §7: a merchant
 * rule replaces a bill category). A person's choice, or a Jev category, is never touched.
 * A rule whose category is archived is skipped, and works again once the category is restored.
 * A rule saved under the merchant key wins over one saved under the raw name (spec §6.1).
 */
export async function applyMerchantRules(db: D1Database): Promise<void> {
	const rule = `SELECT c.id FROM categories c
		WHERE c.archived = 0 AND c.id = ${merchantColumnSql("transactions", "default_category_id")}`;
	await db
		.prepare(
			`UPDATE transactions SET
				category_id = (${rule}),
				category_source = 'merchant_rule', category_confidence = NULL, updated_at = datetime('now')
			WHERE is_split = 0 AND (category_id IS NULL AND category_source IS NULL OR category_source = 'bill')
				AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL) AND EXISTS (${rule})`,
		)
		.run();
}

// A credit a person already decided about: Jev can only help with its category. The review columns
// are NULL on older rows, which SQL won't compare, so a missing review counts as no review: COALESCE
// makes this 0 rather than NULL, and `NOT` of it can't drop the row.
// A payment that pays a bill though it is excluded counts (spec §8.5) but is a transfer, a card payment or
// something a person left out: Jev may suggest its category, and its flags are never written, since they
// could only change what it is excluded as or take it out of Spent (income).
const CATEGORY_ONLY = `(COALESCE(t.amount_cents < 0 AND t.credit_reviewed = 1 AND (t.income_source = 'user' OR t.credit_reviewed_by = 'user'), 0)
	OR (t.excluded = 1 AND ${paysBillSql("t")}))`;

/**
 * Transactions to ask Jev about, newest first: uncategorized counted transactions and all
 * unreviewed negative credits, even when a category was selected already. A user-reviewed
 * uncategorized credit is eligible for category help only, so it's left out when the household's
 * categories switch is off (spec §8.6): that answer would go unused. An excluded payment that pays a
 * bill counts, so it is asked about too, and likewise for its category only. A stored confidence means Jev
 * already looked and wasn't sure (decision 27).
 *
 * `categoryAsked` is false when no category is active. Then a category question isn't asked, so its category
 * confidence is never stored. A credit is asked for its income answer while the income switch is on, and not a credit a person reviewed for its
 * category alone, which would also have no category question to answer. An outgoing purchase (more than zero) is
 * asked once for its transfer and reimbursement flags, while the categories switch is on, and its answer marks it
 * asked: a low one is stored as its `transfer_confidence`, and a confident one sets the flag and excludes it, so it
 * leaves the queue. A purchase a person put back into the budget (`excluded_source = 'user'`) is not asked. Credits
 * come first, so newest purchases can't crowd out older credits. Once a category is active, a row is pending again for
 * its category question.
 *
 * With `ids`, only those rows are considered: the ones a sync just brought in, or the one a person
 * just added a note to. They go in as one JSON array read by `json_each`, since D1 allows 100 bound
 * values in a statement and a bank's first sync brings in thousands.
 */
export async function pendingForJev(
	db: D1Database,
	limit: number,
	{
		categories = true,
		income = true,
		details = false,
		categoryAsked = true,
		ids,
	}: {
		categories?: boolean;
		income?: boolean;
		details?: boolean;
		categoryAsked?: boolean;
		ids?: number[];
	} = {},
): Promise<
	(JevInput & {
		id: number;
		categoryOnly: boolean;
		merchantKey: string;
		detailsAsked: boolean;
		/** The transaction's source before this run, so the log counts only what Tally applies now (spec §8.6). */
		categorySource: string | null;
		incomeSource: string | null;
	})[]
> {
	const { results } = await db
		.prepare(
			`SELECT t.id, ${merchantKeySql("t")} AS merchantKey, t.raw_name AS rawName, COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")}) AS displayName,
				${merchantColumnSql("t", "suggested_name")} AS suggestedNames, ${merchantColumnSql("t", "suggestion_status")} AS suggestionStatus,
				t.amount_cents AS amountCents, a.type AS accountType,
				t.plaid_category AS plaidCategory, t.note, t.kind, hp.name AS forPerson,
				t.details_asked AS detailsAsked,
				t.category_source AS categorySource, t.income_source AS incomeSource,
				${CATEGORY_ONLY} AS categoryOnly
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN household_people hp ON hp.id = t.for_person_id
			${COUNTED_JOINS}
			WHERE NOT ${FOLLOWS_PURCHASE} AND (
				(? = 1 AND ${NEEDS_JEV_CLASSIFICATION} AND t.category_confidence IS NULL AND (? = 1 OR (NOT ${CATEGORY_ONLY} AND ((? = 1 AND t.amount_cents < 0 AND t.income_confidence IS NULL) OR (? = 1 AND t.amount_cents > 0 AND t.transfer_confidence IS NULL AND COALESCE(t.excluded_source, '') != 'user')))))
				OR (? = 1 AND ${INCLUDED} AND t.flag_income = 0 AND t.details_asked = 0 AND (${EMPTY_NOTE} OR t.kind IS NULL OR t.for_person_id IS NULL))
			)
				AND (? = 1 OR NOT ${CATEGORY_ONLY})
				${ids ? "AND t.id IN (SELECT value FROM json_each(?))" : ""}
			-- Never-failed first, then longest-ago failures, so a failing one can't block the rest. With no active
			-- category, credits come before purchases, so the newest purchases can't crowd out older credits.
			ORDER BY t.jev_failed_at IS NOT NULL, t.jev_failed_at,
				CASE WHEN ? = 0 THEN t.amount_cents > 0 ELSE 0 END, t.date DESC, t.id DESC
			LIMIT ?`,
		)
		.bind(
			categories || income ? 1 : 0,
			categoryAsked ? 1 : 0,
			income ? 1 : 0,
			categories ? 1 : 0,
			details ? 1 : 0,
			categories || details ? 1 : 0,
			...(ids ? [JSON.stringify(ids)] : []),
			categoryAsked ? 1 : 0,
			limit,
		)
		.all<
			JevInput & {
				id: number;
				categoryOnly: number;
				merchantKey: string;
				detailsAsked: number;
				categorySource: string | null;
				incomeSource: string | null;
				suggestedNames: string | null;
				suggestionStatus: string | null;
			}
		>();
	return results.map(
		({ suggestedNames, suggestionStatus, ...transaction }) => ({
			...transaction,
			// With no name chosen, Jev is told the bank's own store name, never a name Tally guessed (decision 103).
			displayName:
				transaction.displayName ??
				usableSuggestedNames({
					stored: suggestedNames,
					status: suggestionStatus,
					key: transaction.merchantKey,
					namesOn: false,
				})[0] ??
				null,
			categoryOnly: transaction.categoryOnly === 1,
			detailsAsked: transaction.detailsAsked === 1,
		}),
	);
}

/** The recent categories chosen by a person or merchant rule, fetched once for a Jev page. */
export async function merchantCategoryHistoryForJev(
	db: D1Database,
	transactions: { id: number; merchantKey: string; rawName?: string }[],
): Promise<Map<string, string[][]>> {
	const requested = [
		...new Map(
			transactions.map((transaction) => [
				`${transaction.merchantKey}\0${transaction.rawName ?? ""}`,
				{
					merchantKey: transaction.merchantKey,
					rawName: transaction.rawName ?? null,
				},
			]),
		).values(),
	];
	if (requested.length === 0) return new Map();
	const { results } = await db
		.prepare(
			// Match requested merchant keys through the merchant-history index before ranking trips.
			`WITH requested AS (
				SELECT json_extract(value, '$.merchantKey') AS merchant_key,
					json_extract(value, '$.rawName') AS raw_name FROM json_each(?)),
			matched_transactions AS (
				SELECT r.merchant_key, t.id, t.date, t.raw_name, t.parent_id, t.is_split,
					t.category_id, t.category_source, t.pending, t.excluded
				FROM requested r JOIN transactions t INDEXED BY transactions_merchant_history
					ON r.merchant_key = ${merchantKeySql("t")}
				UNION ALL
				SELECT r.merchant_key, t.id, t.date, t.raw_name, t.parent_id, t.is_split,
					t.category_id, t.category_source, t.pending, t.excluded
				FROM requested r JOIN transactions t INDEXED BY transactions_raw_name
					ON t.raw_name = r.raw_name AND NULLIF(t.merchant_name, '') IS NULL
				WHERE r.raw_name IS NOT NULL AND r.raw_name != r.merchant_key),
			 asked AS (SELECT value AS transaction_id FROM json_each(?)),
			 category_rows AS (
				SELECT t.merchant_key AS merchant_key, t.id AS trip_id, t.date AS trip_date,
					t.id AS trip_order_id, c.name AS category_name, t.id AS category_order_id
				FROM matched_transactions t
				JOIN categories c ON c.id = t.category_id
				WHERE t.parent_id IS NULL
					AND t.id NOT IN (SELECT CAST(transaction_id AS INTEGER) FROM asked)
					AND c.archived = 0
					AND t.category_source IN ('user', 'merchant_rule')
					AND t.is_split = 0 AND ${INCLUDED} AND t.pending = 0
				UNION ALL
				SELECT p.merchant_key AS merchant_key, p.id AS trip_id, p.date AS trip_date,
					p.id AS trip_order_id, c.name AS category_name, t.id AS category_order_id
				FROM matched_transactions p
				JOIN transactions t ON t.parent_id = p.id AND t.is_split = 0
				JOIN categories c ON c.id = t.category_id
				WHERE p.is_split = 1 AND p.id NOT IN (SELECT CAST(transaction_id AS INTEGER) FROM asked)
					AND t.id NOT IN (SELECT CAST(transaction_id AS INTEGER) FROM asked)
					AND c.archived = 0
					AND t.category_source IN ('user', 'merchant_rule')
					AND ${INCLUDED} AND t.pending = 0 AND ${includedSql("p")} AND p.pending = 0
			),
			 category_deduped AS (
				SELECT merchant_key, trip_id, trip_date, trip_order_id, category_name, category_order_id,
					ROW_NUMBER() OVER (
						PARTITION BY merchant_key, trip_id, category_name ORDER BY category_order_id
					) AS category_position
				FROM category_rows
			),
			usable_trips AS (
				SELECT DISTINCT merchant_key, trip_id, trip_date, trip_order_id
				FROM category_deduped WHERE category_position = 1
			),
			ranked_trips AS (
				SELECT merchant_key, trip_id,
					ROW_NUMBER() OVER (PARTITION BY merchant_key ORDER BY trip_date DESC, trip_order_id DESC) AS position
				FROM usable_trips
			)
			SELECT d.merchant_key, r.position, d.category_name
			FROM category_deduped d JOIN ranked_trips r ON r.merchant_key = d.merchant_key AND r.trip_id = d.trip_id
			WHERE d.category_position = 1 AND r.position <= 5
			ORDER BY d.merchant_key, r.position, d.category_order_id`,
		)
		.bind(
			JSON.stringify(requested),
			JSON.stringify(transactions.map((transaction) => transaction.id)),
		)
		.all<{ merchant_key: string; position: number; category_name: string }>();
	const history = new Map<string, string[][]>();
	let lastMerchantKey: string | undefined;
	let lastPosition = 0;
	for (const row of results) {
		const trips = history.get(row.merchant_key) ?? [];
		if (row.merchant_key !== lastMerchantKey || row.position !== lastPosition) {
			trips.push([]);
			lastMerchantKey = row.merchant_key;
			lastPosition = row.position;
		}
		trips[trips.length - 1]?.push(row.category_name);
		history.set(row.merchant_key, trips);
	}
	return history;
}

/** Records that Jev failed on this one transaction, so the next run asks about it last (decision 31). */
export async function markJevFailed(db: D1Database, id: number): Promise<void> {
	await db
		.prepare(
			"UPDATE transactions SET jev_failed_at = datetime('now') WHERE id = ?",
		)
		.bind(id)
		.run();
}

/**
 * Stores only Jev's valid detail choices, and records that this transaction was asked once. A Kind or For a
 * person cleared (`kind_cleared`, `for_person_cleared`) is a deliberate empty choice, so Jev doesn't fill it (#304).
 * Jev's what-it-was answer (`note_worth_writing`, decision 103) is written with that first ask, and never again.
 */
export async function saveJevDetails(
	db: D1Database,
	details: {
		id: number;
		kind: string | null;
		forPersonId: number | null;
		noteWorthWriting: number | null;
	}[],
): Promise<void> {
	if (details.length === 0) return;
	const result = await db
		.prepare(
			`WITH answers AS (
				SELECT json_extract(value, '$.id') AS id,
					json_extract(value, '$.kind') AS kind,
					json_extract(value, '$.forPersonId') AS forPersonId,
					json_extract(value, '$.noteWorthWriting') AS noteWorthWriting
				FROM json_each(?)
			)
			UPDATE transactions SET
				kind = CASE WHEN kind IS NULL AND kind_cleared = 0 THEN (SELECT kind FROM answers WHERE answers.id = transactions.id) ELSE kind END,
				kind_guessed = CASE WHEN kind IS NULL AND kind_cleared = 0 AND (SELECT kind FROM answers WHERE answers.id = transactions.id) IS NOT NULL THEN 1 ELSE kind_guessed END,
				for_person_id = CASE WHEN for_person_id IS NULL AND for_person_cleared = 0 AND EXISTS (SELECT 1 FROM household_people WHERE id = (SELECT forPersonId FROM answers WHERE answers.id = transactions.id)) THEN (SELECT forPersonId FROM answers WHERE answers.id = transactions.id) ELSE for_person_id END,
				for_person_guessed = CASE WHEN for_person_id IS NULL AND for_person_cleared = 0 AND EXISTS (SELECT 1 FROM household_people WHERE id = (SELECT forPersonId FROM answers WHERE answers.id = transactions.id)) THEN 1 ELSE for_person_guessed END,
				note_worth_writing = (SELECT noteWorthWriting FROM answers WHERE answers.id = transactions.id),
				details_asked = 1, updated_at = datetime('now')
			WHERE details_asked = 0 AND id IN (SELECT id FROM answers)`,
		)
		.bind(JSON.stringify(details))
		.run();
	void result;
}

/** The columns a note is checked against, read the way the list reads a row's name (#426, #412). */
const NOTE_NAME_COLUMNS = `t.raw_name AS rawName, t.merchant_name AS merchantName,
	${merchantColumnSql("t", "display_name")} AS displayName, ${ownNameSql("t")} AS ownName, ${NAME_SUGGESTION_COLUMNS}`;

export type NoteNameRow = {
	id: number;
	rawName: string;
	merchantName: string | null;
	displayName: string | null;
	ownName: string | null;
	suggestedNames: string | null;
	suggestionStatus: string | null;
	merchantKey: string;
};

/**
 * The bounded set of note guesses for this run. Only a transaction Jev said a what-it-was line could help with
 * (`note_worth_writing = 1`, decision 103) is sent to Workers AI, so a no, an unanswered one and every one from
 * before that answer existed are never sent. Each row carries the names a guess is checked against: the bank
 * text, Plaid's merchant name, the names the row can show, and its own name (`ownName`, #426). Only the bank
 * text is sent. A row with `note_tried_at` set is left out: Workers AI answered it, even with no note, or a
 * person saved its note empty. A row whose call failed (`note_failed_at`) stays in, but after the rows that
 * never failed.
 */
export async function transactionsNeedingNoteGuess(
	db: D1Database,
	limit: number,
): Promise<NoteNameRow[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, ${NOTE_NAME_COLUMNS}
			 FROM transactions t
			 WHERE t.details_asked = 1 AND t.note_worth_writing = 1 AND t.note_dismissed = 0 AND t.note_tried_at IS NULL AND ${EMPTY_NOTE}
			 -- Never-failed first, then longest-ago failures, so a failing one can't block the rest.
			 ORDER BY t.note_failed_at IS NOT NULL, t.note_failed_at, t.date DESC, t.id DESC LIMIT ?`,
		)
		.bind(limit)
		.all<NoteNameRow>();
	return results;
}

/**
 * The same name columns as `transactionsNeedingNoteGuess`, for these charges as they stand now. A person may name
 * a charge or its merchant while a note's call is out, so a note is checked against these, read just before it is
 * saved (#412). One query for any number of ids.
 */
export async function noteNameRows(
	db: D1Database,
	ids: number[],
): Promise<NoteNameRow[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, ${NOTE_NAME_COLUMNS}
			 FROM transactions t
			 WHERE t.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.all<NoteNameRow>();
	return results;
}

/**
 * Stores successful note guesses, and marks each call Workers AI answered as tried, even when its answer
 * was empty, so it isn't asked again. A failed call is stamped in `note_failed_at` and stays untried, so it is
 * asked again, after the untried notes (`transactionsNeedingNoteGuess`). One JSON parameter for each stays below
 * D1's bind limit, and the whole save is one statement.
 */
export async function saveNoteAttempts(
	db: D1Database,
	attempted: number[],
	notes: { id: number; note: string }[],
	failed: number[],
): Promise<void> {
	if (attempted.length === 0 && failed.length === 0) return;
	await db
		.prepare(
			`WITH attempted AS (SELECT value AS id FROM json_each(?)),
				failed AS (SELECT value AS id FROM json_each(?)),
				guesses AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.note') AS note FROM json_each(?))
			UPDATE transactions AS t SET
				note = CASE WHEN t.note_dismissed = 0 AND t.details_asked = 1 AND ${EMPTY_NOTE} AND EXISTS (SELECT 1 FROM guesses WHERE guesses.id = t.id) THEN (SELECT note FROM guesses WHERE guesses.id = t.id) ELSE note END,
				note_guessed = CASE WHEN t.note_dismissed = 0 AND t.details_asked = 1 AND ${EMPTY_NOTE} AND EXISTS (SELECT 1 FROM guesses WHERE guesses.id = t.id) THEN 1 ELSE note_guessed END,
				note_tried_at = CASE WHEN t.id IN (SELECT id FROM attempted) THEN datetime('now') ELSE note_tried_at END,
				note_failed_at = CASE WHEN t.id IN (SELECT id FROM failed) THEN datetime('now') ELSE note_failed_at END,
				updated_at = CASE WHEN t.id IN (SELECT id FROM attempted) THEN datetime('now') ELSE updated_at END
			WHERE t.id IN (SELECT id FROM attempted) OR t.id IN (SELECT id FROM failed)`,
		)
		.bind(
			JSON.stringify(attempted),
			JSON.stringify(failed),
			JSON.stringify(notes),
		)
		.run();
}

/**
 * Saves one Jev answer and, when it applies a category or income Tally should count, its What AI did row, in
 * one D1 batch (spec §8.6), so the two land together or not at all. Returns whether the answer was written.
 */
async function saveJevAnswer(
	db: D1Database,
	update: D1PreparedStatement,
	id: number,
	log: { day: string; category: boolean; income: boolean } | undefined,
): Promise<boolean> {
	if (!log || (!log.category && !log.income))
		return (await update.run()).meta.changes > 0;
	const [saved] = await db.batch([
		update,
		db
			.prepare(JEV_ANSWER_LOG_SQL)
			.bind(log.day, id, log.category ? 1 : 0, log.income ? 1 : 0),
	]);
	return (saved?.meta.changes ?? 0) > 0;
}

/**
 * Stores what code decided from Jev's answer. It only writes to a transaction that is still
 * uncategorized with no source, so a person's choice made in the meantime always wins.
 * A transfer or reimbursement flag also excludes the transaction (spec §6), which a person can undo
 * with the edit panel's exclude toggle (#27); it never overrides a person's exclusion or income choice, and it never
 * clears or takes over an income flag Plaid set at sync (decision 67; the flag keeps `income_source` null). It writes
 * only while every switch the answer was asked under is still on, so a late answer is thrown away and the transaction
 * waits for the next run. Returns whether it wrote the row.
 */
export async function saveJevResult(
	db: D1Database,
	id: number,
	d: Decision,
	options: {
		categoryOnly?: boolean;
		categoryAsked?: boolean;
		switches?: { income: boolean; categories?: boolean };
		/** What this answer applies, for its What AI did row (spec §8.6); `day` is the household's day when the answer is saved. */
		log?: { day: string; category: boolean; income: boolean };
	} = {},
): Promise<boolean> {
	const stillOn = stillOnKeys({
		categories: options.switches?.categories,
		income: options.switches?.income,
	});
	if (options.categoryOnly) {
		// A person already decided what this credit means. Jev may help with its category only.
		// It never writes income, so its log row carries no income.
		const category = db
			.prepare(
				`UPDATE transactions SET
					category_id = ?, category_source = ?, category_confidence = ?, jev_category_id = ?, jev_none_fit = ?,
					updated_at = datetime('now')
				 WHERE id = ? AND flag_income = 0
					AND ((amount_cents < 0 AND credit_reviewed = 1 AND (income_source = 'user' OR credit_reviewed_by = 'user'))
						OR (excluded = 1 AND ${PAYS_A_BILL}))
					AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
					AND ${INCLUDED_ROW} AND is_split = 0 AND ${STILL_ON_SQL}`,
			)
			.bind(
				options.categoryAsked === false ? null : d.categoryId,
				options.categoryAsked === false || d.categoryId === null ? null : "jev",
				options.categoryAsked === false ? null : d.confidence,
				options.categoryAsked === false ? null : d.suggestedCategoryId,
				options.categoryAsked === false || !d.noneFit ? 0 : 1,
				id,
				stillOn,
			);
		return saveJevAnswer(
			db,
			category,
			id,
			options.log && { ...options.log, income: false },
		);
	}
	// A transfer or reimbursement flag excludes the transaction, unless a person decided otherwise. A payment
	// that pays a bill counts all the same (it is read as counted, spec §8.5), so it needs no exception here.
	// One that is excluded and pays a bill only gets a category (`categoryOnly` above), never these flags.
	const excludes = d.flags.transfer || d.flags.reimbursement ? 1 : 0;
	const income = options.switches?.income === false ? false : d.flags.income;
	const incomeOn = options.switches?.income !== false;
	const incomeConfidence = incomeOn
		? (d.flagConfidence?.income ?? (income ? 1 : null))
		: null;
	// The Maybe range's edges (src/ai/maybe.ts), so this save and the review queue read the same bounds.
	const { above, below } = unsureBounds();
	const update = db
		.prepare(
			`UPDATE transactions SET
				category_id = CASE WHEN category_id IS NULL AND category_source IS NULL THEN ? ELSE category_id END,
				category_source = CASE WHEN category_id IS NULL AND category_source IS NULL THEN ? ELSE category_source END,
			category_confidence = ?,
			income_confidence = CASE WHEN ${plaidSetIncomeSql("transactions")} OR income_source IN ('user', 'jev') OR credit_reviewed_by = 'user' THEN NULL WHEN ? = 1 AND amount_cents <= 0 AND ? < ? THEN ? ELSE NULL END,
			transfer_confidence = CASE WHEN excluded_source = 'user' THEN transfer_confidence WHEN ? = 1 AND ? < ? THEN ? ELSE NULL END,
			-- A credit counts only after a confident category (non-income classification) or an income decision.
			credit_reviewed = CASE WHEN amount_cents < 0 AND COALESCE(credit_reviewed, 0) = 0 AND credit_reviewed_by IS NULL AND ((? = 1 AND ? >= ? AND (? IS NULL OR ? <= ?)) OR ? = 1) THEN 1 ELSE credit_reviewed END,
				jev_category_id = ?, jev_none_fit = ?,
				flag_transfer = CASE WHEN excluded_source = 'user' THEN flag_transfer ELSE MAX(flag_transfer, ?) END, flag_reimbursement = CASE WHEN excluded_source = 'user' THEN flag_reimbursement ELSE MAX(flag_reimbursement, ?) END,
				-- Income is money coming in: Jev's income answer never marks money out (a positive amount).
				flag_income = CASE WHEN income_source = 'user' OR credit_reviewed_by = 'user' OR (income_source IS NULL AND flag_income = 1) THEN flag_income WHEN amount_cents > 0 THEN 0 ELSE ? END,
				income_source = CASE WHEN credit_reviewed_by = 'user' AND income_source IS NULL THEN 'user' WHEN ${plaidSetIncomeSql("transactions")} THEN NULL WHEN income_source = 'user' OR (income_source IS NULL AND flag_income = 1) THEN COALESCE(income_source, 'user') WHEN ? = 1 AND amount_cents <= 0 THEN 'jev' ELSE NULL END,
				excluded = CASE WHEN excluded_source = 'user' THEN excluded ELSE MAX(excluded, ?) END,
				excluded_source = CASE WHEN excluded_source = 'user' OR ? = 0 THEN excluded_source ELSE 'jev' END,
				updated_at = datetime('now')
			WHERE id = ? AND category_confidence IS NULL
				AND excluded = 0 AND is_split = 0
				AND COALESCE(income_source, '') != 'user' AND COALESCE(credit_reviewed_by, '') != 'user'
				AND (
					(category_id IS NULL AND category_source IS NULL)
					OR (amount_cents < 0 AND COALESCE(credit_reviewed, 0) = 0
						AND credit_reviewed_by IS NULL AND COALESCE(income_source, '') != 'user')
				)
				AND ${STILL_ON_SQL}`,
		)
		.bind(
			options.categoryAsked === false ? null : d.categoryId,
			options.categoryAsked === false || d.categoryId === null ? null : "jev",
			options.categoryAsked === false ? null : d.confidence,
			incomeOn ? 1 : 0,
			confidenceBasisPoints(incomeConfidence ?? 0),
			below,
			incomeConfidence ?? 0,
			options.switches?.categories === false ? 0 : 1,
			confidenceBasisPoints(
				d.flagConfidence?.transfer ?? (d.flags.transfer ? 1 : 0),
			),
			below,
			d.flagConfidence?.transfer ?? (d.flags.transfer ? 1 : 0),
			d.categoryId !== null ? 1 : 0,
			confidenceBasisPoints(d.confidence),
			below,
			incomeConfidence,
			confidenceBasisPoints(incomeConfidence ?? 0),
			above,
			income ? 1 : 0,
			options.categoryAsked === false ? null : d.suggestedCategoryId,
			options.categoryAsked === false || !d.noneFit ? 0 : 1,
			d.flags.transfer ? 1 : 0,
			d.flags.reimbursement ? 1 : 0,
			income ? 1 : 0,
			income ? 1 : 0,

			excludes,
			excludes,
			id,
			stillOn,
		);
	return saveJevAnswer(db, update, id, options.log);
}

/** How many of these transactions pay a bill, on their own link or their split parent's (`paysBillSql`). */
export async function payingBillsCount(
	db: D1Database,
	ids: number[],
): Promise<number> {
	if (ids.length === 0) return 0;
	// One bind for the whole list (D1 takes 100 binds at most), so Select all can count past 100 (#321).
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM transactions t WHERE t.id IN (SELECT value FROM json_each(?)) AND ${paysBillSql("t")}`,
		)
		.bind(JSON.stringify(ids))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * This month's excluded transactions by why (How Tally works, spec §9): a person's choice when a
 * person excluded it (even if it's also flagged) or it has no flag; otherwise its flag, transfer
 * first. One Plaid excluded as a transfer or card payment counts as a transfer. A payment linked to a
 * bill counts, so it isn't listed here (spec §8.5). It counts the rows Show Excluded lists for the
 * month (split parents aside, in the month the list puts them), so the two always agree.
 */
export async function excludedBreakdown(
	db: D1Database,
	month: string,
): Promise<ExcludedBreakdown> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(NOT person AND moved), 0) AS transfer,
				COALESCE(SUM(NOT person AND NOT moved AND reimbursement), 0) AS reimbursement,
				COALESCE(SUM(person OR (NOT moved AND NOT reimbursement)), 0) AS byPerson
			FROM (SELECT COALESCE(t.excluded_source = 'user', 0) AS person,
					${markedTransferSql("t")} AS moved,
					t.flag_reimbursement = 1 AS reimbursement
				FROM transactions t
				${COUNTED_JOINS}
				WHERE ${COUNTED_MONTH} = ? AND ${SHOW_SQL.excluded})`,
		)
		.bind(month)
		.first<ExcludedBreakdown>();
	return row ?? { transfer: 0, reimbursement: 0, byPerson: 0 };
}

// Who categorized a transaction, read from where its category comes from: a linked refund's purchase.
const countedBy = (column: string) =>
	`CASE WHEN ${FOLLOWS_PURCHASE} THEN rp.${column} ELSE t.${column} END`;
const COUNTED_BY = {
	source: countedBy("category_source"),
	confidence: countedBy("category_confidence"),
	jev: countedBy("jev_category_id"),
};

/**
 * This month's numbers for the How Tally works page (spec §9): counted transactions, how many
 * need a category (the same set Home counts), and who categorized the rest. A linked refund goes
 * with its purchase: categorized the same way, or waiting with it (linkedWaiting).
 */
/** How many transactions the bank dated in a month, wherever they count (a refund or late payment can count earlier). */
export async function bankDatedCount(
	db: D1Database,
	month: string,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE substr(date, 1, 7) = ?",
		)
		.bind(month)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function monthCounts(
	db: D1Database,
	month: string,
): Promise<{
	counted: number;
	needsCategory: number;
	user: number;
	merchantRule: number;
	bill: number;
	jev: number;
	unsure: number;
	noneFit: number;
	notYetAsked: number;
	/** Income with no category: it needs none, so it isn't waiting. */
	income: number;
	/** Negative credits that still need a person to review them. */
	heldForReview: number;
	/** Linked refunds waiting with a purchase that has no category; the purchase is the one to categorize. */
	linkedWaiting: number;
}> {
	const row = await db
		.prepare(
			`SELECT COALESCE(SUM(t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE}), 0) AS counted,
				COALESCE(SUM(CASE WHEN ${NEEDS_CATEGORY} THEN 1 ELSE 0 END), 0) AS needsCategory,
				COALESCE(SUM((t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE}) AND ${COUNTED_BY.source} = 'user'), 0) AS user,
				COALESCE(SUM((t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE}) AND ${COUNTED_BY.source} = 'merchant_rule'), 0) AS merchantRule,
				COALESCE(SUM((t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE}) AND ${COUNTED_BY.source} = 'bill'), 0) AS bill,
				COALESCE(SUM((t.amount_cents >= 0 OR t.credit_reviewed = 1 OR t.flag_income = 1 OR ${FOLLOWS_PURCHASE}) AND ${COUNTED_BY.source} = 'jev'), 0) AS jev,
				COALESCE(SUM(${NEEDS_CATEGORY} AND ${COUNTED_BY.source} IS NULL AND ${COUNTED_BY.confidence} IS NOT NULL AND ${COUNTED_BY.jev} IS NOT NULL), 0) AS unsure,
				COALESCE(SUM(${NEEDS_CATEGORY} AND ${COUNTED_BY.source} IS NULL AND ${COUNTED_BY.confidence} IS NOT NULL AND ${COUNTED_BY.jev} IS NULL), 0) AS noneFit,
				COALESCE(SUM(${NEEDS_CATEGORY} AND ${COUNTED_BY.source} IS NULL AND ${COUNTED_BY.confidence} IS NULL), 0) AS notYetAsked,
				COALESCE(SUM(t.category_id IS NULL AND t.flag_income = 1), 0) AS income,
				COALESCE(SUM(t.amount_cents < 0 AND COALESCE(t.credit_reviewed, 0) = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE}), 0) AS heldForReview,
				COALESCE(SUM(${FOLLOWS_PURCHASE} AND ${COUNTED_CATEGORY} IS NULL AND t.flag_income = 0), 0) AS linkedWaiting
			FROM transactions t
			${COUNTED_JOINS}
			WHERE ${COUNTED_MONTH} = ? AND ${INCLUDED} AND t.is_split = 0`,
		)
		.bind(month)
		.first<{
			counted: number;
			needsCategory: number;
			user: number;
			merchantRule: number;
			bill: number;
			jev: number;
			unsure: number;
			noneFit: number;
			notYetAsked: number;
			income: number;
			heldForReview: number;
			linkedWaiting: number;
		}>();
	return (
		row ?? {
			counted: 0,
			needsCategory: 0,
			user: 0,
			merchantRule: 0,
			bill: 0,
			jev: 0,
			unsure: 0,
			noneFit: 0,
			notYetAsked: 0,
			income: 0,
			heldForReview: 0,
			linkedWaiting: 0,
		}
	);
}
