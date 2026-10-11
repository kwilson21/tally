ALTER TABLE plaid_items ADD COLUMN reconnect_emailed_at TEXT;

CREATE TABLE household_members (
	email TEXT PRIMARY KEY,
	first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
	session_issued_at INTEGER NOT NULL DEFAULT 0,
	removed_at TEXT
);

INSERT INTO household_settings (key, value) VALUES ('bank_sign_in_emails', 'on');
