import { JEV_THRESHOLD, type JevInput } from "../ai/categorize";
import { confidenceBasisPoints } from "../ai/confidence";
import type { Decision } from "../ai/decide";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import { type Edit, merchantRuleChange } from "../transactions/edit";
import { type Filters, likePattern, type Show } from "../transactions/filters";
import {
	type NameSource,
	nameSource,
	offeredNames,
	shownName,
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
	INCLUDED,
	INCLUDED_ROW,
	includedSql,
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
	refundOfId?: number | null;
	refundPurchaseDate?: string | null;
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
const NAME_SUGGESTION_COLUMNS = `${merchantColumnSql("t", "suggested_name")} AS suggestedNames, ${merchantColumnSql("t", "suggestion_status")} AS suggestionStatus, ${merchantKeySql("t")} AS merchantKey`;
type NameSuggestionColumns = {
	suggestedNames: string | null;
	suggestionStatus: string | null;
	merchantKey: string;
};

/**
 * True when a merchant's pending, unchosen suggested names (one per line) hold the search text; one `?`.
 * With the names switch off only the bank's own name is offered (a suggestion equal to the merchant's
 * key, src/transactions/name-suggestions.ts), so only that one can match.
 */
const suggestedNameMatch = (namesOn: boolean) =>
	`EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("t")} AND m.suggestion_status = 'pending' AND m.display_name IS NULL${namesOn ? "" : " AND m.suggested_name = m.raw_name"} AND m.suggested_name LIKE ? ESCAPE '\\')`;

export const PAGE_SIZE = 25;

// "Needs category" mirrors Home's effective category: linked refunds follow the purchase,
// while held credits and income stay out of spending classification.
const NEEDS_CATEGORY = `${COUNTED_CATEGORY} IS NULL AND ${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE} AND (t.amount_cents >= 0 OR t.credit_reviewed = 1)`;
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
): Promise<{ rows: ListRow[]; total: number; page: number; pages: number }> {
	const where: string[] = [];
	const args: (string | number)[] = [];
	const { names: namesOn, income: incomeOn } = await readAiSwitches(db);
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
	const shown = (f.raw ? RAW_SHOW_SQL : SHOW_SQL)[f.show];
	if (shown) where.push(shown);
	if (f.q) {
		if (f.raw) {
			where.push("t.raw_name LIKE ? ESCAPE '\\'");
			args.push(likePattern(f.q));
		} else {
			// The raw text also matches with each * read as a space, as its tidied name shows it (#93):
			// "google youtube" finds "GOOGLE *YOUTUBE". A name the row shows as a suggestion matches too,
			// while it is offered (the bank's own always, Tally's guesses while the names switch is on), so what a
			// row says can be searched for.
			where.push(
				`(COALESCE(${merchantColumnSql("t", "display_name")}, t.raw_name) LIKE ? ESCAPE '\\' OR t.raw_name LIKE ? ESCAPE '\\' OR REPLACE(REPLACE(REPLACE(t.raw_name, '*', ' '), '  ', ' '), '  ', ' ') LIKE ? ESCAPE '\\' OR COALESCE(t.note, '') LIKE ? ESCAPE '\\' OR ${suggestedNameMatch(namesOn)})`,
			);
			const pattern = likePattern(f.q);
			args.push(pattern, pattern, pattern, pattern);
			args.push(pattern);
		}
	}

	// The row shows the category it counts in, so a linked refund shows its purchase's.
	const from = `FROM transactions t
			${COUNTED_JOINS}
			LEFT JOIN categories c ON c.id = ${COUNTED_CATEGORY}
			LEFT JOIN categories maybeCat ON maybeCat.id = t.jev_category_id AND maybeCat.archived=0
			LEFT JOIN category_suggestions cs ON cs.id = t.category_suggestion_id AND cs.status = 'pending'
			LEFT JOIN transactions p ON p.id = t.parent_id
			${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`;

	const counted = await db
		.prepare(`SELECT COUNT(*) AS n ${from}`)
		.bind(...args)
		.first<{ n: number }>();
	const total = counted?.n ?? 0;
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(f.page, pages);

	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS rawName,
				${merchantColumnSql("t", "display_name")} AS merchantName, ${NAME_SUGGESTION_COLUMNS}, t.note, t.parent_id AS parentId,
				t.is_split AS isSplit, ${merchantColumnSql("p", "display_name")} AS parentMerchantName, ${merchantColumnSql("p", "suggested_name")} AS parentSuggestedNames, ${merchantColumnSql("p", "suggestion_status")} AS parentSuggestionStatus, ${merchantKeySql("p")} AS parentMerchantKey, p.raw_name AS parentRawName,
				t.split_removed_from_cents AS splitRemovedFromCents,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				(SELECT COALESCE(-SUM(r.amount_cents),0) FROM transactions r WHERE r.refund_of_id=t.id AND r.is_split=0 AND r.excluded=0 AND r.amount_cents<0 AND r.flag_income=0 AND COALESCE(r.credit_reviewed,0)=1 AND t.excluded=0) AS refundedCents,
				t.excluded, ${paysBillSql("t")} AS paysBill,
				(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=t.id AND bp.status='linked' LIMIT 1) AS billName,
				(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=p.id AND bp.status='linked' LIMIT 1) AS parentBillName,
				${PENDING_SQL} AS pending, t.flag_income AS income, t.credit_reviewed AS creditReviewed, CASE WHEN ${hasIncomeAnswerSql("t")} THEN NULL ELSE t.income_confidence END AS incomeConfidence,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
				CASE WHEN cs.id IS NOT NULL AND t.category_id IS NULL AND t.category_source IS NULL THEN 'new:' || cs.name WHEN t.category_id IS NULL AND t.category_source IS NULL AND t.category_confidence < ${JEV_THRESHOLD} THEN maybeCat.name END AS maybeCategoryName,
				CASE WHEN cs.id IS NOT NULL THEN 1 ELSE 0 END AS maybeCategoryNew,
				CASE WHEN ${COUNTED_MONTH} != substr(t.date,1,7) THEN ${COUNTED_MONTH} END AS countsInMonth
			${from}
			ORDER BY t.date DESC, t.id DESC
			LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
		)
		.bind(...args)
		.all<
			Omit<
				ListRow,
				| "excluded"
				| "paysBill"
				| "income"
				| "creditReviewed"
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
				displayName: shown.name,
				nameSuggested: shown.suggested,
				nameFromBank: shown.fromBank,
			};
		},
	);
	return { rows, total, page, pages };
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
	/** A person explicitly reviewed this credit as non-income; Jev's settled state is separate. */
	creditReviewedByUser: boolean;
	accountName: string;
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
				t.is_split AS isSplit, NULL AS parentName,
				t.split_removed_from_cents AS splitRemovedFromCents,
				t.refund_of_id AS refundOfId, rp.date AS refundPurchaseDate, ${FOLLOWS_PURCHASE} AS followsPurchase,
				(SELECT COALESCE(-SUM(r.amount_cents),0) FROM transactions r WHERE r.refund_of_id=t.id AND r.is_split=0 AND r.excluded=0 AND r.amount_cents<0 AND r.flag_income=0 AND COALESCE(r.credit_reviewed,0)=1 AND t.excluded=0) AS refundedCents,
				t.excluded, ${paysBillSql("t")} AS paysBill,
				(SELECT b.name FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id WHERE bp.transaction_id=t.id AND bp.status='linked' LIMIT 1) AS billName,
				${PENDING_SQL} AS pending, t.flag_income AS income, CASE WHEN ${hasIncomeAnswerSql("t")} THEN NULL ELSE t.income_confidence END AS incomeConfidence, t.category_source AS categorySource, t.category_confidence AS categoryConfidence,
				t.credit_reviewed AS creditReviewed, (t.credit_reviewed_by = 'user') AS creditReviewedByUser,
				c.id AS categoryId, c.name AS categoryName, c.icon AS categoryIcon, c.color AS categoryColor,
				t.jev_category_id AS suggestedCategoryId, maybeCat.name AS suggestedCategoryName,
				CASE WHEN cs.id IS NOT NULL AND t.category_id IS NULL AND t.category_source IS NULL THEN 'new:' || cs.name WHEN t.category_id IS NULL AND t.category_source IS NULL AND t.category_confidence < ${JEV_THRESHOLD} THEN maybeCat.name END AS maybeCategoryName,
				CASE WHEN cs.id IS NOT NULL THEN 1 ELSE 0 END AS maybeCategoryNew,
				CASE WHEN ${COUNTED_MONTH} != substr(t.date,1,7) THEN ${COUNTED_MONTH} END AS countsInMonth,
				a.name AS accountName, a.mask AS accountMask, a.type AS accountType
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			-- The panel edits the transaction's own category; a linked refund's purchase's is shown separately.
			LEFT JOIN categories c ON c.id = t.category_id
			LEFT JOIN categories maybeCat ON maybeCat.id = t.jev_category_id AND maybeCat.archived=0
			LEFT JOIN category_suggestions cs ON cs.id = t.category_suggestion_id AND cs.status = 'pending'
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
				}
		>();
	if (!r) return null;
	// A person's chosen name wins; until then the first pending suggestion, shown dashed; otherwise the
	// bank's raw text is tidied for display (spec §7). The panel offers every pending suggestion.
	const { suggestedNames, suggestionStatus, merchantKey, ...row } = r;
	const { names: namesOn, income: incomeOn } = await readAiSwitches(db);
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
		excluded: r.excluded === 1,
		paysBill: r.paysBill === 1,
		income: r.income === 1,
		incomeConfidence: incomeOn ? r.incomeConfidence : null,
		creditReviewed: r.creditReviewed === 1,
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
 * What saving the edit panel did. A refund link that is more than what's left of its purchase is
 * refused (spec §8.5) with nothing saved, and `refundLeftCents` is what the purchase has left.
 */
