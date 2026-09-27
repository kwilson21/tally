ALTER TABLE plaid_items ADD COLUMN plaid_item_id TEXT;

CREATE UNIQUE INDEX plaid_items_plaid_item_id ON plaid_items(plaid_item_id);
