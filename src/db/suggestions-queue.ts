// The one review screen's queue (spec §8.6, decisions 79 and 101, issue #195): every "Maybe …" that a
// person hasn't answered, in the order the screen asks them. The Band on Settings counts this list and
// the screen shows it one item at a time, so the two can't drift apart.
import { JEV_THRESHOLD } from "../ai/categorize";
import { confidencePercent } from "../ai/confidence";
import { isUnsure, maybeIncomeVisible } from "../ai/maybe";
import { tidyName } from "../transactions/tidy-name";
import { type AiSwitches, readAiSwitches } from "./ai-switches";
import { pendingSuggestions } from "./category-suggestions";
import { paysBillSql } from "./counted-month";
import { hasIncomeAnswerSql } from "./income";
import { merchantKeySql } from "./merchant-key";
import { type NameReview, namesToReview } from "./merchant-names";
import type { NeverSuggestKind } from "./never-suggest";

/** A transaction a person is asked about: income, a transfer, or a category guess. */
export type TransactionSuggestion = {
	kind: "income" | "transfer" | "category";
	/** The skip key in the address: never the bank's text. */
	id: string;
	transactionId: number;
	date: string;
	amountCents: number;
	/** The bank's text, as the transaction shows it. */
	bankText: string;
	merchantKey: string;
	/** The store's name: its display name, or its key tidied. */
	merchant: string;
	/** How sure Tally's guess is, as a whole percent ("Tally's guess · 64% sure"). */
	sure: number;
	/** The category Tally guessed (category kind only). */
	categoryId: number | null;
	category: string | null;
};

/** A suggested new category and the purchases behind it, each ticked to go in (§7). */
export type NewCategorySuggestion = {
	kind: "new_category";
	id: string;
	suggestionId: number;
	/** The name Tally suggested, tidied: "Pet Care". */
	name: string;
	date: string;
	rows: {
		transactionId: number;
		date: string;
		amountCents: number;
		merchantKey: string;
		merchant: string;
	}[];
	/** The stores behind the rows, each once, in the order they show. */
	stores: { merchantKey: string; merchant: string }[];
};

/** A merchant whose suggested name waits for a person (P29 A, P87 B). */
export type NameSuggestion = {
	kind: "name";
	id: string;
	/** The merchants row's number: what Skip names it by. */
	rowId: number;
	merchantKey: string;
	/** The merchant's newest charge's date. */
	date: string;
	/** What its charges add up to ("9 transactions · $58.50"). */
	totalCents: number;
	review: NameReview;
};

export type SuggestionItem =
	| TransactionSuggestion
	| NewCategorySuggestion
	| NameSuggestion;

export type SuggestionKind = SuggestionItem["kind"];

/** The order the screen asks in: money first, then categories, new categories and names. */
const ORDER: SuggestionKind[] = [
	"income",
	"transfer",
	"category",
	"new_category",
	"name",
];

const ruleKey = (kind: NeverSuggestKind, merchantKey: string) =>
	`${kind}\u0000${merchantKey}`;

/** Every "Never suggest" line, as lookups: a store with a line for a kind is never asked about it. */
async function neverSuggestLines(db: D1Database): Promise<Set<string>> {
	const { results } = await db
		.prepare(
			"SELECT merchant_key AS merchantKey, kind FROM never_suggest_rules",
		)
		.all<{ merchantKey: string; kind: NeverSuggestKind }>();
	return new Set(results.map((row) => ruleKey(row.kind, row.merchantKey)));
}

const LABEL_SQL = `m.display_name AS displayName`;
const JOIN_MERCHANT = `LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}`;

type Candidate = {
	id: number;
	date: string;
	amountCents: number;
	bankText: string;
	merchantKey: string;
	displayName: string | null;
};

const merchantLabel = (displayName: string | null, key: string) =>
	displayName || tidyName(key);

/**
 * Income: a credit Tally is unsure is income and nobody has decided, or said No to (`income_maybe_declined`, decision 101).
 * Spec §8.6, "Jev's income answer is used".
 */
