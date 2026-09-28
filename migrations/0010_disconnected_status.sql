-- A disconnected item keeps its history but can never sync again.
PRAGMA foreign_keys = OFF;
CREATE TABLE plaid_items_new (
  id INTEGER PRIMARY KEY,
  access_token_encrypted BLOB NOT NULL,
  institution_name TEXT NOT NULL,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_attention', 'disconnected')),
  linked_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  plaid_item_id TEXT,
  sync_locked_until TEXT,
  sync_lock_id TEXT
);
INSERT INTO plaid_items_new SELECT id, access_token_encrypted, institution_name, sync_cursor, status, linked_by, created_at, plaid_item_id, sync_locked_until, sync_lock_id FROM plaid_items;
DROP TABLE plaid_items;
ALTER TABLE plaid_items_new RENAME TO plaid_items;
CREATE UNIQUE INDEX plaid_items_plaid_item_id ON plaid_items(plaid_item_id);
PRAGMA foreign_keys = ON;
