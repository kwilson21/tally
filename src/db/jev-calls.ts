// How many times Jev has been asked today (spec §8.6): the nightly cap (decision 56) is one count for
// the household's whole day, shared by the run right after each sync and the nightly run, so a day
// never goes over it. It lives in `household_settings`, one row per household date, under
// `jev_calls_<date>`; the date is the household's own (decision 67), so a new day starts at zero.

const keyFor = (day: string) => `jev_calls_${day}`;

/**
 * How many more calls today's cap allows. Earlier days' counts are dropped here, so the table only
 * ever holds today's.
 */
export async function jevCallsLeft(
	db: D1Database,
	day: string,
	cap: number,
): Promise<number> {
	const [today] = await db.batch<{ value: string }>([
		db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(keyFor(day)),
		db
			.prepare(
				"DELETE FROM household_settings WHERE key GLOB 'jev_calls_*' AND key < ?",
			)
			.bind(keyFor(day)),
	]);
	const used = Number(today?.results[0]?.value ?? 0);
	return Math.max(0, cap - (Number.isFinite(used) ? used : 0));
}

/**
 * Counts one call against today's cap, and says whether there was room. One statement does the
 * check and the count together, so runs going at the same time can't take more than the cap between
 * them; a call that then fails still counts, since it was asked.
 */
export async function claimJevCall(
	db: D1Database,
	day: string,
	cap: number,
): Promise<boolean> {
	if (cap < 1) return false;
	const result = await db
		.prepare(
			`INSERT INTO household_settings (key, value) VALUES (?, '1')
			 ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
			 WHERE CAST(value AS INTEGER) < ?`,
		)
		.bind(keyFor(day), cap)
		.run();
	return result.meta.changes > 0;
}
