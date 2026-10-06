// How many times Jev has been asked today (spec §8.6): the daily cap (decision 56) is one count for
// the household's whole day, shared by the runs right after each sync and the nightly run, so a day
// never goes over it. It lives in `household_settings`, one row per household date, under
// `jev_calls_<date>`; the date is the household's own (decision 67), so a new day starts at zero.
//
// A run takes the calls it wants in one step before it starts (`reserveJevCalls`) and returns the ones
// it didn't use when it ends (`giveBackJevCalls`), so a call costs no query of its own: D1 allows 1,000
// queries in one invocation, and a night's 500 calls must fit in them. A run cut off before it gives
// back loses the unused part for that day, which only ever leaves the day with fewer calls, never more.

const keyFor = (day: string) => `jev_calls_${day}`;

/**
 * Reserves up to `wanted` of today's calls and says how many it got: what the cap still allows, never
 * more. One D1 batch (one transaction) reads the count, adds the grant and drops the days before
 * today's, so runs going at the same moment can't take more than the cap between them. The grant is
 * the difference between the count it read and the one it wrote.
 */
export async function reserveJevCalls(
	db: D1Database,
	day: string,
	cap: number,
	wanted: number,
): Promise<number> {
	if (cap < 1 || wanted < 1) return 0;
	const key = keyFor(day);
	const [before, after] = await db.batch<{ value: string }>([
		db.prepare("SELECT value FROM household_settings WHERE key = ?").bind(key),
		db
			.prepare(
				// ?2 is what's wanted and ?3 the cap. A new day's row starts at what's granted; an existing
				// one takes what fits, and `MAX(0, …)` keeps a count past the cap (a smaller cap than before)
				// from going backwards. D1 binds numbers as reals, so the count is cast back to a whole
				// number before it's stored as text.
				`INSERT INTO household_settings (key, value) VALUES (?1, CAST(CAST(MIN(?2, ?3) AS INTEGER) AS TEXT))
				 ON CONFLICT(key) DO UPDATE SET
					value = CAST(CAST(CAST(value AS INTEGER) + MAX(0, MIN(?2, ?3 - CAST(value AS INTEGER))) AS INTEGER) AS TEXT)
				 RETURNING value`,
			)
			.bind(key, wanted, cap),
		db
			.prepare(
				"DELETE FROM household_settings WHERE key GLOB 'jev_calls_*' AND key < ?",
			)
			.bind(key),
	]);
	const was = Number(before?.results[0]?.value ?? 0);
	const now = Number(after?.results[0]?.value ?? was);
	return Math.max(0, now - (Number.isFinite(was) ? was : 0));
}

/**
 * Returns calls a run reserved and didn't use, to the day it reserved them on. One statement, and the
 * count never goes below zero.
 */
export async function giveBackJevCalls(
	db: D1Database,
	day: string,
	unused: number,
): Promise<void> {
	if (unused < 1) return;
	await db
		.prepare(
			"UPDATE household_settings SET value = CAST(CAST(MAX(0, CAST(value AS INTEGER) - ?) AS INTEGER) AS TEXT) WHERE key = ?",
		)
		.bind(unused, keyFor(day))
		.run();
}
