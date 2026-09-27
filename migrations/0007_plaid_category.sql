ALTER TABLE transactions ADD COLUMN plaid_category TEXT;
ALTER TABLE plaid_items ADD COLUMN sync_locked_until TEXT;
ALTER TABLE plaid_items ADD COLUMN sync_lock_id TEXT;
