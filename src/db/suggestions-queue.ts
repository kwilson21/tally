// The one review screen's queue (spec §8.6, decisions 79 and 101, issue #195): every "Maybe …" that a
// person hasn't answered, in the order the screen asks them. The Band on Settings counts this list and
// the screen shows it one item at a time, so the two can't drift apart.
import { JEV_THRESHOLD } from "../ai/categorize";
import { confidencePercent } from "../ai/confidence";
import { isUnsure } from "../ai/maybe";
import { sameName } from "../settings/category-form";
import { tidyName } from "../transactions/tidy-name";
import { type AiSwitches, readAiSwitches } from "./ai-switches";
import { categoryNames } from "./categories";
import { pendingSuggestions } from "./category-suggestions";
import { jevAsksAboutSql, paysBillSql } from "./counted-month";
import { maybeIncomeConfidenceSql } from "./income";
import { merchantKeySql } from "./merchant-key";
import { type NameReview, namesToReview } from "./merchant-names";
import { neverSuggestedSql } from "./never-suggest";
import { ownNameSql } from "./own-name";

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
	/** What the card calls it: the transaction's own name (This one only), else the store's name. */
	label: string;
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
	/** The family's active category with this name, as it stored it, when it already has one (decision 101). */
	existing: string | null;
	date: string;
	rows: {
		transactionId: number;
		date: string;
		amountCents: number;
		merchantKey: string;
		merchant: string;
		/** What the card calls it: the transaction's own name (This one only), else the store's name. */
		label: string;
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

const LABEL_SQL = `m.display_name AS displayName, ${ownNameSql("t")} AS ownName`;
const JOIN_MERCHANT = `LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}`;

type Candidate = {
	id: number;
	date: string;
	amountCents: number;
	bankText: string;
	merchantKey: string;
	displayName: string | null;
	ownName: string | null;
};

const merchantLabel = (displayName: string | null, key: string) =>
	displayName || tidyName(key);

/** What a card calls a transaction: its own name (This one only), else its store's. All four kinds share this rule. */
const cardLabel = (row: {
	ownName: string | null;
	displayName: string | null;
	merchantKey: string;
}) => row.ownName ?? merchantLabel(row.displayName, row.merchantKey);

/**
 * True when the review screen can ask whether the credit `alias` names is income: the queue's own check, repeated by the route's Yes and No writes so a stale answer changes nothing. The guess is the one the row shows (`maybeIncomeConfidenceSql`), so a settled, declined or Never-suggested credit is never asked.
 */
export const incomeAskedSql = (alias: string) =>
	`(${alias}.parent_id IS NULL AND ${alias}.is_split = 0 AND ${alias}.refund_of_id IS NULL AND ${alias}.amount_cents < 0
		AND ${alias}.flag_income = 0 AND COALESCE(${alias}.credit_reviewed, 0) = 0 AND (${alias}.excluded = 0 OR ${paysBillSql(alias)})
		AND ${maybeIncomeConfidenceSql(alias)} IS NOT NULL)`;

/**
 * Income: a credit Tally is unsure is income and nobody has decided, or said No to (`income_maybe_declined`, decision 101).
 * Spec §8.6, "Jev's income answer is used".
 */
async function incomeSuggestions(
	db: D1Database,
): Promise<{ item: TransactionSuggestion; order: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS bankText, ${merchantKeySql("t")} AS merchantKey, ${LABEL_SQL},
				${maybeIncomeConfidenceSql("t")} AS incomeConfidence
			FROM transactions t ${JOIN_MERCHANT}
			WHERE ${incomeAskedSql("t")}`,
		)
		.all<Candidate & { incomeConfidence: number }>();
	return results
		.filter((row) => isUnsure(row.incomeConfidence))
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
				label: cardLabel(row),
				sure: confidencePercent(row.incomeConfidence ?? 0),
				categoryId: null,
				category: null,
			},
		}));
}

/**
 * True when the review screen can ask whether the row `alias` names is a transfer: the queue's own check, repeated by the route's Yes and No writes so a stale answer changes nothing. `alias` is a table alias or `transactions` itself (an UPDATE has no alias). A store with a "Never suggest" transfer line is never asked (decision 101). A credit held for review waits until it is reviewed (decision 70).
 */
export const transferAskedSql = (alias: string) =>
	`(${alias}.parent_id IS NULL AND ${alias}.is_split = 0 AND ${alias}.transfer_confidence IS NOT NULL
		AND ${alias}.excluded = 0 AND ${alias}.flag_transfer = 0 AND COALESCE(${alias}.excluded_source, '') != 'user'
		AND ${alias}.refund_of_id IS NULL AND ${alias}.flag_income = 0 AND ${alias}.transfer_maybe_declined = 0
		AND (${alias}.amount_cents >= 0 OR COALESCE(${alias}.credit_reviewed, 0) = 1)
		AND NOT ${paysBillSql(alias)} AND NOT ${neverSuggestedSql(merchantKeySql(alias), "transfer")})`;

/**
 * Transfer: money out or in Tally is unsure is a transfer and nobody has decided, or said No to (`transfer_maybe_declined`).
 * A credit held for review waits until it is reviewed (decision 70). A payment linked to a bill is never asked, since it counts whatever its exclusion (spec §6.1 rule 4).
 */
async function transferSuggestions(
	db: D1Database,
): Promise<{ item: TransactionSuggestion; order: number }[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, t.date, t.amount_cents AS amountCents, t.raw_name AS bankText, ${merchantKeySql("t")} AS merchantKey, ${LABEL_SQL},
				t.transfer_confidence AS transferConfidence
			FROM transactions t ${JOIN_MERCHANT}
			WHERE ${transferAskedSql("t")}`,
		)
		.all<Candidate & { transferConfidence: number }>();
	return results
		.filter((row) => isUnsure(row.transferConfidence))
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
				label: cardLabel(row),
				sure: confidencePercent(row.transferConfidence),
				categoryId: null,
				category: null,
			},
		}));
}

