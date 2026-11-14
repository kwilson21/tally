// The store lookup's text for each merchant key, and whether the key is private (spec §7, "Store lookup": "The lookup text",
// "Never searched"). The decision is pure; the fill reads what it needs in one read, decides in TypeScript, and saves in one
// batch, so a later step can join a transaction to its lookup text and its private mark in SQL (merchant_lookup_texts,
// migration 0074).

import { merchantKeySql } from "../db/merchant-key";
import { askedSql } from "../db/suggestions-queue";
import {
	isPrivatePlaidCategory,
	lookupTextOf,
	privateTextReason,
} from "./lookup-text";

/** What one read gathered for a merchant key, over every one of its transactions. */
export type LookupTextFacts = {
	/** The distinct bank texts of its transactions. */
	rawTexts: string[];
	/** The distinct Plaid categories of its transactions; null for a row Plaid did not categorize. */
	categories: (string | null)[];
	/** True when any of its transactions has flag_transfer, flag_income or flag_reimbursement set. */
	flagged: boolean;
	/** True when any of its transactions has a transfer or income guess in the Maybe range, whether or not a person said No. */
	maybe: boolean;
	/** True when any of its transactions has the transfer kind. */
	transfer: boolean;
	/**
	 * True when any of its transactions is excluded from the budget, whoever or whatever excluded it: a person's Yes on a Maybe
	 * transfer (which sets no flag), an exclusion in the edit panel or in bulk, a Plaid transfer category, or Jev's sure transfer.
	 * Not told apart on purpose: a store wrongly called private is simply not looked up.
	 */
	excluded: boolean;
};

export type LookupTextRow = {
	merchantKey: string;
	lookupText: string;
	private: 0 | 1;
};

/**
 * The row for one merchant key: its lookup text, and private when the key, any of its bank texts, or any of its Plaid
 * categories is private, or any of its transactions is flagged, unanswered as a Maybe, or a transfer.
 */
export function lookupTextRow(
	merchantKey: string,
	facts: LookupTextFacts,
): LookupTextRow {
	const isPrivate =
		privateTextReason(merchantKey) !== null ||
		facts.rawTexts.some((text) => privateTextReason(text) !== null) ||
		facts.categories.some(isPrivatePlaidCategory) ||
		facts.flagged ||
		facts.maybe ||
		facts.transfer ||
		facts.excluded;

	return {
		merchantKey,
		lookupText: lookupTextOf(merchantKey),
		private: isPrivate ? 1 : 0,
	};
}

/**
 * A Maybe is a row whose transfer or income guess is in the Maybe range (askedSql, the review's own range). Whether a person
 * said No to it does not count: a No may be about an older amount, which sync does not clear (src/plaid/sync.ts), so a fresh
 * Maybe in range stays private. A Yes clears the confidence or sets a flag, so it leaves the range.
 */
const MAYBE_IN_RANGE_SQL = `(${askedSql("transfer", "t.transfer_confidence")} OR ${askedSql("income", "t.income_confidence")})`;

/**
 * The facts the decision reads, one row per merchant key over every one of its transactions (cash, hand-entered, Apple Card and
 * split rows included), and `version`: those same facts as JSON text. The read and the save both run this SQL, so a save can
 * compare the version it read with the version as it stands when it writes (saveLookupTexts). Nothing else is read, so the
 * version is built from exactly the facts the decision uses, and needs no assumption about updated_at.
 */
/**
 * One row per merchant key: the distinct values of `column` over the key's rows, as a JSON array in value order (NULL first).
 * The order comes from the ORDER BY inside the subquery, not from the query plan, so the same rows always give the same text.
 */
const sortedDistinctSql = (column: string) =>
	`SELECT k, json_group_array(v) AS list FROM (SELECT DISTINCT ${merchantKeySql("t")} AS k, ${column} AS v FROM transactions t ORDER BY k, v) GROUP BY k`;

/**
 * The version is the decision's facts as one text, with the two lists in sorted order (sortedDistinctSql). The read and the
 * save both run this one fragment, so they cannot drift apart. Exported so a test can check the two paths produce the same text.
 */
