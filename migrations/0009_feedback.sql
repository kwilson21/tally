CREATE TABLE feedback (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	actor TEXT NOT NULL,
	type TEXT NOT NULL,
	feeling TEXT NOT NULL,
	message TEXT NOT NULL,
	page TEXT NOT NULL,
	device TEXT NOT NULL,
	github_issue_number INTEGER,
	filed_at TEXT
);

CREATE INDEX feedback_actor_created_at ON feedback (actor, created_at);