export type SaveEditResult =
	| { saved: true }
	| { saved: false; refundLeftCents: number };

/**
 * Saves the edit panel in one atomic batch: the category (marked as a person's choice when it
 * changes), the note, whether it's excluded, the merchant's display name, and, if asked, the merchant rule, which also
 * recategorizes the merchant's other transactions except ones a person chose (spec §7).
 *
 * Linking a refund to a purchase (spec §6, §8.5) is the one write that can be refused, and so is
 * turning off "Count as income" on a credit that stays linked, which makes it count against its
 * purchase. The check is an UPDATE that changes nothing unless what moves with the refund fits what's
 * left of the purchase (src/db/refunded.ts), so two saves at once can't both fit; every other write
 * in the batch applies only once it has, so a refusal saves nothing, and an error anywhere rolls the
 * link back too. A person linking a refund includes it in the budget, even when it was excluded
 * (`excluded = 0`, `excluded_source = 'user'`); a link that isn't changing is left alone.
 */
export async function saveEdit(
	db: D1Database,
	id: number,
	edit: Edit,
	actor: string,
): Promise<SaveEditResult> {
	const current = await db
		.prepare(
			`SELECT ${merchantKeySql("transactions")} AS merchantKey, category_id AS categoryId, flag_income AS income, income_source AS incomeSource, credit_reviewed AS creditReviewed, credit_reviewed_by AS creditReviewedBy, excluded, refund_of_id AS refundOfId, is_split AS isSplit FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<{
			merchantKey: string;
			categoryId: number | null;
			income: number;
			incomeSource: string | null;
			creditReviewed: number | null;
			creditReviewedBy: string | null;
			excluded: number;
			refundOfId: number | null;
			isSplit: number;
		}>();
	if (!current) throw new Error(`No transaction ${id}`);

	// The purchase this refund is being linked to now: undefined when its link stays as it is, null
	// when it's being unlinked.
	const newLink =
		edit.refundOfId !== undefined && edit.refundOfId !== current.refundOfId
			? edit.refundOfId
			: undefined;
	const linking = typeof newLink === "number";
	// A linked credit marked as income doesn't count toward its purchase (src/db/refunded.ts), so
	// turning that off, with the link staying, makes it count: that is checked like a link. (A split
	// parent never counts, only its parts do, and the cap ignores whether a refund is excluded or
	// reviewed, so income is the one flag that changes what counts.)
	const recounting =
		newLink === undefined &&
		current.refundOfId !== null &&
		current.income === 1 &&
		!edit.income &&
		current.isSplit === 0
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
	/** A statement with the gate on its WHERE (before `tail`), binding `args` and then the gate's. */
	const gated = (sql: string, args: unknown[], tail = "") =>
		db
			.prepare(`${sql}${gate.sql(args.length + 1)}${tail}`)
			.bind(...args, ...gate.args);

	const changed =
		edit.categoryId !== null && edit.categoryId !== current.categoryId;
	const creditReviewChoice = edit.creditReviewed ? 1 : 0;
	const incomeChanged =
		edit.incomeWas === undefined
			? (edit.income ? 1 : 0) !== current.income
			: edit.income !== edit.incomeWas;
	const creditReviewChanged =
		edit.creditReviewedProvided === false
			? false
			: edit.creditReviewedWas === undefined
				? edit.creditReviewed !== (current.creditReviewedBy === "user")
				: edit.creditReviewed !== edit.creditReviewedWas;
	const creditReviewByUser =
		creditReviewChanged && !edit.income && creditReviewChoice === 1;
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
					`UPDATE transactions SET refund_of_id = ?1
					WHERE parent_id = ?2 AND refund_of_id IS (SELECT refund_of_id FROM transactions WHERE id = ?2)
						AND ${refundFitsSql("?2", "?1")}`,
				)
				.bind(newLink, id),
			// A person linking it makes it a reviewed refund that counts, as their choice. This is the
			// statement whose result says whether the link was refused.
			db
				.prepare(
					`UPDATE transactions SET refund_of_id = ?1,
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
					`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL,
						note = ?, ${EXCLUDE}, flag_income = CASE WHEN ? = 1 THEN ? ELSE flag_income END,
						income_source = CASE WHEN ? = 1 OR ? = 1 THEN 'user' ELSE income_source END,
						credit_reviewed = CASE WHEN amount_cents < 0 AND ? = 1 AND ? = 1 THEN 1 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN 0 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND income_source = 'jev' THEN 0 ELSE credit_reviewed END,
						credit_reviewed_by = CASE WHEN ? = 1 THEN 'user' WHEN ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN NULL ELSE credit_reviewed_by END,
						updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					[edit.categoryId, edit.note, ...excludeArgs, ...reviewArgs],
				)
			: gated(
					`UPDATE transactions SET note = ?, ${edit.categoryId !== null ? "split_removed_from_cents = NULL," : ""} ${EXCLUDE}, flag_income = CASE WHEN ? = 1 THEN ? ELSE flag_income END,
				income_source = CASE WHEN ? = 1 OR ? = 1 THEN 'user' ELSE income_source END,
					credit_reviewed = CASE WHEN amount_cents < 0 AND ? = 1 AND ? = 1 THEN 1 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN 0 WHEN amount_cents < 0 AND ? = 1 AND ? = 0 AND income_source = 'jev' THEN 0 ELSE credit_reviewed END,
					credit_reviewed_by = CASE WHEN ? = 1 THEN 'user' WHEN ? = 1 AND ? = 0 AND credit_reviewed_by = 'user' THEN NULL ELSE credit_reviewed_by END,
					updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
					[edit.note, ...excludeArgs, ...reviewArgs],
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
			db
				.prepare(
					"UPDATE transactions SET refund_of_id = NULL WHERE parent_id = ?1 AND refund_of_id IS (SELECT refund_of_id FROM transactions WHERE id = ?1)",
				)
				.bind(id),
			db
				.prepare("UPDATE transactions SET refund_of_id = NULL WHERE id = ?")
				.bind(id),
		);
	} else if (linking) {
		// An explicit human link is also a review of this credit as a refund. The link was written
		// first, with that review, but the category update after it applies the panel's review chip,
		// which a person linking a refund hasn't ticked, so the review is made again here. It stays on
		// a split parent, so its parts inherit the reviewed link as one bank transaction.
		statements.push(
			db
				.prepare(
					`UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user'
					WHERE id = ? AND amount_cents < 0 AND refund_of_id = ?`,
				)
				.bind(id, newLink),
		);
	}
	// A split is one bank transaction: excluding any part of it excludes the purchase and
	// all its parts. Child audit fields change only when the choice does.
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
				gated(
					`UPDATE transactions SET category_id = ?, category_source = 'merchant_rule', category_confidence = NULL, split_removed_from_cents = NULL,
					updated_by = ?, updated_at = datetime('now')
				WHERE ${merchantKeySql("transactions")} = ? AND id != ? AND COALESCE(category_source, '') != 'user'`,
					[edit.categoryId, actor, current.merchantKey, id],
				),
			);
	} else if (ruleChange.action === "clear" && edit.merchantRuleWas != null) {
		statements.push(
			gated(`${CLEAR_MERCHANT_RULE_SQL} AND default_category_id = ?`, [
				current.merchantKey,
				edit.merchantRuleWas,
			]),
		);
	}
	const results = await db.batch(statements);
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
 * Creates every child and marks its parent in one D1 batch. A human-confirmed refund link follows
 * each new part, if the whole refund still fits its purchase (src/db/refunded.ts), and is dropped if
 * not; refunds linked to replaced parts are unlinked in the same batch.
 */
