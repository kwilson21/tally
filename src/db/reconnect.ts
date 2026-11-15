import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { householdSettingUpsert } from "./household-setting";
import { householdSettings } from "./schema";

export async function readBankSignInEmails(db: D1Database): Promise<boolean> {
	const row = await drizzle(db)
		.select({ value: householdSettings.value })
		.from(householdSettings)
		.where(eq(householdSettings.key, "bank_sign_in_emails"))
		.get();

	return row?.value !== "off";
}

export async function saveBankSignInEmails(
	db: D1Database,
	on: boolean,
): Promise<void> {
	await householdSettingUpsert(db, "bank_sign_in_emails", on ? "on" : "off");
}

/**
 * Notes a verified sign-in. An address that isn't removed is refreshed at each new Access session,
 * or at each visit when its token has no issue time (null). A removed address comes back only for a
 * session issued after its removal. A visit without an issue time never lowers the stored session.
 * Stays raw SQL: one upsert with a conditional DO UPDATE WHERE over unixepoch and datetime, which reads
 * plainer as SQL than as a builder chain (decision 179).
 */
export async function noteHouseholdMember(
	db: D1Database,
	email: string,
	issuedAt: number | null,
) {
	await db
		.prepare(
			"INSERT INTO household_members (email, session_issued_at) VALUES (?, COALESCE(?, 0)) ON CONFLICT(email) DO UPDATE SET last_seen_at = datetime('now'), session_issued_at = MAX(household_members.session_issued_at, excluded.session_issued_at), removed_at = NULL WHERE (household_members.removed_at IS NULL AND (? IS NULL OR household_members.session_issued_at < excluded.session_issued_at)) OR (? IS NOT NULL AND household_members.session_issued_at < excluded.session_issued_at AND ? > unixepoch(household_members.removed_at))",
		)
		.bind(email, issuedAt, issuedAt, issuedAt, issuedAt)
		.run();
}

/**
 * Removes a person from the household. Their devices' push subscriptions go with them (decision 149), in the same batch, so a
 * removed person gets no push and their device tokens are not kept.
 */
export async function removeHouseholdMember(db: D1Database, email: string) {
	await db.batch([
		db
			.prepare(
				"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
			)
			.bind(email),
		db
			.prepare("DELETE FROM push_subscriptions WHERE member_email = ?")
			.bind(email),
	]);
}
