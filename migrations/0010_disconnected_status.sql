-- A disconnected item keeps its history but can never sync again.
ALTER TABLE plaid_items ADD COLUMN disconnected_at TEXT;
