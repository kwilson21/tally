-- A one-time key the Add cash form carries, so posting the same form twice (a lost reply, a failed
-- render, a second tap on Save) records one transaction. Bank rows and older cash rows have none.
ALTER TABLE transactions ADD COLUMN entry_key TEXT;
CREATE UNIQUE INDEX transactions_entry_key ON transactions(entry_key) WHERE entry_key IS NOT NULL;