async function incomeSuggestions(
	db: D1Database,
	never: Set<string>,
): Promise<{ item: TransactionSuggestion; order: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS bankText, ${merchantKeySql("t")} AS merchantKey, ${LABEL_SQL},
				CASE WHEN ${hasIncomeAnswerSql("t")} OR t.income_maybe_declined = 1 THEN NULL ELSE t.income_confidence END AS incomeConfidence,
				t.flag_income AS income, t.credit_reviewed AS creditReviewed, t.excluded AS excluded, ${paysBillSql("t")} AS paysBill
			FROM transactions t ${JOIN_MERCHANT}
			WHERE t.parent_id IS NULL AND t.is_split = 0 AND t.income_confidence IS NOT NULL AND t.refund_of_id IS NULL`,
		)
		.all<
			Candidate & {
				incomeConfidence: number | null;
				income: number;
				creditReviewed: number;
				excluded: number;
				paysBill: number;
			}
		>();
	return results
		.filter(
			(row) =>
				maybeIncomeVisible({
					amountCents: row.amountCents,
					income: row.income === 1,
					incomeConfidence: row.incomeConfidence,
					creditReviewed: row.creditReviewed === 1,
					excluded: row.excluded === 1,
					paysBill: row.paysBill === 1,
				}) && !never.has(ruleKey("income", row.merchantKey)),
		)
		.map((row) => ({
			order: row.id,
			item: {
				kind: "income",
				id: `income-${row.id}`,
				transactionId: row.id,
				date: row.date,
				amountCents: row.amountCents,
				bankText: row.bankText,
				merchantKey: row.merchantKey,
				merchant: merchantLabel(row.displayName, row.merchantKey),
				sure: confidencePercent(row.incomeConfidence ?? 0),
				categoryId: null,
				category: null,
			},
		}));
}

/** Transfer: money out or in Tally is unsure is a transfer and nobody has decided, or said No to (`transfer_maybe_declined`). */
async function transferSuggestions(
	db: D1Database,
	never: Set<string>,
): Promise<{ item: TransactionSuggestion; order: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS bankText, ${merchantKeySql("t")} AS merchantKey, ${LABEL_SQL},
				t.transfer_confidence AS transferConfidence
			FROM transactions t ${JOIN_MERCHANT}
			WHERE t.parent_id IS NULL AND t.is_split = 0 AND t.transfer_confidence IS NOT NULL
				AND t.excluded = 0 AND t.flag_transfer = 0 AND COALESCE(t.excluded_source, '') != 'user' AND t.refund_of_id IS NULL
				AND t.flag_income = 0 AND t.transfer_maybe_declined = 0`,
		)
		.all<Candidate & { transferConfidence: number }>();
	return results
		.filter(
			(row) =>
				isUnsure(row.transferConfidence) &&
				!never.has(ruleKey("transfer", row.merchantKey)),
		)
		.map((row) => ({
			order: row.id,
			item: {
				kind: "transfer",
				id: `transfer-${row.id}`,
				transactionId: row.id,
				date: row.date,
				amountCents: row.amountCents,
				bankText: row.bankText,
				merchantKey: row.merchantKey,
				merchant: merchantLabel(row.displayName, row.merchantKey),
				sure: confidencePercent(row.transferConfidence),
				categoryId: null,
				category: null,
			},
		}));
}

/**
 * A category Tally guessed and nobody has set. Shown the same way as the row's dashed "Maybe" (the
 * category join in `MAYBE_CATEGORY_COLUMNS`): an active category, and an unsure guess.
 */