export const KEY_VERSIONS_SQL = `SELECT f.merchantKey, f.rawTexts, f.categories, f.flagged, f.maybe, f.transfer, f.excluded,
	json_array(f.flagged, f.maybe, f.transfer, f.excluded, raws.list, cats.list) AS version
FROM (SELECT ${merchantKeySql("t")} AS merchantKey,
		json_group_array(DISTINCT t.raw_name) AS rawTexts,
		json_group_array(DISTINCT t.plaid_category) AS categories,
		MAX(t.flag_transfer = 1 OR t.flag_income = 1 OR t.flag_reimbursement = 1) AS flagged,
		MAX(${MAYBE_IN_RANGE_SQL}) AS maybe,
		MAX(t.kind = 'transfer') AS transfer,
		MAX(t.excluded = 1) AS excluded
	FROM transactions t
	GROUP BY ${merchantKeySql("t")}) f
JOIN (${sortedDistinctSql("t.raw_name")}) raws ON raws.k = f.merchantKey
JOIN (${sortedDistinctSql("t.plaid_category")}) cats ON cats.k = f.merchantKey`;

/** How many keys one upsert statement writes (the JSON rows it binds). */
const KEYS_PER_STATEMENT = 500;

/** What a read decided for each merchant key, with the version it read the key's facts at. */
export type PendingLookupTexts = {
	keys: { row: LookupTextRow; version: string }[];
};

/**
 * One read of every key's facts, decided in TypeScript. Nothing is written. A save (saveLookupTexts) writes what this decided,
 * but only while the key's facts are still the ones it read, so a change in between is never overwritten by an older answer.
 */
export async function readLookupTexts(
	db: D1Database,
): Promise<PendingLookupTexts> {
	const { results } = await db.prepare(KEY_VERSIONS_SQL).all<{
		merchantKey: string;
		rawTexts: string;
		categories: string;
		flagged: number | null;
		maybe: number | null;
		transfer: number | null;
		excluded: number | null;
		version: string;
	}>();

	// SAFETY: json_group_array always returns a JSON array of the column's values, so each parse below is an array of strings or nulls.
	return {
		keys: results.map((row) => ({
			row: lookupTextRow(row.merchantKey, {
				rawTexts: JSON.parse(row.rawTexts) as string[],
				categories: JSON.parse(row.categories) as (string | null)[],
				flagged: row.flagged === 1,
				maybe: row.maybe === 1,
				transfer: row.transfer === 1,
				excluded: row.excluded === 1,
			}),
			version: row.version,
		})),
	};
}

/**
 * Saves a read's decisions in one batch of upserts, KEYS_PER_STATEMENT keys to a statement. A key is written private when the
 * read decided so, and otherwise private only if its facts have changed since the read (the version in the same statement, computed
 * again over the key's current rows): fail closed, so an older read never clears a store a newer change made private. A key
 * with no transaction left is not touched (nothing is deleted here). Returns counts only.
 */
export async function saveLookupTexts(
	db: D1Database,
	pending: PendingLookupTexts,
): Promise<{ keys: number; private: number }> {
	const statements: D1PreparedStatement[] = [];

	for (
		let start = 0;
		start < pending.keys.length;
		start += KEYS_PER_STATEMENT
	) {
		const chunk = pending.keys
			.slice(start, start + KEYS_PER_STATEMENT)
			.map(({ row, version }) => ({
				k: row.merchantKey,
				t: row.lookupText,
				p: row.private,
				v: version,
			}));

		statements.push(
			db
				.prepare(
					`WITH facts AS (${KEY_VERSIONS_SQL})
					INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private)
					SELECT json_extract(j.value, '$.k'), json_extract(j.value, '$.t'),
						CASE WHEN json_extract(j.value, '$.p') = 1 OR facts.version IS NOT json_extract(j.value, '$.v') THEN 1 ELSE 0 END
					FROM json_each(?) AS j JOIN facts ON facts.merchantKey = json_extract(j.value, '$.k')
					WHERE true
					ON CONFLICT(merchant_key) DO UPDATE SET lookup_text = excluded.lookup_text, private = excluded.private`,
				)
				.bind(JSON.stringify(chunk)),
		);
	}

	if (statements.length > 0) await db.batch(statements);

	return {
		keys: pending.keys.length,
		private: pending.keys.filter(({ row }) => row.private === 1).length,
	};
}

/** The whole fill: one read, then the fenced save. */
export async function fillLookupTexts(
	db: D1Database,
): Promise<{ keys: number; private: number }> {
	return saveLookupTexts(db, await readLookupTexts(db));
}
