// How many web searches the store lookup has taken on a household day (spec §5, §7): `lookup_calls_<date>` in
// `household_settings`, one row per household date, against the lookup's own cap (300 in production, none in the demo).
// Each claim of a store takes one search from it, in the claim's own batch and only while the count is under the cap
// (store-lookups.ts), and nothing is given back: a claim let go without a search still counts. Jev's count (jev-calls.ts)
// is kept apart, so a retry of a store counts again here.

/** The key of the day's count of searches, keyed by the household's date. */
export const lookupCallsKey = (day: string) => `lookup_calls_${day}`;

/**
 * Drops the counts of the days before `day`, so only today's row is kept. It is the claim's first statement: a claim's
 * batch cleans up its own day's count (copies Jev's cleanup, jev-calls.ts).
 */
// stays raw: a GLOB pattern, batched with raw statements.
export function dropOldLookupCallsStatement(
	db: D1Database,
	day: string,
): D1PreparedStatement {
	return db
		.prepare(
			"DELETE FROM household_settings WHERE key GLOB 'lookup_calls_*' AND key < ?",
		)
		.bind(lookupCallsKey(day));
}

/**
 * Takes one search from the day's count. It lands only when the claim before it did, so it must come directly after a
 * claim statement (store-lookups.ts claimStatements) and nothing that changes rows may sit between them.
 */
// stays raw: reads changes() of the claim before it (sort-groups.ts:860).
export function takeSearchStatement(
	db: D1Database,
	day: string,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT ?, '1' WHERE changes() > 0
			ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
		)
		.bind(lookupCallsKey(day));
}
