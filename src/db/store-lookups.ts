// The store lookup's stored state (spec §7, "Store lookup"): reads of `merchant_lookups`, and the guarded statements that
// claim a store, skip a private one, save a line or "nothing found", count a failure and let a claim go. Every write is
// guarded by the stored row's state, so a statement lands only where the machine (store-lookup.ts) allows its move, and
// a claim also takes one search from the day's count in the same batch (lookup-calls.ts). Times are bound from the
// caller's instant, never datetime('now'), so a fake clock can run a lease out. Nothing here logs.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
	LOOKUP_LEASE_MS,
	type StoreLookupRow,
	storeLookupState,
} from "../machines/store-lookup";
import { STILL_ON_SQL, stillOnKeys } from "./ai-switches";
import {
	dropOldLookupCallsStatement,
	lookupCallsKey,
	takeSearchStatement,
} from "./lookup-calls";
import { merchantLookups } from "./schema";
import { lineGuessSql } from "./suggestions-queue";

/** A stored lookup as the run reads it: its state's fields, its text, and how many searches have failed in a row. */
export type StoredLookup = StoreLookupRow & {
	lookupText: string;
	attempts: number;
};

/** The switches a claim and a save are guarded by: every switch the lookup's search and its Jev question rely on. */
export const SWITCHES_ON = stillOnKeys({
	lookupStores: true,
	categories: true,
	income: true,
});

/** The most texts one skip statement carries. */
const SKIP_TEXTS_PER_STATEMENT = 500;

const LOOKUP_COLUMNS = {
	lookupText: merchantLookups.lookupText,
	status: merchantLookups.status,
	claimedBy: merchantLookups.claimedBy,
	claimedAt: merchantLookups.claimedAt,
	attempts: merchantLookups.attempts,
};

/** Every stored lookup, keyed by its lookup text. */
export async function readLookups(
	db: D1Database,
): Promise<Map<string, StoredLookup>> {
	const rows = await drizzle(db).select(LOOKUP_COLUMNS).from(merchantLookups);

	return new Map(rows.map((row) => [row.lookupText, row] as const));
}

/** One stored lookup by its text, or null when no row exists. */
export async function readLookup(
	db: D1Database,
	text: string,
): Promise<StoredLookup | null> {
	const row = await drizzle(db)
		.select(LOOKUP_COLUMNS)
		.from(merchantLookups)
		.where(eq(merchantLookups.lookupText, text))
		.get();

	return row ?? null;
}

/** The instant a lease was claimed before, past which another run may take the search (store-lookup.ts). */
export const leaseCutoff = (nowMs: number) =>
	new Date(nowMs - LOOKUP_LEASE_MS).toISOString();

/** True when the row is claimed by `token` and its lease is still running at `now`. */
export function holdsClaim(
	row: StoredLookup | null,
	token: string,
	now: Date,
): boolean {
	return (
		row !== null &&
		row.claimedBy === token &&
		storeLookupState(row, now) === "claimed"
	);
}

/**
 * The claim of one store, as three statements in this order: drop the days before, claim the store, take one search.
 * The claim lands only while the store is none or to_retry, every switch is still on, and the day's count is under the
 * cap; the take then adds one to the count. The three share one batch, so a claim and its take are never split, and
 * nothing that changes rows sits between the claim and the take (it reads changes() of the claim).
 */
export function claimStatements(
	db: D1Database,
	{
		text,
		token,
		nowMs,
		day,
		cap,
	}: { text: string; token: string; nowMs: number; day: string; cap: number },
): D1PreparedStatement[] {
	const claim = db
		// stays raw: an upsert guarded by the stored row's state, the switches and the day's count, batched with the count's statements.
		.prepare(
			`INSERT INTO merchant_lookups (lookup_text, status, attempts, claimed_by, claimed_at)
			SELECT ?, 'pending', 0, ?, ?
			WHERE COALESCE((SELECT CAST(value AS INTEGER) FROM household_settings WHERE key = ?), 0) < ?
				AND ${STILL_ON_SQL}
			ON CONFLICT(lookup_text) DO UPDATE SET claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at
			WHERE merchant_lookups.status = 'pending' AND (merchant_lookups.claimed_by IS NULL
				OR merchant_lookups.claimed_at IS NULL OR merchant_lookups.claimed_at <= ?)`,
		)
		.bind(
			text,
			token,
			new Date(nowMs).toISOString(),
			lookupCallsKey(day),
			cap,
			SWITCHES_ON,
			leaseCutoff(nowMs),
		);

	return [
		dropOldLookupCallsStatement(db, day),
		claim,
		takeSearchStatement(db, day),
	];
}

