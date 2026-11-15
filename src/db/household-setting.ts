// One `household_settings` value, written by its key (decision 179). Returns the builder, unawaited, so a caller
// awaits it on its own or puts it in a batch with others.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { householdSettings } from "./schema";

export const householdSettingUpsert = (
	db: D1Database,
	key: string,
	value: string,
) =>
	drizzle(db)
		.insert(householdSettings)
		.values({ key, value })
		.onConflictDoUpdate({
			target: householdSettings.key,
			set: { value: sql`excluded.value` },
		});