async function categorySuggestions(
	db: D1Database,
): Promise<{ item: TransactionSuggestion; order: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS bankText, ${merchantKeySql("t")} AS merchantKey, ${LABEL_SQL},
				t.category_confidence AS categoryConfidence, c.id AS categoryId, c.name AS category
			FROM transactions t ${JOIN_MERCHANT}
			JOIN categories c ON c.id = t.jev_category_id AND c.archived = 0
			WHERE t.parent_id IS NULL AND t.is_split = 0 AND t.category_id IS NULL AND t.category_source IS NULL
				AND t.category_confidence < ? AND t.flag_income = 0 AND t.excluded = 0`,
		)
		.bind(JEV_THRESHOLD)
		.all<
			Candidate & {
				categoryConfidence: number;
				categoryId: number;
				category: string;
			}
		>();
	return results.map((row) => ({
		order: row.id,
		item: {
			kind: "category",
			id: `category-${row.id}`,
			transactionId: row.id,
			date: row.date,
			amountCents: row.amountCents,
			bankText: row.bankText,
			merchantKey: row.merchantKey,
			merchant: merchantLabel(row.displayName, row.merchantKey),
			sure: confidencePercent(row.categoryConfidence),
			categoryId: row.categoryId,
			category: row.category,
		},
	}));
}

/**
 * New categories: the pending suggestions from Settings, each with its purchases. A store whose "Never
 * suggest" line for a new category is set drops out of the suggestion, and a suggestion with no store left
 * is not asked at all (decision 101).
 */
async function newCategorySuggestions(
	db: D1Database,
	never: Set<string>,
): Promise<{ item: NewCategorySuggestion; order: number }[]> {
	// Every pending suggestion, not only the ten Settings lists: the count covers every kind (decision 101).
	const suggestions = await pendingSuggestions(db, Number.MAX_SAFE_INTEGER);
	if (suggestions.length === 0) return [];
	const ids = suggestions.flatMap((suggestion) =>
		suggestion.rows.map((row) => row.id),
	);
	const { results } = await db
		.prepare(
			`SELECT t.id, ${merchantKeySql("t")} AS merchantKey, m.display_name AS displayName
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
			WHERE t.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.all<{ id: number; merchantKey: string; displayName: string | null }>();
	const byId = new Map(results.map((row) => [row.id, row]));
	const items: { item: NewCategorySuggestion; order: number }[] = [];
	for (const suggestion of suggestions) {
		const rows = suggestion.rows.flatMap((row) => {
			const found = byId.get(row.id);
			if (!found || never.has(ruleKey("new_category", found.merchantKey)))
				return [];
			return [
				{
					transactionId: row.id,
					date: row.date,
					amountCents: row.amountCents,
					merchantKey: found.merchantKey,
					merchant: merchantLabel(found.displayName, found.merchantKey),
				},
			];
		});
		if (rows.length === 0) continue;
		// Each store once, in the order its first purchase came in, so the question reads the same every time.
		const stores = [
			...new Map(
				[...rows]
					.sort((a, b) => a.transactionId - b.transactionId)
					.map((row) => [
						row.merchantKey,
						{ merchantKey: row.merchantKey, merchant: row.merchant },
					]),
			).values(),
		];
		items.push({
			order: suggestion.id,
			item: {
				kind: "new_category",
				id: `new-${suggestion.id}`,
				suggestionId: suggestion.id,
				name: tidyName(suggestion.name),
				date: rows.reduce(
					(latest, row) => (row.date > latest ? row.date : latest),
					"",
				),
				rows,
				stores,
			},
		});
	}
	return items;
}

/**
 * Names: the merchants with a suggested name waiting (`namesToReview`, which follows the names switch).
 * Ordered by the merchant's newest charge, so the newest name is asked first.
 */
async function nameSuggestions(
	db: D1Database,
	switches: AiSwitches,
): Promise<{ item: NameSuggestion; order: number }[]> {
	const reviews = await namesToReview(db, switches);
	if (reviews.length === 0) return [];
	const keys = reviews.map((review) => review.key);
	const { results } = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS merchantKey, MAX(t.date) AS latest, SUM(t.amount_cents) AS totalCents
			FROM transactions t
			WHERE t.parent_id IS NULL AND ${merchantKeySql("t")} IN (SELECT value FROM json_each(?))
			GROUP BY ${merchantKeySql("t")}`,
		)
		.bind(JSON.stringify(keys))
		.all<{ merchantKey: string; latest: string; totalCents: number }>();
	const totals = new Map(results.map((row) => [row.merchantKey, row]));
	return reviews.map((review) => ({
		order: review.id,
		item: {
			kind: "name",
			id: `name-${review.id}`,
			rowId: review.id,
			merchantKey: review.key,
			date: totals.get(review.key)?.latest ?? "",
			totalCents: totals.get(review.key)?.totalCents ?? 0,
			review,
		},
	}));
}

/** Newest first within a kind: the newest charge's date, then the higher row number. */
function newestFirst<T extends SuggestionItem>(
	items: { item: T; order: number }[],
): T[] {
	return [...items]
		.sort((a, b) => b.item.date.localeCompare(a.item.date) || b.order - a.order)
		.map(({ item }) => item);
}

/**
 * Every item the review screen asks, in order, with each AI switch applied: Spot paychecks gates income,
 * Guess categories gates transfers, categories and new categories, and Suggest store names gates Tally's
 * guessed names (the bank's own names are still asked). The switches are read here unless passed in.
 */
export async function suggestionQueue(
	db: D1Database,
	switches?: AiSwitches,
): Promise<SuggestionItem[]> {
	const s = switches ?? (await readAiSwitches(db));
	const never = await neverSuggestLines(db);
	const [income, transfer, category, newCategory, names] = await Promise.all([
		s.income ? incomeSuggestions(db, never) : [],
		s.categories ? transferSuggestions(db, never) : [],
		s.categories ? categorySuggestions(db) : [],
		s.categories ? newCategorySuggestions(db, never) : [],
		nameSuggestions(db, s),
	]);
	const byKind: Record<SuggestionKind, SuggestionItem[]> = {
		income: newestFirst(income),
		transfer: newestFirst(transfer),
		category: newestFirst(category),
		new_category: newestFirst(newCategory),
		name: newestFirst(names),
	};
	return ORDER.flatMap((kind) => byKind[kind]);
}
