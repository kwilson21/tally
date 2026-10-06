// The household's time zone (spec §6, decision 67): one `household_settings` row, `time_zone`.
// Reading it, and the date it gives, is `householdTimeZone` and `householdToday` in src/dates.ts.

/** Saves the zone as the household's, and touches no other setting. Callers pass a zone Settings offers. */
export async function saveTimeZone(
	db: D1Database,
	zone: string,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('time_zone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(zone)
		.run();
}
