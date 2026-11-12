// Merchant names and their suggestions (spec §5, §7, decision 64): what to ask Workers AI about, where
// its names are kept, and how a person's choice settles a suggestion. Which names to show is decided by
// src/transactions/name-suggestions.ts.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import { householdToday } from "../dates";
import {
	answerNameSuggestion,
	type NameFacts,
	type NameRequest,
	type NameWrite,
} from "../rules/suggestions";
import {
	type NameSource,
	nameSource,
	normaliseNames,
	offeredNames,
} from "../transactions/name-suggestions";
import { tidyName } from "../transactions/tidy-name";
import { KEPT_NAME_LOG_SQL } from "./ai-log";
import { type AiSwitches, readAiSwitches } from "./ai-switches";
import { Database, runWith } from "./database";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";
import { merchantKeySql, merchantNamesJsonSql } from "./merchant-key";
import { merchants } from "./schema";

/**
 * What a name's text is trimmed of in SQL: spaces, tab and CR, the set the table's CHECK and the backfill use
 * (migrations/0071_merchant_suggested_names.sql). Other Unicode spaces are kept here, though the JS side trims them.
 */
export const NAME_TRIM_SQL = "' ' || char(9) || char(13)";

/**
 * The part of an upsert into `merchants` that settles a pending suggestion when a person names the
 * merchant (`excluded.display_name` is the name they gave): `accepted` when it is one of the suggested
 * names, `rejected` when it is their own. Nothing changes when no name is given, or when the
 * merchant has no suggestion waiting. Used inside `ON CONFLICT(raw_name) DO UPDATE SET …`.
 */
export const SETTLE_SUGGESTION_SQL = `suggestion_status = CASE
	WHEN merchants.suggestion_status != 'pending' OR excluded.display_name IS NULL THEN merchants.suggestion_status
	WHEN EXISTS (SELECT 1 FROM merchant_suggested_names n WHERE n.merchant_key = merchants.raw_name AND n.name = excluded.display_name) THEN 'accepted'
	ELSE 'rejected' END`;

/**
 * The bank texts Workers AI is asked about (spec §7), as one predicate over `t` with `merchants m` joined: a text Plaid
 * sent no `merchant_name` for, whose merchant has no name a person chose, no suggestion, and no earlier answer
 * (`names_asked`). A cash entry a person typed (on the Cash account) is never asked about, nor a split part, nor an
 * Apple Card row (§8.10: its Merchant is its name, or none is sent). merchantsToAsk is the one that reads it.
 */
export const NAME_ASKED_SQL = `t.parent_id IS NULL AND NULLIF(t.merchant_name, '') IS NULL
	AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'cash')
	AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.subtype = 'apple_card')
	AND m.display_name IS NULL AND COALESCE(m.names_asked, 0) = 0 AND COALESCE(m.suggestion_status, 'none') = 'none'`;

/**
 * Suggests bank-sent names for their merchants, `pending` (spec §8.6, decision 68): the merchant rows first, then their
 * names, as the statements of one batch, in this order. A merchant a person named, or whose suggestion they decided, is
 * never touched; a guess still waiting gives way (its names are replaced). `names` are the bank's texts (a blank one is
 * skipped). `guard` is the SQL that must hold for any of the rows to be written: a sync's lock (OWNS_LOCK, bound with
 * `guardBinds`), or `1` for an upload, which runs in one batch with nothing to lock. Callers must run all of them.
 */
export function suggestBankNames(
	db: D1Database,
	names: readonly string[],
	guard: string,
	guardBinds: readonly (string | number)[],
): D1PreparedStatement[] {
	return pendingNameStatements(
		db,
		"SELECT value FROM json_each(?)",
		[JSON.stringify(names)],
		guard,
		guardBinds,
	);
}

