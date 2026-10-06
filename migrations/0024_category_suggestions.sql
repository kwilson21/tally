CREATE TABLE category_suggestions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'dismissed', 'none')),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	decided_at TEXT
);

ALTER TABLE transactions ADD COLUMN jev_none_fit INTEGER NOT NULL DEFAULT 0 CHECK (jev_none_fit IN (0, 1));
ALTER TABLE transactions ADD COLUMN category_suggestion_id INTEGER REFERENCES category_suggestions(id);

CREATE INDEX transactions_category_suggestion_id ON transactions(category_suggestion_id);
CREATE UNIQUE INDEX category_suggestions_pending_name ON category_suggestions(lower(name)) WHERE status = 'pending' AND name <> '';
