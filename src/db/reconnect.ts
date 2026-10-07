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

export async function noteHouseholdMember(
	db: D1Database,
	email: string,
	issuedAt: number,
) {
	await db
		.prepare(
			"INSERT INTO household_members (email, session_issued_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET last_seen_at = datetime('now'), session_issued_at = excluded.session_issued_at, removed_at = NULL WHERE household_members.session_issued_at < excluded.session_issued_at",
		)
		.bind(email, issuedAt)
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
