// Merchant names and their suggestions (spec §5, §7, decision 64): what to ask Workers AI about, where
// its names are kept, and how a person's choice settles a suggestion. Which names to show is decided by
// src/transactions/name-suggestions.ts.
import {
	type NameSource,
	nameSource,
	offeredNames,
	storeSuggestedNames,
} from "../transactions/name-suggestions";
import { tidyName } from "../transactions/tidy-name";
import { type AiSwitches, readAiSwitches } from "./ai-switches";
import { merchantKeySql } from "./merchant-key";

/**
 * The part of an upsert into `merchants` that settles a pending suggestion when a person names the
 * merchant (`excluded.display_name` is the name they gave): `accepted` when it is one of the suggested
 * names, `rejected` when it is their own. Nothing changes when no name is given, or when the
 * merchant has no suggestion waiting. Used inside `ON CONFLICT(raw_name) DO UPDATE SET …`.
 */
export const SETTLE_SUGGESTION_SQL = `suggestion_status = CASE
	WHEN merchants.suggestion_status != 'pending' OR excluded.display_name IS NULL THEN merchants.suggestion_status
	WHEN instr(char(10) || COALESCE(merchants.suggested_name, '') || char(10), char(10) || excluded.display_name || char(10)) > 0 THEN 'accepted'
	ELSE 'rejected' END`;

/**
 * The bank texts to ask Workers AI about, most charges first, at most `limit` (spec §7): a text Plaid
 * didn't name on a charge Plaid sent (never a hand-entered cash one), whose merchant has no name a
 * person chose, no suggestion, and no earlier answer. A merchant is asked about once, so an answer with
 * no usable name is kept as an empty suggestion.
 */
export async function merchantsToAsk(
	db: D1Database,
	limit: number,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT t.raw_name AS rawName FROM transactions t
			 WHERE t.parent_id IS NULL AND t.plaid_transaction_id IS NOT NULL AND NULLIF(t.merchant_name, '') IS NULL
			   AND NOT EXISTS (
				SELECT 1 FROM merchants m WHERE m.raw_name = t.raw_name
				  AND (m.display_name IS NOT NULL OR m.suggested_name IS NOT NULL OR m.suggestion_status != 'none'))
			 GROUP BY t.raw_name
			 ORDER BY COUNT(*) DESC, t.raw_name
			 LIMIT ?`,
		)
		.bind(limit)
		.all<{ rawName: string }>();
	return results.map((row) => row.rawName);
}

/**
 * Keeps the names Workers AI gave for a bank text: pending when there are any, an empty suggestion
 * when there are none (so it isn't asked again). Only a merchant nobody has named, suggested for or
 * decided about takes them, so an answer that arrives after a person named it is dropped.
 */
export async function saveAskedNames(
	db: D1Database,
	key: string,
	names: string[],
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, ?)
			 ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name, suggestion_status = excluded.suggestion_status
			 WHERE merchants.display_name IS NULL AND merchants.suggestion_status = 'none' AND merchants.suggested_name IS NULL`,
		)
		.bind(
			key,
			storeSuggestedNames(names),
			names.length > 0 ? "pending" : "none",
		)
		.run();
	return result.meta.changes > 0;
}

export type NameReview = {
	/** The merchant's key: the `merchants` row to settle. */
	key: string;
	/** The bank text most of its charges carry, shown as "The bank says". */
	bankText: string;
	/** What the list shows when nothing is chosen: the bank text, tidied. */
	tidied: string;
	/** The suggested names to choose from, never empty. */
	names: string[];
	/** Where they came from: the bank sent Plaid's name, or Tally guessed (P87 B). */
	source: NameSource;
	/** Its charges, a split counted once. */
	count: number;
};

/**
 * The merchants with names waiting for a person (P29 A): pending suggestions that say something the
 * tidied bank text doesn't, for a merchant that still has charges, most charges first. With the names
 * switch off only the bank's own names are left, Tally's guesses being hidden (src/transactions/name-suggestions.ts).
 */
export async function namesToReview(
	db: D1Database,
	switches?: AiSwitches,
): Promise<NameReview[]> {
	const namesOn = (switches ?? (await readAiSwitches(db))).names;
	const key = merchantKeySql("t");
	const { results } = await db
		.prepare(
			`SELECT m.raw_name AS key, m.suggested_name AS stored, COUNT(*) AS count,
				(SELECT x.raw_name FROM transactions x WHERE ${merchantKeySql("x")} = m.raw_name AND x.parent_id IS NULL
				 GROUP BY x.raw_name ORDER BY COUNT(*) DESC, x.raw_name LIMIT 1) AS bankText
			 FROM merchants m JOIN transactions t ON ${key} = m.raw_name AND t.parent_id IS NULL
			 WHERE m.suggestion_status = 'pending' AND m.display_name IS NULL AND COALESCE(m.suggested_name, '') != ''
			 GROUP BY m.raw_name
			 ORDER BY count DESC, m.raw_name`,
		)
		.all<{ key: string; stored: string; count: number; bankText: string }>();
	const reviews: NameReview[] = [];
	for (const row of results) {
		const names = offeredNames(
			{ stored: row.stored, status: "pending", key: row.key, namesOn },
			row.bankText,
		);
		if (names.length === 0) continue;
		reviews.push({
			key: row.key,
			bankText: row.bankText,
			tidied: tidyName(row.bankText),
			names,
			source: nameSource(names, row.key),
			count: row.count,
		});
	}
	return reviews;
}

/** What a person picked for one merchant in the review. */
export type NameChoice =
	| { kind: "name"; name: string }
	/** "Keep the bank's": the tidied bank text stays, and the merchant isn't suggested names again. */
	| { kind: "keep" };

/**
 * Settles one merchant's pending suggestion with a person's choice: the name they picked or typed
 * becomes `display_name` (`accepted` when it is one of the suggestions, otherwise `rejected`), or
 * keeping the bank's name leaves `display_name` empty and turns the suggestion down. Nothing happens
 * unless the suggestion is still waiting and the merchant still has no chosen name, so a stale form
 * can't overwrite a name chosen elsewhere. Returns whether anything was settled.
 */
export async function settleSuggestion(
	db: D1Database,
	key: string,
	choice: NameChoice,
): Promise<boolean> {
	const result =
		choice.kind === "keep"
			? await db
					.prepare(
						"UPDATE merchants SET suggestion_status = 'rejected' WHERE raw_name = ? AND suggestion_status = 'pending' AND display_name IS NULL",
					)
					.bind(key)
					.run()
			: await db
					.prepare(
						`UPDATE merchants SET display_name = ?1,
							suggestion_status = CASE WHEN instr(char(10) || COALESCE(suggested_name, '') || char(10), char(10) || ?1 || char(10)) > 0 THEN 'accepted' ELSE 'rejected' END
						 WHERE raw_name = ?2 AND suggestion_status = 'pending' AND display_name IS NULL`,
					)
					.bind(choice.name, key)
					.run();
	return result.meta.changes > 0;
}