export async function saveSplit(
	db: D1Database,
	parentId: number,
	parts: SplitPart[],
	by: string,
): Promise<{ saved: boolean; unlinked: string[] }> {
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
	const linkedPurchase = await db
		.prepare(
			"SELECT refund_of_id AS refundOfId, date FROM transactions WHERE id = ?",
		)
		.bind(parentId)
		.first<{ refundOfId: number | null; date: string }>();
	const inheritedRefundLink =
		"CASE WHEN refund_of_id IS NOT NULL AND EXISTS (SELECT 1 FROM transactions rp WHERE rp.id = transactions.refund_of_id) THEN refund_of_id ELSE NULL END";
	const results = await db.batch([
		db
			.prepare(
				`UPDATE transactions SET refund_of_id = NULL
				WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id = ? OR id = ?) AND ${unchanged}`,
			)
			.bind(parentId, parentId, parentId, total),
		db
			.prepare(`DELETE FROM transactions WHERE parent_id = ? AND ${unchanged}`)
			.bind(parentId, parentId, total),
		// With the old parts gone and before the new ones take the parent's link: if the whole refund
		// no longer fits its purchase, the link goes, and the new parts start unlinked.
		db
			.prepare(
				`${unlinkSplitOverRefundedSql("?1")} AND EXISTS (SELECT 1 FROM transactions WHERE id = ?1 AND amount_cents = ?2)`,
			)
			.bind(parentId, total),
		...parts.map((part) =>
			db
				.prepare(`INSERT INTO transactions
			(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, excluded, excluded_source${reviewColumns}, refund_of_id, parent_id, plaid_transaction_id, updated_by)
			SELECT account_id, date, ?, raw_name, merchant_name, ?, 'user', excluded, excluded_source${reviewValues},
				${inheritedRefundLink}, id, NULL, ?
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
		db
			.prepare(
				"UPDATE transactions SET is_split = 1, category_suggestion_id=NULL, jev_none_fit=0, split_removed_from_cents = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ? AND amount_cents = ?",
			)
			.bind(by, parentId, total),
	]);
	const saved = (results.at(-1)?.meta.changes ?? 0) > 0;
	// A refund's own link is kept by its new parts, unless it no longer fit: then it is the one unlinked.
	const refundUnlinked = (results[2]?.meta.changes ?? 0) > 0;
	return {
		saved,
		unlinked: !saved
			? []
			: !linkedPurchase?.refundOfId
				? unlinked
				: refundUnlinked
					? [linkedPurchase.date]
					: [],
	};
}

/**
 * Deletes a split and restores its parent atomically, unlinking refunds of its parts; returns their
 * dates. A split refund's parent is whole again and counts by its own link, so that link is checked
 * like a new one (src/db/refunded.ts) and dropped if the refund no longer fits; its date is returned too.
 */
export async function removeSplit(
	db: D1Database,
	parentId: number,
	by: string,
): Promise<string[]> {
	const unlinked = await linkedRefundDates(db, parentId, false);
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
		db.prepare("DELETE FROM transactions WHERE parent_id = ?").bind(parentId),
		db
			.prepare(
				"UPDATE transactions SET is_split = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(by, parentId),
		db.prepare(unlinkSplitOverRefundedSql("?1")).bind(parentId),
	]);
	const refundUnlinked = (results.at(-1)?.meta.changes ?? 0) > 0;
	return parent && refundUnlinked ? [...unlinked, parent.date] : unlinked;
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
			WHERE (category_id IS NULL AND category_source IS NULL OR category_source = 'bill') AND EXISTS (${rule})`,
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
	{ categories = true, ids }: { categories?: boolean; ids?: number[] } = {},
): Promise<
	(JevInput & { id: number; categoryOnly: boolean; merchantKey: string })[]
> {
	const { results } = await db
		.prepare(
			`SELECT t.id, ${merchantKeySql("t")} AS merchantKey, t.raw_name AS rawName, ${merchantColumnSql("t", "display_name")} AS displayName,
				t.amount_cents AS amountCents, a.type AS accountType,
				t.plaid_category AS plaidCategory, t.note,
				${CATEGORY_ONLY} AS categoryOnly
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			${COUNTED_JOINS}
			WHERE ${NEEDS_JEV_CLASSIFICATION} AND t.category_confidence IS NULL AND NOT ${FOLLOWS_PURCHASE}
				AND (? = 1 OR NOT ${CATEGORY_ONLY})
				${ids ? "AND t.id IN (SELECT value FROM json_each(?))" : ""}
			-- Never-failed first, then longest-ago failures, so a failing one can't block the rest.
			ORDER BY t.jev_failed_at IS NOT NULL, t.jev_failed_at, t.date DESC, t.id DESC
			LIMIT ?`,
		)
		.bind(categories ? 1 : 0, ...(ids ? [JSON.stringify(ids)] : []), limit)
		.all<
			JevInput & { id: number; categoryOnly: number; merchantKey: string }
		>();
	return results.map((transaction) => ({
		...transaction,
		categoryOnly: transaction.categoryOnly === 1,
	}));
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
				d.categoryId,
				d.categoryId === null ? null : "jev",
				d.confidence,
				d.suggestedCategoryId,
				d.noneFit ? 1 : 0,
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
			d.categoryId,
			d.categoryId === null ? null : "jev",
			d.confidence,
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
			d.suggestedCategoryId,
			d.noneFit ? 1 : 0,
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
					t.flag_transfer = 1 OR COALESCE(t.excluded_source = 'plaid', 0) AS moved,
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
