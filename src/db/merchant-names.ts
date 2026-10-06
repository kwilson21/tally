// Merchant names and their suggestions (spec §5, §7, decision 64): what to ask Workers AI about, where
// its names are kept, and how a person's choice settles a suggestion. Which names to show is decided by
// src/transactions/name-suggestions.ts.
import {
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
 * sent no `merchant_name` for, whose merchant has no name a person chose, no suggestion, and no earlier
 * answer. A cash entry a person typed (on the Cash account) is never asked about, nor a split part. A
 * Plaid id isn't needed, so the demo's seeded bank texts are asked too. A merchant is asked about
 * once, so an answer with no usable name is kept as an empty suggestion.
 */
export async function merchantsToAsk(
	db: D1Database,
	limit: number,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT t.raw_name AS rawName FROM transactions t
			 WHERE t.parent_id IS NULL AND NULLIF(t.merchant_name, '') IS NULL
			   AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'cash')
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
	/**
	 * The row's number, which is what Skip puts in the address, so the bank's text never lands in the
	 * browser's history. It only names a row for as long as the review is open.
	 */
	id: number;
	/** The bank text most of its charges carry, shown as "The bank says". */
	bankText: string;
	/** What the list shows when nothing is chosen: the bank text, tidied. */
	tidied: string;
	/** The suggested names to choose from, never empty. */
	names: string[];
	/** Its charges, a split counted once. */
	count: number;
};

/** Plain code-point order, as the database sorts text, so ties fall the same way everywhere. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The merchants with names waiting for a person (P29 A): pending suggestions that say something the
 * tidied bank text doesn't, for a merchant that still has charges, most charges first. With the names
 * switch off there are none (src/transactions/name-suggestions.ts).
 *
 * A merchant can have several bank texts ("TARGET 1234", "TGT*0099"), and a name that repeats one
 * text's tidied form still reads as a suggestion on the others, as the list shows it. So a merchant
 * is reviewed when any of its texts has a name to offer, and the text shown is the one with the most
 * charges among those; the names are the ones offered against it.
 */
export async function namesToReview(
	db: D1Database,
	switches?: AiSwitches,
): Promise<NameReview[]> {
	const namesOn = (switches ?? (await readAiSwitches(db))).names;
	const { results } = await db
		.prepare(
			`SELECT m.raw_name AS key, m.rowid AS id, m.suggested_name AS stored, t.raw_name AS bankText, COUNT(*) AS count
			 FROM merchants m JOIN transactions t ON ${merchantKeySql("t")} = m.raw_name AND t.parent_id IS NULL
			 WHERE m.suggestion_status = 'pending' AND m.display_name IS NULL AND COALESCE(m.suggested_name, '') != ''
			 GROUP BY m.raw_name, t.raw_name`,
		)
		.all<{
			key: string;
			id: number;
			stored: string;
			bankText: string;
			count: number;
		}>();
	const byKey = new Map<string, typeof results>();
	for (const row of results)
		byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
	const reviews: NameReview[] = [];
	for (const [key, texts] of byKey) {
		const total = texts.reduce((sum, text) => sum + text.count, 0);
		// The text with the most charges first, then A to Z, so the choice is the same every time.
		texts.sort(
			(a, b) => b.count - a.count || compareText(a.bankText, b.bankText),
		);
		for (const text of texts) {
			const names = offeredNames(
				{ stored: text.stored, status: "pending", namesOn },
				text.bankText,
			);
			if (names.length === 0) continue;
			reviews.push({
				key,
				id: text.id,
				bankText: text.bankText,
				tidied: tidyName(text.bankText),
				names,
				count: total,
			});
			break;
		}
	}
	return reviews.sort((a, b) => b.count - a.count || compareText(a.key, b.key));
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
