// Merchant names and their suggestions (spec §5, §7, decision 64): what to ask Workers AI about, where
// its names are kept, and how a person's choice settles a suggestion. Which names to show is decided by
// src/transactions/name-suggestions.ts.

import { householdToday } from "../dates";
import {
	type NameSource,
	nameSource,
	offeredNames,
	storeSuggestedNames,
} from "../transactions/name-suggestions";
import { tidyName } from "../transactions/tidy-name";
import { KEPT_NAME_LOG_SQL } from "./ai-log";
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
 * The bank texts Workers AI is asked about (spec §7), as one predicate over `t` with `merchants m` joined: a text Plaid
 * sent no `merchant_name` for, whose merchant has no name a person chose, no suggestion, and no earlier answer. A cash
 * entry a person typed (on the Cash account) is never asked about, nor a split part, nor an Apple Card row (§8.10: its
 * Merchant is its name, or none is sent). Shared by merchantsToAsk and the night's count of names still waiting
 * (namesStillAsked), so the two can't disagree.
 */
export const NAME_ASKED_SQL = `t.parent_id IS NULL AND NULLIF(t.merchant_name, '') IS NULL
	AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'cash')
	AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.subtype = 'apple_card')
	AND m.display_name IS NULL AND m.suggested_name IS NULL AND COALESCE(m.suggestion_status, 'none') = 'none'`;

/**
 * Suggests each bank name for its merchant, `pending` (spec §8.6, decision 68). One `?`: the names, a JSON array. A
 * merchant a person named, or whose suggestion they decided, is never touched; a guess still waiting gives way. `guard`
 * is the SQL that must hold for the rows to be written: a sync's lock (OWNS_LOCK), or `1` for an upload, which runs
 * in one batch with nothing to lock.
 */
export const suggestBankNamesSql = (guard: string) =>
	`INSERT INTO merchants (raw_name, suggested_name, suggestion_status)
	 SELECT value, value, 'pending' FROM json_each(?) WHERE ${guard}
	 ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name, suggestion_status = 'pending'
	 WHERE merchants.display_name IS NULL AND merchants.suggestion_status IN ('none', 'pending')`;

/**
 * The bank texts to ask Workers AI about, at most `limit` (NAME_ASKED_SQL). A merchant is asked about once, so an answer
 * with no usable name is kept as an empty suggestion. A text whose call failed (`merchant_name_failures`, #468) is still
 * asked, but after the ones never tried, the longest-ago failure first, so texts that keep failing can't hold up the
 * rest. Within each group, most charges first.
 */