/**
 * The statements that make `candidates` waiting suggestions, in the order they run (spec §8.6, decision 68): the merchant
 * rows first, then their names, the same for a bank's names (suggestBankNames) and the newest Plaid names (sync). `candidates`
 * is a SELECT with one column, `value`, the merchant keys, which are also their names; `binds` are its `?`s. A key is
 * a candidate only when its name is not blank. A merchant a person named, or whose suggestion they decided, is never
 * touched; a guess still waiting gives way (its names are replaced). `guard` is the SQL that must hold for any of the
 * rows to be written: a sync's lock (OWNS_LOCK, bound with `guardBinds`), or `1` for an upload, which runs in one batch
 * with nothing to lock. Callers must run all of them.
 */
export function pendingNameStatements(
	db: D1Database,
	candidates: string,
	binds: readonly unknown[],
	guard: string,
	guardBinds: readonly unknown[],
): D1PreparedStatement[] {
	// Every statement reads the candidates first, then the guard's binds.
	const all = [...binds, ...guardBinds];
	const from = `(${candidates}) AS c`;
	// A key is usable only when it is its own trimmed name and not empty: a padded key would be stored under the padded
	// text while its name is trimmed, so the bank's-own-name test (name = key) could never match it.
	const usable = `c.value = trim(c.value, ${NAME_TRIM_SQL}) AND c.value <> ''`;
	const waiting = `(SELECT raw_name FROM merchants WHERE display_name IS NULL AND suggestion_status = 'pending')`;

	return [
		db
			.prepare(
				`INSERT INTO merchants (raw_name, suggestion_status, names_asked)
				 SELECT c.value, 'pending', 0 FROM ${from} WHERE ${usable} AND ${guard}
				 ON CONFLICT(raw_name) DO UPDATE SET suggestion_status = 'pending', names_asked = 0
				 WHERE merchants.display_name IS NULL AND merchants.suggestion_status IN ('none', 'pending')`,
			)
			.bind(...all),
		db
			.prepare(
				`DELETE FROM merchant_suggested_names
				 WHERE merchant_key IN (SELECT c.value FROM ${from} WHERE ${usable})
				   AND merchant_key IN ${waiting} AND ${guard}`,
			)
			.bind(...all),
		db
			.prepare(
				`INSERT INTO merchant_suggested_names (merchant_key, position, name)
				 SELECT c.value, 0, trim(c.value, ${NAME_TRIM_SQL}) FROM ${from}
				 WHERE ${usable} AND c.value IN ${waiting} AND ${guard}`,
			)
			.bind(...all),
	];
}

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
 * Keeps one batch of Workers AI answers and failed calls, as one D1 batch. An answer is pending when it has usable names
 * (normaliseNames), and an empty answer otherwise (`names_asked`, so it isn't asked again). The first answer for a text
 * is the one kept, and it lands only on a merchant nobody has named, suggested for or decided about (`names_asked = 0`
 * and no other status), so late answers are dropped; it also clears its text's failure. The merchant row is written
 * first and its names after, in the same batch: the names only for a merchant that this batch left pending with no
 * names yet. A failed call is kept in `merchant_name_failures`, not `merchants`, so a failure never makes a merchant
 * row that sync could copy; the text is asked again on a later night (#468). Returns how many answers came with a name.
 */
export async function saveAskedNames(
	db: D1Database,
	answers: { rawName: string; names: string[] }[],
	failed: string[],
): Promise<number> {
	const statements: D1PreparedStatement[] = [];
	const firstByText = new Map<string, { rawName: string; names: string[] }>();

	// The key is kept exactly as the bank text is (a padded text has its own row, as merchantsToAsk asked it): only the names
	// are trimmed. An empty key is refused. Padded bank-sent names are skipped in pendingNameStatements, where a name must
	// equal its key.
	for (const answer of answers)
		if (answer.rawName !== "" && !firstByText.has(answer.rawName))
			firstByText.set(answer.rawName, answer);

	const kept = [...firstByText.values()].map(({ rawName, names }) => {
		const usable = normaliseNames(names);

		return {
			rawName,
			names: usable,
			status: usable.length > 0 ? "pending" : "none",
		};
	});

	if (kept.length > 0) {
		const json = JSON.stringify(kept);
		statements.push(
			db
				.prepare(
					`INSERT INTO merchants (raw_name, suggestion_status, names_asked)
					 SELECT json_extract(value, '$.rawName'), json_extract(value, '$.status'),
						CASE WHEN json_extract(value, '$.status') = 'pending' THEN 0 ELSE 1 END
					 FROM json_each(?) WHERE 1
					 ON CONFLICT(raw_name) DO UPDATE SET suggestion_status = excluded.suggestion_status, names_asked = excluded.names_asked
					 WHERE merchants.display_name IS NULL AND merchants.suggestion_status = 'none' AND merchants.names_asked = 0
					 RETURNING raw_name, suggestion_status`,
				)
				.bind(json),
		);
		statements.push(
			db
				.prepare(
					`INSERT INTO merchant_suggested_names (merchant_key, position, name)
					 SELECT m.raw_name, n.key, trim(n.value, ${NAME_TRIM_SQL})
					 FROM json_each(?) AS a
					 JOIN merchants m ON m.raw_name = json_extract(a.value, '$.rawName')
					 JOIN json_each(a.value, '$.names') AS n
					 WHERE m.display_name IS NULL AND m.suggestion_status = 'pending'
					   AND NOT EXISTS (SELECT 1 FROM merchant_suggested_names x WHERE x.merchant_key = m.raw_name)
					   AND trim(n.value, ${NAME_TRIM_SQL}) <> ''`,
				)
				.bind(json),
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

	const [saved] = await db.batch<{
		raw_name: string;
		suggestion_status: string;
	}>(statements);

	// The answers' upsert is the batch's first statement: its RETURNING rows are the merchants it left pending.
	if (kept.length === 0 || !saved) return 0;

	return saved.results.filter((row) => row.suggestion_status === "pending")
		.length;
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
			`SELECT m.raw_name AS key, m.rowid AS id, ${merchantNamesJsonSql("m.raw_name")} AS stored, t.raw_name AS bankText, COUNT(*) AS count,
				SUM(t.own_name IS NOT NULL) AS owned
			 FROM merchants m JOIN transactions t ON ${merchantKeySql("t")} = m.raw_name AND t.parent_id IS NULL
			 WHERE m.suggestion_status = 'pending' AND m.display_name IS NULL
			   AND EXISTS (SELECT 1 FROM merchant_suggested_names n WHERE n.merchant_key = m.raw_name)
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

/** The names offered for the merchant ?1, in the order they are stored, as one text. Each is in hex, so no name can look like the marks between them. */
const OFFERED_NAMES = `COALESCE((SELECT group_concat(hex(name), '|') FROM (SELECT name FROM merchant_suggested_names
	WHERE merchant_key = ?1 ORDER BY position)), '')`;

/** Everything the name rule reads as one text, as SQL: the merchant's status, whether a person named it, and the offered names. */
const NAME_VERSION = `(COALESCE((SELECT suggestion_status || ':' || names_asked || ':' || (display_name IS NOT NULL)
	FROM merchants WHERE raw_name = ?1), 'none') || '/' || ${OFFERED_NAMES})`;

/** What the name rule reads about a merchant, with its version, in one batch. */
export async function nameFacts(
	db: D1Database,
	key: string,
): Promise<NameFacts> {
	// SAFETY: the batch below lists exactly three statements, so its results are the three D1Results typed here. A batch
	// is one transaction, so the version is of the very rows read beside it.
	const [merchant, names, version] = (await db.batch([
		db
			.prepare(
				"SELECT suggestion_status AS status, names_asked AS namesAsked, display_name IS NOT NULL AS named FROM merchants WHERE raw_name = ?1",
			)
			.bind(key),
		db
			.prepare(
				"SELECT name FROM merchant_suggested_names WHERE merchant_key = ?1 ORDER BY position",
			)
			.bind(key),
		db.prepare(`SELECT ${NAME_VERSION} AS version`).bind(key),
	])) as [
		D1Result<{ status: string; namesAsked: number; named: number }>,
		D1Result<{ name: string }>,
		D1Result<{ version: string }>,
	];

	const row = merchant.results[0];

	return {
		suggestion: row
			? {
					status: row.status,
					namesAsked: row.namesAsked === 1,
					names: names.results.map((n) => n.name),
				}
			: null,
		named: row?.named === 1,
		version: version.results[0]?.version ?? "",
	};
}

/**
 * The name answer's save, one batch. A guessed name a person keeps is logged first, while the suggestion is still
 * pending (spec §8.6); the log statement checks that itself. The update is the guard as well (decision 190): it lands only while the merchant and its offered
 * names are still as the rule read them.
 */
export const nameStatements = (db: D1Database, save: NameWrite) => [
	...(save.logKeptGuess
		? [
				db
					.prepare(KEPT_NAME_LOG_SQL)
					.bind(save.today, save.merchantKey, save.displayName),
			]
		: []),
	db
		.prepare(
			`UPDATE merchants SET display_name = COALESCE(?2, display_name), suggestion_status = ?3
			WHERE raw_name = ?1 AND ${NAME_VERSION} IS ?4`,
		)
		.bind(
			save.merchantKey,
			save.displayName,
			save.status,
			save.expectedVersion,
		),
];

/**
 * Reads the merchant's suggestion, asks the rule and saves what it decides in one batch. When the update finds the rows
 * changed since the read, the rule is asked again on the fresh rows (decideAndSave).
 */
export const decideName = <E>(
	nameRule: {
		decide: (
			request: NameRequest,
			facts: NameFacts,
		) => Effect.Effect<Option.Option<NameWrite>, E>;
	},
	request: NameRequest,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() => nameFacts(db, request.merchantKey)),
			decide: (facts) => nameRule.decide(request, facts),
			save: (write) =>
				Effect.promise(() => db.batch(nameStatements(db, write))).pipe(
					Effect.filterOrFail(
						(results) => (results.at(-1)?.meta.changes ?? 0) > 0,
						() => new ChangedSinceRead(),
					),
				),
			gaveUp:
				"A merchant's name kept changing while an answer was being saved.",
		});
	});

/**
 * Settles one merchant's pending suggestion with a person's choice, as the rule decides it: true when it was settled,
 * false when the rule refuses because the suggestion is no longer waiting or the merchant already has a chosen name.
 */
export const settleSuggestion = async (
	db: D1Database,
	key: string,
	choice: NameChoice,
): Promise<boolean> =>
	runWith(
		db,
		decideName(answerNameSuggestion, {
			merchantKey: key,
			choice,
			today: await householdToday(db),
		}).pipe(
			Effect.as(true),
			Effect.catchTag("AlreadyAnswered", () => Effect.succeed(false)),
		),
	);

/**
 * The display names the merchants table has for these raw merchant keys, one query: a key whose row has no display name
 * maps to null, and a key with no row is not in the Map. The ledger and the first week's lines name a merchant with this,
 * falling back to tidyName.
 */
export async function merchantDisplayNames(
	db: D1Database,
	keys: string[],
): Promise<Map<string, string | null>> {
	if (keys.length === 0) return new Map();

	// json_each takes the whole list as one bound value: D1 allows only 100 bound values in a statement.
	const rows = await drizzle(db)
		.select({ key: merchants.rawName, displayName: merchants.displayName })
		.from(merchants)
		.where(
			sql`${merchants.rawName} IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`,
		)
		.all();

	return new Map(rows.map((row) => [row.key, row.displayName]));
}
