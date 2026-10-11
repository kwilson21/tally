export async function readBankSignInEmails(db: D1Database): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT key, value FROM household_settings WHERE key = 'bank_sign_in_emails'",
		)
		.first<{ value: string }>();
	return row?.value !== "off";
}

export async function saveBankSignInEmails(
	db: D1Database,
	on: boolean,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('bank_sign_in_emails', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(on ? "on" : "off")
		.run();
}

/**
 * Notes a verified sign-in. An address that isn't removed is refreshed at each new Access session,
 * or at each visit when its token has no issue time (null). A removed address comes back only for a
 * session issued after its removal. A visit without an issue time never lowers the stored session.
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

export async function removeHouseholdMember(db: D1Database, email: string) {
	await db
		.prepare(
			"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
		)
		.bind(email)
		.run();
}