export async function merchantsToAsk(
	db: D1Database,
	limit: number,
): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT t.raw_name AS rawName FROM transactions t
			 LEFT JOIN merchants m ON m.raw_name = t.raw_name
			 LEFT JOIN merchant_name_failures f ON f.raw_name = t.raw_name
			 WHERE ${NAME_ASKED_SQL}
			 GROUP BY t.raw_name
			 ORDER BY f.failed_at IS NOT NULL, f.failed_at, COUNT(*) DESC, t.raw_name
			 LIMIT ?`,
		)
		.bind(limit)
		.all<{ rawName: string }>();
	return results.map((row) => row.rawName);
}

/**
 * How many bank texts are still waiting for a name (the night's count, #586): the texts NAME_ASKED_SQL asks about, except
 * one whose call failed (`merchant_name_failures`) counts as done, as the gate counts a failed sort (`jev_failed_at`), so
 * a name that keeps failing never holds the night.
 */
export async function namesStillAsked(db: D1Database): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(DISTINCT t.raw_name) AS n FROM transactions t
			 LEFT JOIN merchants m ON m.raw_name = t.raw_name
			 LEFT JOIN merchant_name_failures f ON f.raw_name = t.raw_name
			 WHERE ${NAME_ASKED_SQL} AND f.raw_name IS NULL`,
		)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Keeps one batch of Workers AI answers and failed calls, as one D1 batch. An answer is pending when there are
 * names, an empty suggestion when there are none (so it isn't asked again), and it lands only on a merchant nobody
 * has named, suggested for or decided about, so late answers are dropped; it also clears its text's failure. A
 * failed call is kept in `merchant_name_failures`, not `merchants`, so a failure never makes a merchant row that
 * sync could copy; the text is asked again on a later night (#468). Returns how many answers came with a name.
 */
export async function saveAskedNames(
	db: D1Database,
	answers: { rawName: string; names: string[] }[],
	failed: string[],
): Promise<number> {
	const statements: D1PreparedStatement[] = [];
	if (answers.length > 0) {
		statements.push(
			db
				.prepare(
					`WITH answers AS (
						SELECT json_extract(value, '$.rawName') AS rawName,
							json_extract(value, '$.suggestedName') AS suggestedName,
							json_extract(value, '$.status') AS status
						FROM json_each(?)
					)
					INSERT INTO merchants (raw_name, suggested_name, suggestion_status)
					SELECT rawName, suggestedName, status FROM answers WHERE 1
					 ON CONFLICT(raw_name) DO UPDATE SET suggested_name = excluded.suggested_name, suggestion_status = excluded.suggestion_status
					 WHERE merchants.display_name IS NULL AND merchants.suggestion_status = 'none' AND merchants.suggested_name IS NULL
					 RETURNING suggested_name`,
				)
				.bind(
					JSON.stringify(
						answers.map(({ rawName, names }) => ({
							rawName,
							suggestedName: storeSuggestedNames(names),
							status: names.length > 0 ? "pending" : "none",
						})),
					),
				),
		);
	}
	if (failed.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO merchant_name_failures (raw_name, failed_at)
					 SELECT value, datetime('now') FROM json_each(?) WHERE 1
					 ON CONFLICT(raw_name) DO UPDATE SET failed_at = excluded.failed_at`,
				)
				.bind(JSON.stringify(failed)),
		);
	}
	if (answers.length > 0) {
		statements.push(
			db
				.prepare(
					"DELETE FROM merchant_name_failures WHERE raw_name IN (SELECT value FROM json_each(?))",
				)
				.bind(JSON.stringify(answers.map(({ rawName }) => rawName))),
		);
	}
	if (statements.length === 0) return 0;
	const [saved] = await db.batch<{ suggested_name: string | null }>(statements);
	// The answers' upsert is the batch's first statement, so it is the one with rows to count.
	if (answers.length === 0 || !saved) return 0;
	return saved.results.filter((row) => Boolean(row.suggested_name)).length;
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
	/** Where they came from: the bank sent Plaid's name, or Tally guessed (P87 B). */
	source: NameSource;
	/** Its charges, a split counted once. */
	count: number;
	/**
	 * Its charges that keep a name of their own when the merchant is named. A split purchase counts as changed even when
	 * every part has its own name: its parent row and each part's 'Split from' caption show the store's name.
	 */
	owned: number;
};

/** Plain code-point order, as the database sorts text, so ties fall the same way everywhere. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The merchants with names waiting for a person (P29 A): pending suggestions that say something the
 * tidied bank text doesn't, for a merchant that still has charges, most charges first. With the names
 * switch off only the bank's own names are left, Tally's guesses being hidden (src/transactions/name-suggestions.ts).
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
			`SELECT m.raw_name AS key, m.rowid AS id, m.suggested_name AS stored, t.raw_name AS bankText, COUNT(*) AS count,
				SUM(t.own_name IS NOT NULL) AS owned
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
			owned: number;
		}>();
	const byKey = new Map<string, typeof results>();
	for (const row of results) {
		const texts = byKey.get(row.key);
		if (texts) texts.push(row);
		else byKey.set(row.key, [row]);
	}
	const reviews: NameReview[] = [];
	for (const [key, texts] of byKey) {
		const total = texts.reduce((sum, text) => sum + text.count, 0);
		const owned = texts.reduce((sum, text) => sum + text.owned, 0);
		// The text with the most charges first, then A to Z, so the choice is the same every time.
		texts.sort(
			(a, b) => b.count - a.count || compareText(a.bankText, b.bankText),
		);
		for (const text of texts) {
			const names = offeredNames(
				{ stored: text.stored, status: "pending", key, namesOn },
				text.bankText,
			);
			if (names.length === 0) continue;
			reviews.push({
				key,
				id: text.id,
				bankText: text.bankText,
				tidied: tidyName(text.bankText),
				names,
				source: nameSource(names, key),
				count: total,
				owned,
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
	const update =
		choice.kind === "keep"
			? db
					.prepare(
						"UPDATE merchants SET suggestion_status = 'rejected' WHERE raw_name = ? AND suggestion_status = 'pending' AND display_name IS NULL",
					)
					.bind(key)
			: db
					.prepare(
						`UPDATE merchants SET display_name = ?1,
							suggestion_status = CASE WHEN instr(char(10) || COALESCE(suggested_name, '') || char(10), char(10) || ?1 || char(10)) > 0 THEN 'accepted' ELSE 'rejected' END
						 WHERE raw_name = ?2 AND suggestion_status = 'pending' AND display_name IS NULL`,
					)
					.bind(choice.name, key);
	// A guessed name a person keeps is logged first, while the suggestion is still pending (spec §8.6).
	if (choice.kind === "keep" || nameSource([choice.name], key) !== "tally") {
		const result = await update.run();
		return result.meta.changes > 0;
	}
	const [, result] = await db.batch([
		db
			.prepare(KEPT_NAME_LOG_SQL)
			.bind(await householdToday(db), key, choice.name),
		update,
	]);
	return (result?.meta.changes ?? 0) > 0;
}

/**
 * The display names the merchants table has for these raw merchant keys, one query: a key with no row (or no display name)
 * maps to null. The ledger and the first week's lines name a merchant with this, falling back to tidyName.
 */
export async function merchantDisplayNames(
	db: D1Database,
	keys: string[],
): Promise<Map<string, string | null>> {
	if (keys.length === 0) return new Map();
	const { results } = await db
		.prepare(
			"SELECT raw_name AS key, display_name AS displayName FROM merchants WHERE raw_name IN (SELECT value FROM json_each(?1))",
		)
		.bind(JSON.stringify(keys))
		.all<{ key: string; displayName: string | null }>();
	return new Map(results.map((row) => [row.key, row.displayName]));
}