/**
 * The unique texts, in chunks of at most SKIP_TEXTS_PER_STATEMENT, each as the JSON array a statement's json_each reads. A set
 * with no cap, so one statement per chunk (decision 209, point 2). The skip and the line drop both batch these chunks.
 */
function textChunks(texts: readonly string[]): string[] {
	const unique = [...new Set(texts)];
	const chunks: string[] = [];

	for (
		let start = 0;
		start < unique.length;
		start += SKIP_TEXTS_PER_STATEMENT
	) {
		chunks.push(
			JSON.stringify(unique.slice(start, start + SKIP_TEXTS_PER_STATEMENT)),
		);
	}

	return chunks;
}

/**
 * Skips texts that are private: none, to_retry and found become skipped (a found line is dropped). A live claim and the
 * final states are untouched. A set with no cap, so it is one statement per 500 texts, each guarded by the stored row's
 * state (decision 209, point 2).
 */
export function skipStatements(
	db: D1Database,
	texts: readonly string[],
	nowMs: number,
): D1PreparedStatement[] {
	const cutoff = leaseCutoff(nowMs);

	return textChunks(texts).map((json) =>
		db
			// stays raw: a set with no cap (decision 209, point 2), guarded by each stored row's state.
			.prepare(
				`INSERT INTO merchant_lookups (lookup_text, status, attempts) SELECT value, 'skipped', 0 FROM json_each(?) WHERE true
				ON CONFLICT(lookup_text) DO UPDATE SET status = 'skipped', line = NULL, claimed_by = NULL, claimed_at = NULL
				WHERE merchant_lookups.status = 'found' OR (merchant_lookups.status = 'pending' AND (merchant_lookups.claimed_by IS NULL
					OR merchant_lookups.claimed_at IS NULL OR merchant_lookups.claimed_at <= ?))`,
			)
			.bind(json, cutoff),
	);
}

/** What a row's line-backed guess is cleared to, so the next sort asks it again without the line (spec §7). Migration 0079 runs the same. */
export const LINE_GUESS_CLEAR =
	"category_confidence = NULL, jev_category_id = NULL, jev_mixed = NULL, jev_also_category_id = NULL, jev_none_fit = 0";

/** Ends the lookup_answers rows it reaches, so none counts any more (spec §5). The kept = 1 guard keeps a no-op out of meta.changes. */
export const KEPT_OFF = "UPDATE lookup_answers SET kept = 0 WHERE kept = 1";

/**
 * Drops the line from every row of these texts: a row that still holds its kept line-backed guess has it cleared, then
 * no lookup_answers row of the texts counts any more. Then the names Workers AI guessed for the texts' keys are withdrawn
 * (the machine's WITHDRAW), so the next night asks them again without the line (spec §7:247). Four statements per 500 texts, the
 * clear first, since it reads kept = 1, and the withdraw before the sweep, which reads the withdrawn status.
 * The privacy skip (claimNext, #1040) and "Don't use this" (#988) batch it with their own status change.
 */
export function dropLineStatements(
	db: D1Database,
	texts: readonly string[],
): D1PreparedStatement[] {
	return textChunks(texts).flatMap((json) => [
		db
			// stays raw: a set with no cap (decision 209); the same clear as migration 0079's trigger (its drift test).
			.prepare(
				`UPDATE transactions SET ${LINE_GUESS_CLEAR}
				WHERE id IN (SELECT sib.transaction_id FROM lookup_answers sib WHERE sib.lookup_text IN (SELECT value FROM json_each(?)))
					AND ${lineGuessSql("transactions")}`,
			)
			.bind(json),
		db
			// stays raw: a set with no cap (decision 209); the same ends as migration 0079's trigger (its drift test).
			.prepare(
				`${KEPT_OFF} AND lookup_text IN (SELECT value FROM json_each(?))`,
			)
			.bind(json),
		db
			// stays raw: a set with no cap (decision 209); the machine's WITHDRAW for a waiting guess, a name that is not its key.
			// Accepted gap (#987): a guess that sync copied to a Plaid-named key with a different lookup text is not withdrawn here.
			.prepare(
				`UPDATE merchants SET suggestion_status = 'none', names_asked = 0
				WHERE suggestion_status = 'pending' AND display_name IS NULL
				  AND raw_name IN (SELECT k.merchant_key FROM merchant_lookup_texts k WHERE k.lookup_text IN (SELECT value FROM json_each(?)))
				  AND EXISTS (SELECT 1 FROM merchant_suggested_names g WHERE g.merchant_key = merchants.raw_name AND g.name != merchants.raw_name)`,
			)
			.bind(json),
		db
			// stays raw: a set with no cap (decision 209); the sweep as sync.ts sweepStaleNamesSql (invariant I1).
			.prepare(
				`DELETE FROM merchant_suggested_names
				WHERE merchant_key IN (SELECT k.merchant_key FROM merchant_lookup_texts k WHERE k.lookup_text IN (SELECT value FROM json_each(?)))
				  AND merchant_key IN (SELECT raw_name FROM merchants WHERE suggestion_status = 'none')`,
			)
			.bind(json),
	]);
}

