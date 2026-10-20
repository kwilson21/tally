// How many times Jev has been asked today (spec §8.6): the daily cap (decision 56) is one count for
// the household's whole day, shared by the runs right after each sync and the nightly run, so a day
// never goes over it. It lives in `household_settings`, one row per household date, under
// `jev_calls_<date>`; the date is the household's own (decision 67), so a new day starts at zero.
//
// A sorting group takes the calls it wants in one step before it starts (`reserveJevCalls`) and keeps its grant
// under its own name, `jev_reserved_<date>_<turn>`, in the same batch (decision 143). A reserve step that runs again
// gets that grant back; its save gives back what it didn't ask and removes the record. A call costs no query of its
// own: D1 allows 1,000 queries in one invocation, and a night's 500 calls must fit in them. A run cut off before it
// gives back loses the unused part for that day, which only ever leaves the day with fewer calls, never more.

import { daysBefore } from "../dates";
import { withTurnGuard } from "./sorting-turn";

const keyFor = (day: string) => `jev_calls_${day}`;

/** The key of the record of the calls one sorting group reserved for a day (decision 143). */
export const reservedKeyFor = (day: string, turnId: string) =>
	`jev_reserved_${day}_${turnId}`;

/**
 * Reserves up to `wanted` of today's calls for the sorting group `turnId` and says how many it got: what the cap still
 * allows, never more. One D1 batch (one transaction) writes the group's record of its grant, adds that grant to the
 * count and drops the days before. A group that reserves again fails on its record's key, so its calls are charged once.
 * The record and the count's upsert compute the grant from the same old count, so they always agree.
 */
export async function reserveJevCalls(
	db: D1Database,
	day: string,
	cap: number,
	wanted: number,
	turnId: string,
): Promise<number> {
	if (cap < 1 || wanted < 1) return 0;
	const key = keyFor(day);
	const [recorded] = await db.batch<{ value: string }>([
		// A plain INSERT, never an upsert: a second reserve for the same group must fail whole.
		db
			.prepare(
				`INSERT INTO household_settings (key, value) VALUES (?1,
					CAST(CAST(MAX(0, MIN(?2, ?3 - COALESCE((SELECT CAST(value AS INTEGER) FROM household_settings WHERE key = ?4), 0))) AS INTEGER) AS TEXT))
				 RETURNING value`,
			)
			.bind(reservedKeyFor(day, turnId), wanted, cap, key),
		// ?2 is what's wanted and ?3 the cap. A new day's row starts at what's granted; an existing
		// one takes what fits, and `MAX(0, …)` keeps a count past the cap (a smaller cap than before)
		// from going backwards. D1 binds numbers as reals, so the count is cast back to a whole
		// number before it's stored as text.
		db
			.prepare(
				`INSERT INTO household_settings (key, value) VALUES (?1, CAST(CAST(MIN(?2, ?3) AS INTEGER) AS TEXT))
				 ON CONFLICT(key) DO UPDATE SET
					value = CAST(CAST(CAST(value AS INTEGER) + MAX(0, MIN(?2, ?3 - CAST(value AS INTEGER))) AS INTEGER) AS TEXT)`,
			)
			.bind(key, wanted, cap),
		db
			.prepare(
				"DELETE FROM household_settings WHERE key GLOB 'jev_calls_*' AND key < ?",
			)
			.bind(key),
		db
			.prepare(
				"DELETE FROM household_settings WHERE key GLOB 'jev_reserved_*' AND key < ?",
			)
			.bind(`jev_reserved_${daysBefore(day, 2)}`),
	]);
	return Number(recorded?.results[0]?.value ?? 0);
}

/**
 * Returns calls a run reserved and didn't use, to the day it reserved them on. One statement, and the
 * count never goes below zero.
 */
export function giveBackJevCallsStatement(
	db: D1Database,
	day: string,
	unused: number,
	turnId?: string,
): D1PreparedStatement | undefined {
	if (unused < 1) return undefined;
	// A sorting group gives back in its save, only while it holds the turn (decision 139).
	const guarded = withTurnGuard(
		"UPDATE household_settings SET value = CAST(CAST(MAX(0, CAST(value AS INTEGER) - ?) AS INTEGER) AS TEXT) WHERE key = ?",
		turnId,
	);
	return db.prepare(guarded.sql).bind(unused, keyFor(day), ...guarded.binds);
}

/**
 * A sorting save gives back what its group reserved less what it asked (decision 143). The group's record holds its
 * grant, which a reserve step that ran after its batch committed left there; `planned` is the grant the plan says, used
 * when there is no record. Never below zero. It changes only while the group holds the turn, and it must run before
 * the record is dropped (dropReservedJevCallsStatement).
 */
export function giveBackReservedJevCallsStatement(
	db: D1Database,
	{
		day,
		planned,
		asked,
		turnId,
	}: { day: string; planned: number; asked: number; turnId: string },
): D1PreparedStatement {
	const guarded = withTurnGuard(
		`UPDATE household_settings SET value = CAST(CAST(MAX(0, CAST(value AS INTEGER)
				- MAX(0, COALESCE((SELECT CAST(value AS INTEGER) FROM household_settings WHERE key = ?), ?) - ?)) AS INTEGER) AS TEXT)
			WHERE key = ?`,
		turnId,
	);
	return db
		.prepare(guarded.sql)
		.bind(
			reservedKeyFor(day, turnId),
			planned,
			asked,
			keyFor(day),
			...guarded.binds,
		);
}

/** Removes a group's reservation record once its save has given the calls back; only while it holds the turn. */
export function dropReservedJevCallsStatement(
	db: D1Database,
	day: string,
	turnId: string,
): D1PreparedStatement {
	const guarded = withTurnGuard(
		"DELETE FROM household_settings WHERE key = ?",
		turnId,
	);
	return db
		.prepare(guarded.sql)
		.bind(reservedKeyFor(day, turnId), ...guarded.binds);
}
