// The household's time zone (spec §6, decision 67): one `household_settings` row, `time_zone`.
// Reading it, and the date it gives, is `householdTimeZone` and `householdToday` in src/dates.ts.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { householdSettings } from "./schema";

/** Saves the zone as the household's, and touches no other setting. Callers pass a zone Settings offers. */
export async function saveTimeZone(
	db: D1Database,
	zone: string,
): Promise<void> {
	await drizzle(db)
		.insert(householdSettings)
		.values({ key: "time_zone", value: zone })
		.onConflictDoUpdate({
			target: householdSettings.key,
			set: { value: sql`excluded.value` },
		});
}
