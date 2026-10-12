import { JEV_THRESHOLD, type JevInput } from "../ai/categorize";
import { confidenceBasisPoints } from "../ai/confidence";
import type { Decision } from "../ai/decide";
import { STILL_UNPAID_BILLS_SQL, type UnpaidBill } from "../bills/unpaid";
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
import type { SplitPart } from "../transactions/split";
import { tidyName } from "../transactions/tidy-name";
import { readAiSwitches } from "./ai-switches";
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
	markedTransferSql,
	PAYS_A_BILL,
	paysBillSql,
} from "./counted-month";
import { hasIncomeAnswerSql, plaidSetIncomeSql } from "./income";
import {
	merchantColumnSql,
	merchantKeySql,
	sameMerchantSql,
} from "./merchant-key";
import { SETTLE_SUGGESTION_SQL } from "./merchant-names";
import { CLEAR_MERCHANT_RULE_SQL } from "./merchant-rules";
import {
	refundedByOthersSql,
	refundFitsSql,
	refundLeftCents,
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
	LEFT JOIN category_suggestions cs ON cs.id = t.category_suggestion_id AND cs.status = 'pending'`;
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
	const where: string[] = [];
	const args: (string | number)[] = [];
	const {
		names: namesOn,
		details: detailsOn,
		income: incomeOn,
	} = await readAiSwitches(db);
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
			// row says can be searched for.
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
					`(COALESCE(${merchantColumnSql("t", "display_name")}, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(t.raw_name, '*', ' '), '  ', ' '), '  ', ' ') LIKE ? ESCAPE '\\' OR COALESCE(${visibleNoteSql(detailsOn)}, '') LIKE ? ESCAPE '\\' OR ${suggestedNameMatch(namesOn)} OR c.name LIKE ? ESCAPE '\\')`,
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

	// The row shows the category it counts in, so a linked refund shows its purchase's.
	const from = `FROM transactions t
			${COUNTED_JOINS}
			LEFT JOIN categories c ON c.id = ${COUNTED_CATEGORY}
			${MAYBE_CATEGORY_JOINS}
			LEFT JOIN transactions p ON p.id = t.parent_id
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
				${merchantColumnSql("t", "display_name")} AS merchantName, ${NAME_SUGGESTION_COLUMNS}, ${f.raw ? "NULL" : visibleNoteSql(detailsOn)} AS note, ${f.raw ? "0" : `CASE WHEN t.note_guessed = 1 AND ${detailsOn ? "1" : "0"} = 1 THEN 1 ELSE 0 END`} AS noteGuessed, t.parent_id AS parentId,
				t.is_split AS isSplit, ${merchantColumnSql("p", "display_name")} AS parentMerchantName, ${merchantColumnSql("p", "suggested_name")} AS parentSuggestedNames, ${merchantColumnSql("p", "suggestion_status")} AS parentSuggestionStatus, ${merchantKeySql("p")} AS parentMerchantKey, p.raw_name AS parentRawName,
				t.split_removed_from_cents AS splitRemovedFromCents, ${STILL_UNPAID_BILLS_SQL("t.split_removed_bills")} AS splitRemovedBills,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, t.refund_unlinked_purchase_date AS refundUnlinkedPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				${REFUNDED_COLUMN},
				t.excluded, ${paysBillSql("t")} AS paysBill,
				${BILL_NAME_COLUMN},
				(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=p.id AND bp.status='linked' LIMIT 1) AS parentBillName,
				${PENDING_SQL} AS pending, t.flag_income AS income, t.credit_reviewed AS creditReviewed, CASE WHEN ${hasIncomeAnswerSql("t")} OR t.income_maybe_declined = 1 THEN NULL ELSE t.income_confidence END AS incomeConfidence,
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
					parentMerchantName: string | null;
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
			parentMerchantName,
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
	categorySource: "user" | "merchant_rule" | "bill" | "jev" | null;
	merchantRuleCategoryId: number | null;
	/** Jev's confidence when Jev picked (or looked at) the category; null otherwise. */
	categoryConfidence: number | null;
	suggestedCategoryId: number | null;
	suggestedCategoryName: string | null;
	/**
	 * The names the panel offers while the merchant's suggestions wait (P29 A): the suggested names
	 * (up to three), the bank's text as the list shows it without a choice, and how many transactions
	 * a name applies to. Null when there is nothing to choose.
	 */
	nameChoices?: {
		names: string[];
		/** Where the names came from: the bank sent them, or Tally guessed (P87 B). */
		source: NameSource;
		tidied: string;
		count: number;
	} | null;
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
				${merchantColumnSql("t", "display_name")} AS merchantName, ${merchantColumnSql("t", "default_category_id")} AS merchantRuleCategoryId, ${NAME_SUGGESTION_COLUMNS}, t.note, t.parent_id AS parentId,
				t.note_guessed AS noteGuessed, t.kind, t.kind_guessed AS kindGuessed,
				t.for_person_id AS forPersonId, (SELECT name FROM household_people WHERE id = t.for_person_id) AS forPersonName, t.for_person_guessed AS forPersonGuessed,
				t.is_split AS isSplit, NULL AS parentName,
				t.split_removed_from_cents AS splitRemovedFromCents, ${STILL_UNPAID_BILLS_SQL("t.split_removed_bills")} AS splitRemovedBills,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, t.refund_unlinked_purchase_date AS refundUnlinkedPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				${REFUNDED_COLUMN},
				t.excluded, ${paysBillSql("t")} AS paysBill,
				${BILL_NAME_COLUMN},
				${PENDING_SQL} AS pending, t.flag_income AS income, CASE WHEN ${hasIncomeAnswerSql("t")} OR t.income_maybe_declined = 1 THEN NULL ELSE t.income_confidence END AS incomeConfidence, t.category_source AS categorySource, t.category_confidence AS categoryConfidence,
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
				| "isSplit"
				| "followsPurchase"
				| "pending"
			> &
				NameSuggestionColumns & {
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
	const { suggestedNames, suggestionStatus, merchantKey, ...row } = r;
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
		rawName: r.rawName,
	});
	const offered = r.merchantName ? [] : offeredNames(merchant, r.rawName);
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
		nameSuggested: shown.suggested,
		nameFromBank: shown.fromBank,
		nameChoices:
			offered.length > 0
				? {
						names: offered,
						source: nameSource(offered, merchantKey),
						tidied: tidyName(r.rawName),
						count: await merchantTransactionCount(db, merchantKey),
					}
				: null,
	};
}