/**
 * True when the review screen can ask about the category of the row `alias` names: the queue's own check, repeated by the route's Something else and Yes writes so a stale answer changes nothing. `JEV_THRESHOLD` is a code constant, so it is written in.
 */
export const categoryAskedSql = (alias: string) =>
	`(${alias}.parent_id IS NULL AND ${alias}.is_split = 0 AND ${alias}.category_id IS NULL AND ${alias}.category_source IS NULL
		AND ${alias}.category_confidence < ${JEV_THRESHOLD} AND ${alias}.flag_income = 0 AND ${jevAsksAboutSql(alias)}
		AND (${alias}.amount_cents >= 0 OR COALESCE(${alias}.credit_reviewed, 0) = 1)
		AND EXISTS (SELECT 1 FROM categories ac WHERE ac.id = ${alias}.jev_category_id AND ac.archived = 0))`;

/**
 * A category Tally guessed and nobody has set. Shown the same way as the row's dashed "Maybe" (the
 * category join in `MAYBE_CATEGORY_COLUMNS`): an active category, and an unsure guess. A credit held for
 * review waits until it is reviewed, as Needs category and Organize leave it out (decision 70). A payment
 * linked to a bill is asked even when excluded, as its row shows the Maybe (`jevAsksAboutSql` keeps the rest out).
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
			WHERE ${categoryAskedSql("t")}`,
		)
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
			label: cardLabel(row),
			sure: confidencePercent(row.categoryConfidence),
			categoryId: row.categoryId,
			category: row.category,
		},
	}));
}

/**
 * New categories: the pending suggestions from Settings, each with its purchases. A store whose "Never
 * suggest" line for a new category is set drops out of the suggestion (pendingSuggestions leaves its rows
 * out), and a suggestion with no store left is not asked at all (decision 101).
 */
async function newCategorySuggestions(
	db: D1Database,
): Promise<{ item: NewCategorySuggestion; order: number }[]> {
	// Every pending suggestion, not only the ten Settings lists: the count covers every kind (decision 101).
	const suggestions = await pendingSuggestions(db, Number.MAX_SAFE_INTEGER);
	if (suggestions.length === 0) return [];
	// The same check Settings makes for its "Add to" button: an active category with the name, as sameName reads it.
	const active = (await categoryNames(db)).filter((c) => !c.archived);
	const ids = suggestions.flatMap((suggestion) =>
		suggestion.rows.map((row) => row.id),
	);
	const { results } = await db
		.prepare(
			`SELECT t.id, ${merchantKeySql("t")} AS merchantKey, m.display_name AS displayName, ${ownNameSql("t")} AS ownName
			FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
			WHERE t.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.all<{
			id: number;
			merchantKey: string;
			displayName: string | null;
			ownName: string | null;
		}>();
	const byId = new Map(results.map((row) => [row.id, row]));
	const items: { item: NewCategorySuggestion; order: number }[] = [];
	for (const suggestion of suggestions) {
		const rows = suggestion.rows.flatMap((row) => {
			const found = byId.get(row.id);
			if (!found) return [];
			return [
				{
					transactionId: row.id,
					date: row.date,
					amountCents: row.amountCents,
					merchantKey: found.merchantKey,
					merchant: merchantLabel(found.displayName, found.merchantKey),
					label: cardLabel(found),
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
		const name = tidyName(suggestion.name);
		items.push({
			order: suggestion.id,
			item: {
				kind: "new_category",
				id: `new-${suggestion.id}`,
				suggestionId: suggestion.id,
				name,
				existing: active.find((c) => sameName(c.name, name))?.name ?? null,
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
	const [income, transfer, category, newCategory, names] = await Promise.all([
		s.income ? incomeSuggestions(db) : [],
		s.categories ? transferSuggestions(db) : [],
		s.categories ? categorySuggestions(db) : [],
		s.categories ? newCategorySuggestions(db) : [],
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
