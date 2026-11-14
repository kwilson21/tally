// The store lookup's text for each merchant key, and whether the key is private (spec §7, "Store lookup": "The lookup text",
// "Never searched"). The decision is pure; fillLookupTexts gathers what it needs in one read and saves it in one batch, so a
// later step can join a transaction to its lookup text and its private mark in SQL (merchant_lookup_texts, migration 0074).

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

/** How many keys one upsert statement writes (the JSON rows it binds). */
const KEYS_PER_STATEMENT = 500;

/**
 * Fills merchant_lookup_texts from every transaction (cash, hand-entered, Apple Card and split rows included): one read
 * grouped by merchant key, decided in TypeScript, and saved in one batch of upserts, KEYS_PER_STATEMENT keys to a statement.
 * A key with no transaction left is not touched (nothing is deleted here). Returns counts only.
 */
export async function fillLookupTexts(
	db: D1Database,
): Promise<{ keys: number; private: number }> {
	const { results } = await db
		.prepare(
			`SELECT ${merchantKeySql("t")} AS merchantKey,
				json_group_array(DISTINCT t.raw_name) AS rawTexts,
				json_group_array(DISTINCT t.plaid_category) AS categories,
				MAX(t.flag_transfer = 1 OR t.flag_income = 1 OR t.flag_reimbursement = 1) AS flagged,
				MAX(${MAYBE_IN_RANGE_SQL}) AS maybe,
				MAX(t.kind = 'transfer') AS transfer,
				MAX(t.excluded = 1) AS excluded
			FROM transactions t
			GROUP BY ${merchantKeySql("t")}`,
		)
		.all<{
			merchantKey: string;
			rawTexts: string;
			categories: string;
			flagged: number | null;
			maybe: number | null;
			transfer: number | null;
			excluded: number | null;
		}>();

	// SAFETY: json_group_array always returns a JSON array of the column's values, so each parse below is an array of strings or nulls.
	const rows = results.map((row) =>
		lookupTextRow(row.merchantKey, {
			rawTexts: JSON.parse(row.rawTexts) as string[],
			categories: JSON.parse(row.categories) as (string | null)[],
			flagged: row.flagged === 1,
			maybe: row.maybe === 1,
			transfer: row.transfer === 1,
			excluded: row.excluded === 1,
		}),
	);

	const statements: D1PreparedStatement[] = [];

	for (let start = 0; start < rows.length; start += KEYS_PER_STATEMENT) {
		const chunk = rows.slice(start, start + KEYS_PER_STATEMENT).map((row) => ({
			k: row.merchantKey,
			t: row.lookupText,
			p: row.private,
		}));

		statements.push(
			db
				.prepare(
					`INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private)
					SELECT json_extract(value, '$.k'), json_extract(value, '$.t'), json_extract(value, '$.p') FROM json_each(?)
					WHERE true
					ON CONFLICT(merchant_key) DO UPDATE SET lookup_text = excluded.lookup_text, private = excluded.private`,
				)
				.bind(JSON.stringify(chunk)),
		);
	}

	if (statements.length > 0) await db.batch(statements);

	return {
		keys: rows.length,
		private: rows.filter((row) => row.private === 1).length,
	};
}