/**
 * "Don't use this" (spec §7, #988): the machine's DONT_USE, guarded by the stored state, then the line drop the privacy skip uses.
 * No version guard: every interleaving ends in the same state, since `skipped` is final and the drop is idempotent.
 */
export const dontUseStatements = (
	db: D1Database,
	text: string,
): D1PreparedStatement[] => [
	db
		.prepare(
			"UPDATE merchant_lookups SET status = 'skipped', line = NULL, claimed_by = NULL, claimed_at = NULL WHERE lookup_text = ? AND status = 'found'",
		)
		.bind(text),
	...dropLineStatements(db, [text]),
];

/**
 * Saves a search's line, or "nothing found" (`line` null), for the run that holds the claim. It lands only on that
 * run's pending claim, only while every switch is still on, and only while the text is not private (a text that turned
 * private since the save's read stops the save, spec §7 "when its line is saved"); the claim is then let go.
 */
export function saveResultStatement(
	db: D1Database,
	{
		text,
		token,
		status,
		line,
		nowMs,
	}: {
		text: string;
		token: string;
		status: "found" | "nothing_found";
		line: string | null;
		nowMs: number;
	},
): D1PreparedStatement {
	return (
		db
			// stays raw: a write guarded by the stored row's claim and the switches (decision 209).
			.prepare(
				`UPDATE merchant_lookups SET status = ?, line = ?, looked_up_at = ?, claimed_by = NULL, claimed_at = NULL
				WHERE lookup_text = ? AND status = 'pending' AND claimed_by = ? AND ${STILL_ON_SQL}
					AND NOT EXISTS (SELECT 1 FROM merchant_lookup_texts WHERE lookup_text = ? AND private = 1)`,
			)
			.bind(
				status,
				line,
				new Date(nowMs).toISOString(),
				text,
				token,
				SWITCHES_ON,
				text,
			)
	);
}

/**
 * Counts a failed search: the row becomes pending again or gave_up, with one more attempt. Guarded by the claim and the
 * attempts it was read with, and not by the switches: the model keeps a failure whatever the switches say.
 */
export function failStatement(
	db: D1Database,
	{
		text,
		token,
		status,
		attemptsBefore,
		nowMs,
	}: {
		text: string;
		token: string;
		status: "pending" | "gave_up";
		attemptsBefore: number;
		nowMs: number;
	},
): D1PreparedStatement {
	return (
		db
			// stays raw: a write guarded by the claim and the attempts it was read with (decision 209).
			.prepare(
				`UPDATE merchant_lookups SET status = ?, attempts = ?, failed_at = ?, claimed_by = NULL, claimed_at = NULL
				WHERE lookup_text = ? AND status = 'pending' AND claimed_by = ? AND attempts = ?`,
			)
			.bind(
				status,
				attemptsBefore + 1,
				new Date(nowMs).toISOString(),
				text,
				token,
				attemptsBefore,
			)
	);
}

/** Gives a claim back, with no failure counted: the row stays pending and is claimable again. */
export function letGoStatement(
	db: D1Database,
	{ text, token }: { text: string; token: string },
): D1PreparedStatement {
	return (
		db
			// stays raw: a write guarded by the claim; the token guard needs no lease check, since no one re-claimed if it holds (model owns, qnt:263).
			.prepare(
				"UPDATE merchant_lookups SET claimed_by = NULL, claimed_at = NULL WHERE lookup_text = ? AND status = 'pending' AND claimed_by = ?",
			)
			.bind(text, token)
	);
}