/** How many transactions carry a merchant key, a split purchase counted once: what a name applies to. */
async function merchantTransactionCount(
	db: D1Database,
	key: string,
): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM transactions t WHERE t.parent_id IS NULL AND ${merchantKeySql("t")} = ?`,
		)
		.bind(key)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Sets `excluded`, recording a person as its source only when the value changes. */
const EXCLUDE =
	"excluded_source = CASE WHEN excluded = ? THEN excluded_source ELSE 'user' END, excluded = ?";

/**
 * Gives a merchant's rule category to every transaction a person hasn't chosen (§7), except a split
 * purchase and a purchase a bank change sent back to its earlier category (§6.1, decision 99). Binds
 * the category, the actor and the merchant key; callers add their own last condition.
 */
const APPLY_MERCHANT_RULE_SQL = `UPDATE transactions SET category_id = ?, category_source = 'merchant_rule', category_confidence = NULL,
	updated_by = ?, updated_at = datetime('now')
WHERE ${merchantKeySql("transactions")} = ? AND COALESCE(category_source, '') != 'user'
	AND is_split = 0 AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL)`;

/**
 * What saving the edit panel did. A refund link that is more than what's left of its purchase is
 * refused (spec §8.5) with nothing saved, and `refundLeftCents` is what the purchase has left. A cash
 * amount is refused when it breaks its parts (`amountCents` is the parts' total) or its linked
 * refunds (`refundCents` is their total, the smallest amount that would fit).
 */
export type SaveEditResult =
	| { saved: true }
	| { saved: false; refundLeftCents: number }
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
 * which makes it count against its purchase. The check is an UPDATE that changes nothing unless what moves with the refund fits what's
 * left of the purchase (src/db/refunded.ts), so two saves at once can't both fit; every other write
 * in the batch applies only once it has, so a refusal saves nothing, and an error anywhere rolls the
 * link back too. A person linking a refund includes it in the budget, even when it was excluded
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
			`SELECT ${merchantKeySql("transactions")} AS merchantKey, amount_cents AS amountCents, category_id AS categoryId, flag_income AS income, income_source AS incomeSource, credit_reviewed AS creditReviewed, credit_reviewed_by AS creditReviewedBy, excluded, refund_of_id AS refundOfId, is_split AS isSplit, note, note_guessed AS noteGuessed, kind, kind_guessed AS kindGuessed, for_person_id AS forPersonId, for_person_guessed AS forPersonGuessed FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<{
			merchantKey: string;
			amountCents: number;
			categoryId: number | null;
			income: number;
			incomeSource: string | null;
			creditReviewed: number | null;
			creditReviewedBy: string | null;
			excluded: number;
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

	// Every other write waits on that check, so a refusal writes nothing at all, and an error anywhere
	// in the batch rolls everything back, link included. For a link, once it has taken the refund's
	// `refund_of_id` is the new purchase, and when it was refused it is not. For a credit that
	// counts again, the same amount check is made by each write. The check's two parameters are
	// numbered from `n`, after the statement's own.
	const gate: { sql: (n: number) => string; args: unknown[] } = linking
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
	if (edit.cashAmountCents !== undefined) {
		const priorSql = gate.sql;
		const priorArgs = gate.args;
		gate.sql = (n) =>
			`${priorSql(n)} AND EXISTS (SELECT 1 FROM transactions cash WHERE cash.id = ?${n + priorArgs.length} AND cash.parent_id IS NULL AND cash.account_id IN (SELECT id FROM accounts WHERE type='cash') AND (cash.is_split = 0 OR (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions part WHERE part.parent_id = cash.id) = ?${n + priorArgs.length + 1}) AND COALESCE((SELECT SUM(ABS(refund.amount_cents)) FROM transactions refund WHERE refund.refund_of_id = cash.id AND refund.is_split = 0 AND refund.amount_cents < 0 AND refund.flag_income = 0), 0) <= ?${n + priorArgs.length + 1})`;
		gate.args = [...priorArgs, id, edit.cashAmountCents];
	}
	/** A statement with the gate on its WHERE (before `tail`), binding `args` and then the gate's. */
	const gated = (sql: string, args: unknown[], tail = "") =>
		db
			.prepare(`${sql}${gate.sql(args.length + 1)}${tail}`)
			.bind(...args, ...gate.args);

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
		// check that what moves fits what is left of the purchase.
		statements.push(
			db
				.prepare(
					`UPDATE transactions SET refund_of_id = ?1, refund_unlinked_purchase_date = NULL
					WHERE parent_id = ?2 AND refund_of_id IS (SELECT refund_of_id FROM transactions WHERE id = ?2)
						AND ${refundFitsSql("?2", "?1")}`,
				)
				.bind(newLink, id),
			// A person linking it makes it a reviewed refund that counts, as their choice. This is the
			// statement whose result says whether the link was refused.
			db
				.prepare(
					`UPDATE transactions SET refund_of_id = ?1, refund_unlinked_purchase_date = NULL,
						credit_reviewed = CASE WHEN amount_cents < 0 THEN 1 ELSE credit_reviewed END,
						credit_reviewed_by = CASE WHEN amount_cents < 0 THEN 'user' ELSE credit_reviewed_by END,
						excluded_source = CASE WHEN excluded = 1 THEN 'user' ELSE excluded_source END,
						excluded = 0
					WHERE id = ?2 AND ${refundFitsSql("?2", "?1")}`,
				)
				.bind(newLink, id),
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
	// A name a person gives settles the merchant's pending suggestion: accepted when it is one of the
	// suggested names, rejected when it is their own (spec §7). A form that gave no name leaves the
	// merchant's name and suggestion alone; its row is still made, which a rule needs.
	statements.push(
		edit.nameChanged === false
			? gated(
					"INSERT INTO merchants (raw_name) SELECT ? WHERE 1",
					[current.merchantKey],
					" ON CONFLICT(raw_name) DO NOTHING",
				)
			: gated(
					"INSERT INTO merchants (raw_name, display_name) SELECT ?, ? WHERE 1",
					[current.merchantKey, edit.displayName],
					` ON CONFLICT(raw_name) DO UPDATE SET display_name = excluded.display_name, ${SETTLE_SUGGESTION_SQL}`,
				),
	);
	// "Keep the bank's name": the tidied text stays and the suggestions are turned down, never offered again.
	if (edit.keepBankName && edit.displayName === null)
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
	// A split is one bank transaction: excluding any part of it excludes the purchase and
	// all its parts. Child audit fields change only when the choice does.
	const kindChanged =
		edit.kind !== undefined &&
		edit.kind !== current.kind &&
		(edit.kind !== undefined || edit.detailsFieldChanged === true) &&
		(current.kindGuessed === 0 ||
			edit.detailsVisible !== false ||
			edit.detailsFieldChanged === true);
	const personChanged =
		edit.forPersonId !== undefined &&
		edit.forPersonId !== current.forPersonId &&
		(edit.forPersonId !== undefined || edit.detailsFieldChanged === true) &&
		(current.forPersonGuessed === 0 ||
			edit.detailsVisible !== false ||
			edit.detailsFieldChanged === true);
	if (noteChanged || kindChanged || personChanged || edit.keepDetails) {
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
					kindChanged ? 1 : 0,
					edit.keepDetails ? 1 : 0,
					kindChanged ? 1 : 0,
					edit.kind === null ? 1 : 0,
					personChanged ? 1 : 0,
					edit.forPersonId ?? null,
					personChanged ? 1 : 0,
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
 * Sets a merchant's category rule the way "Always for this merchant" does, for a save that has no
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
 * Dates of the refunds linked to a purchase or its parts, oldest first: the ones a split change affects.
 * `self` includes refunds of the purchase itself.
 */
async function linkedRefundDates(db: D1Database, id: number, self: boolean) {
	const { results } = await db
		.prepare(
			`SELECT date FROM transactions WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ?1${self ? " OR id = ?1" : ""}) ORDER BY date, id`,
		)
		.bind(id)
		.all<{ date: string }>();
	return results.map((row) => row.date);
}

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

/** A bill a part's linked payment pays, with the bill's id: the key a dismissal records (decision 99). */
type PartBill = UnpaidBill & { billId: number };

/** A linked payment on a part, with the part's amount and category: what a replacement can keep it by. */
type PartPayment = PartBill & {
	paymentId: number;
	amountCents: number;
	categoryId: number | null;
};

/** A bill occurrence a dismissal is recorded for: the bill's id and the period, as bill_payments keys it. */
type BillKey = { billId: number; period: string };

/**
 * The auto dismissals (decision 99) on a purchase's parts and on the purchase itself. A split change's
 * dismissal moves with the parts when they change again, and a new split of the purchase starts with it.
 */
async function splitDismissals(
	db: D1Database,
	parentId: number,
): Promise<BillKey[]> {
	const { results } = await db
		.prepare(
			`SELECT bp.bill_id AS billId, bp.period AS period FROM bill_payments bp
			WHERE bp.status = 'dismissed' AND bp.matched_by = 'auto'
			AND (bp.transaction_id = ? OR bp.transaction_id IN (SELECT id FROM transactions WHERE parent_id = ?))`,
		)
		.bind(parentId, parentId)
		.all<BillKey>();
	return results;
}

/**
 * Pairs each linked payment with the first unused new part of the same amount and category, oldest payment
 * first (decision 99). A payment with no such part is lost: its bill is unpaid, and it is named.
 */
function keepPayments(payments: PartPayment[], parts: SplitPart[]) {
	const used = new Set<number>();
	const kept: { paymentId: number; index: number }[] = [];
	const lost: PartBill[] = [];
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

/** The bills as the toast names them: a name and an occurrence, without the id. */
const namedBills = (bills: PartBill[]): UnpaidBill[] =>
	bills.map(({ name, period }) => ({ name, period }));

/**
 * Creates every child and marks its parent in one D1 batch. A human-confirmed refund link follows
 * each new part, if the whole refund still fits its purchase (src/db/refunded.ts), and is dropped if
 * not; refunds linked to replaced parts are unlinked in the same batch. A refund a bank change unlinked
 * keeps its unlink date on each new part, so the parts still say why (decision 99). The bill payments
 * of replaced parts are dismissed on each new part, and the bills are returned by name (decision 99).
 */
export async function saveSplit(
	db: D1Database,
	parentId: number,
	parts: SplitPart[],
	by: string,
): Promise<{ saved: boolean; unlinked: string[]; bills: UnpaidBill[] }> {
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
	const reviewColumns = ", income_source, credit_reviewed, credit_reviewed_by";
	const reviewValues =
		", (SELECT income_source FROM transactions WHERE id = ?), (SELECT credit_reviewed FROM transactions WHERE id = ?), (SELECT credit_reviewed_by FROM transactions WHERE id = ?)";
	const unlinked = await linkedRefundDates(db, parentId, true);
	const payments = await partBills(db, parentId);
	const { kept, lost } = keepPayments(payments, parts);
	// The dismissals each new part gets: the bills the replaced parts lost, and the earlier split changes' (decision 99).
	const dismissals = [
		...new Map(
			[...lost, ...(await splitDismissals(db, parentId))].map((bill) => [
				`${bill.billId}:${bill.period}`,
				{ billId: bill.billId, period: bill.period },
			]),
		).values(),
	];
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
	// Each new part is dismissed for the bills the replaced parts paid, as Not this one records it, so the
	// matcher does not link one of those bills to a new part by itself (decision 99). Nothing when none.
	const dismiss =
		dismissals.length > 0
			? db
					.prepare(
						`INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status)
						SELECT json_extract(b.value, '$.billId'), json_extract(b.value, '$.period'), part.id, 'auto', 'dismissed'
						FROM json_each(?1) b JOIN transactions part ON part.parent_id = ?2
						WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ?2 AND amount_cents = ?3)`,
					)
					.bind(JSON.stringify(dismissals), parentId, total)
			: null;
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
	const statements = [
		db
			.prepare(
				`UPDATE transactions SET refund_of_id = NULL
				WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ? OR id = ?) AND ${unchanged}`,
			)
			.bind(parentId, parentId, parentId, total),
		...park,
		// The replaced parts' bill payments are unlinked by name here, not left to the parts' cascade (decision 99).
		db
			.prepare(
				`DELETE FROM bill_payments WHERE transaction_id IN (SELECT id FROM transactions WHERE parent_id = ?) AND ${unchanged}`,
			)
			.bind(parentId, parentId, total),
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
		...(dismiss ? [dismiss] : []),
		...restore,
		markParent,
	];
	const results = await db.batch(statements);
	const saved =
		(results[statements.indexOf(markParent)]?.meta.changes ?? 0) > 0;
	// A refund's own link is kept by its new parts, unless it no longer fit: then it is the one unlinked.
	const refundUnlinked =
		(results[statements.indexOf(unlinkRefund)]?.meta.changes ?? 0) > 0;
	return {
		saved,
		unlinked: !saved
			? []
			: !linkedPurchase?.refundOfId
				? unlinked
				: refundUnlinked
					? [linkedPurchase.date]
					: [],
		// Only the bills a person's split change unlinked are named; a payment a new part kept says nothing (decision 99).
		bills: saved ? namedBills(lost) : [],
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
 * refund linked to a part stay linked (decision 79: a cash entry's split is never reset). Unlike
 * saveSplit, nothing is deleted or unlinked.
 *
 * Every statement carries the same gate, so a refusal writes nothing. The gate checks that the entry is
 * still the split it was drawn as (`amountWasCents`, or the new total once the parent statement has set
 * it), that every posted saved part is still one of its parts, that the refunds linked to the entry and to
 * its parts together fit the new total, that the refunds linked to each part still fit its new amount
 * (src/db/refunded.ts), and that the entry has no parts but the saved ones. The parent's amount is set
 * first and the new parts are inserted last, in one statement, so nothing the gate reads changes under an
 * earlier statement: a part another save added in the meantime refuses every statement, and no statement
 * can pass after an earlier one refused. Returns `refundTotalCents` (what the refunds linked to the entry
 * and its parts together take) when those are more than the new total, which moving the parts can't fix.
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
	// The parent's amount is set first, so a refusal by any statement leaves the batch with nothing written.
	const results = await db.batch([
		parentStatement,
		...partStatements,
		...insertStatements,
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
 * Deletes a split and restores its parent atomically, unlinking refunds of its parts and dismissing the bill
 * payments of its parts on the parent, so the matcher does not link them again (decision 99). Returns the refunds' dates and the bills, by name. A split refund's parent is
 * whole again and counts by its own link, so that link is checked like a new one (src/db/refunded.ts) and
 * dropped if the refund no longer fits; its date is returned too.
 */
export async function removeSplit(
	db: D1Database,
	parentId: number,
	by: string,
): Promise<{ unlinked: string[]; bills: UnpaidBill[] }> {
	const unlinked = await linkedRefundDates(db, parentId, false);
	const bills = await partBills(db, parentId);
	const parent = await db
		.prepare("SELECT date FROM transactions WHERE id = ?")
		.bind(parentId)
		.first<{ date: string }>();
	const results = await db.batch([
		db
			.prepare(
				"UPDATE transactions SET refund_of_id=NULL WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=?)",
			)
			.bind(parentId),
		db
			.prepare(
				"UPDATE bill_payments SET transaction_id = ?1, status = 'dismissed', matched_by = 'auto' WHERE transaction_id IN (SELECT id FROM transactions WHERE parent_id = ?1) AND (status = 'linked' OR (status = 'dismissed' AND matched_by = 'auto'))",
			)
			.bind(parentId),
		db.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(parentId),
		db
			.prepare(
				"UPDATE transactions SET is_split = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(by, parentId),
		db.prepare(unlinkSplitOverRefundedSql("?1")).bind(parentId),
	]);
	const refundUnlinked = (results.at(-1)?.meta.changes ?? 0) > 0;
	return {
		unlinked: parent && refundUnlinked ? [...unlinked, parent.date] : unlinked,
		bills: namedBills(bills),
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
		ids,
	}: {
		categories?: boolean;
		income?: boolean;
		details?: boolean;
		ids?: number[];
	} = {},
): Promise<
	(JevInput & {
		id: number;
		categoryOnly: boolean;
		merchantKey: string;
		detailsAsked: boolean;
	})[]
> {
	const { results } = await db
		.prepare(
			`SELECT t.id, ${merchantKeySql("t")} AS merchantKey, t.raw_name AS rawName, ${merchantColumnSql("t", "display_name")} AS displayName,
				${merchantColumnSql("t", "suggested_name")} AS suggestedNames, ${merchantColumnSql("t", "suggestion_status")} AS suggestionStatus,
				t.amount_cents AS amountCents, a.type AS accountType,
				t.plaid_category AS plaidCategory, t.note, t.kind, hp.name AS forPerson,
				t.details_asked AS detailsAsked,
				${CATEGORY_ONLY} AS categoryOnly
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN household_people hp ON hp.id = t.for_person_id
			${COUNTED_JOINS}
			WHERE NOT ${FOLLOWS_PURCHASE} AND (
				(? = 1 AND ${NEEDS_JEV_CLASSIFICATION} AND t.category_confidence IS NULL)
				OR (? = 1 AND ${INCLUDED} AND t.flag_income = 0 AND t.details_asked = 0 AND (${EMPTY_NOTE} OR t.kind IS NULL OR t.for_person_id IS NULL))
			)
				AND (? = 1 OR NOT ${CATEGORY_ONLY})
				${ids ? "AND t.id IN (SELECT value FROM json_each(?))" : ""}
			-- Never-failed first, then longest-ago failures, so a failing one can't block the rest.
			ORDER BY t.jev_failed_at IS NOT NULL, t.jev_failed_at, t.date DESC, t.id DESC
			LIMIT ?`,
		)
		.bind(
			categories || income ? 1 : 0,
			details ? 1 : 0,
			categories || details ? 1 : 0,
			...(ids ? [JSON.stringify(ids)] : []),
			limit,
		)
		.all<
			JevInput & {
				id: number;
				categoryOnly: number;
				merchantKey: string;
				detailsAsked: number;
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

/**
 * The bounded set of note guesses for this run. Only a transaction Jev said a what-it-was line could help with
 * (`note_worth_writing = 1`, decision 103) is sent to Workers AI, so a no, an unanswered one and every one from
 * before that answer existed are never sent. Each row carries the names a guess is checked against: the bank
 * text, Plaid's merchant name, and the names the row can show. Only the bank text is sent.
 */
export async function transactionsNeedingNoteGuess(
	db: D1Database,
	limit: number,
): Promise<
	{
		id: number;
		rawName: string;
		merchantName: string | null;
		displayName: string | null;
		suggestedNames: string | null;
		suggestionStatus: string | null;
		merchantKey: string;
	}[]
> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.raw_name AS rawName, t.merchant_name AS merchantName,
				${merchantColumnSql("t", "display_name")} AS displayName, ${NAME_SUGGESTION_COLUMNS}
			 FROM transactions t
			 WHERE t.details_asked = 1 AND t.note_worth_writing = 1 AND t.note_dismissed = 0 AND ${EMPTY_NOTE}
			 ORDER BY t.note_tried_at IS NOT NULL, t.note_tried_at, t.date DESC, t.id DESC LIMIT ?`,
		)
		.bind(limit)
		.all<{
			id: number;
			rawName: string;
			merchantName: string | null;
			displayName: string | null;
			suggestedNames: string | null;
			suggestionStatus: string | null;
			merchantKey: string;
		}>();
	return results;
}

/** Stores successful note guesses together; one JSON parameter stays below D1's bind limit. */
export async function saveNoteAttempts(
	db: D1Database,
	attempted: number[],
	notes: { id: number; note: string }[],
): Promise<void> {
	if (attempted.length === 0) return;
	await db
		.prepare(
			`WITH attempted AS (SELECT value AS id FROM json_each(?)), guesses AS (
				SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.note') AS note FROM json_each(?)
			)
			UPDATE transactions AS t SET
				note = CASE WHEN t.note_dismissed = 0 AND t.details_asked = 1 AND ${EMPTY_NOTE} AND EXISTS (SELECT 1 FROM guesses WHERE guesses.id = t.id) THEN (SELECT note FROM guesses WHERE guesses.id = t.id) ELSE note END,
				note_guessed = CASE WHEN t.note_dismissed = 0 AND t.details_asked = 1 AND ${EMPTY_NOTE} AND EXISTS (SELECT 1 FROM guesses WHERE guesses.id = t.id) THEN 1 ELSE note_guessed END,
				note_tried_at = datetime('now'), updated_at = datetime('now')
			WHERE t.id IN (SELECT id FROM attempted)`,
		)
		.bind(JSON.stringify(attempted), JSON.stringify(notes))
		.run();
}

/**
 * Stores what code decided from Jev's answer. It only writes to a transaction that is still
 * uncategorized with no source, so a person's choice made in the meantime always wins.
 * A transfer or reimbursement flag also excludes the transaction (spec §6), which a person can undo
 * with the edit panel's exclude toggle (#27); it never overrides a person's exclusion or income choice, and it never
 * clears or takes over an income flag Plaid set at sync (decision 67; the flag keeps `income_source` null). Returns whether it wrote the row.
 */
export async function saveJevResult(
	db: D1Database,
	id: number,
	d: Decision,
	options: {
		categoryOnly?: boolean;
		categoryAsked?: boolean;
		switches?: { income: boolean; categories?: boolean };
	} = {},
): Promise<boolean> {
	if (options.categoryOnly) {
		// A person already decided what this credit means. Jev may help with its category only.
		const category = await db
			.prepare(
				`UPDATE transactions SET
					category_id = ?, category_source = ?, category_confidence = ?, jev_category_id = ?, jev_none_fit = ?,
					updated_at = datetime('now')
				 WHERE id = ? AND flag_income = 0
					AND ((amount_cents < 0 AND credit_reviewed = 1 AND (income_source = 'user' OR credit_reviewed_by = 'user'))
						OR (excluded = 1 AND ${PAYS_A_BILL}))
					AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
					AND ${INCLUDED_ROW} AND is_split = 0`,
			)
			.bind(
				options.categoryAsked === false ? null : d.categoryId,
				options.categoryAsked === false || d.categoryId === null ? null : "jev",
				options.categoryAsked === false ? null : d.confidence,
				options.categoryAsked === false ? null : d.suggestedCategoryId,
				options.categoryAsked === false || !d.noneFit ? 0 : 1,
				id,
			)
			.run();
		return category.meta.changes > 0;
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
	const result = await db
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
				)`,
		)
		.bind(
			options.categoryAsked === false ? null : d.categoryId,
			options.categoryAsked === false || d.categoryId === null ? null : "jev",
			options.categoryAsked === false ? null : d.confidence,
			incomeOn ? 1 : 0,
			confidenceBasisPoints(incomeConfidence ?? 0),
			confidenceBasisPoints(JEV_THRESHOLD),
			incomeConfidence ?? 0,
			options.switches?.categories === false ? 0 : 1,
			confidenceBasisPoints(
				d.flagConfidence?.transfer ?? (d.flags.transfer ? 1 : 0),
			),
			confidenceBasisPoints(JEV_THRESHOLD),
			d.flagConfidence?.transfer ?? (d.flags.transfer ? 1 : 0),
			d.categoryId !== null ? 1 : 0,
			confidenceBasisPoints(d.confidence),
			confidenceBasisPoints(JEV_THRESHOLD),
			incomeConfidence,
			confidenceBasisPoints(incomeConfidence ?? 0),
			10_000 - confidenceBasisPoints(JEV_THRESHOLD),
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
		)
		.run();
	return result.meta.changes > 0;
}

/** How many of these transactions pay a bill, on their own link or their split parent's (`paysBillSql`). */
export async function payingBillsCount(
	db: D1Database,
	ids: number[],
): Promise<number> {
	if (ids.length === 0) return 0;
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM transactions t WHERE t.id IN (${ids.map(() => "?").join(",")}) AND ${paysBillSql("t")}`,
		)
		.bind(...ids)
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
