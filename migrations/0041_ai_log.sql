-- What AI did this month (spec §5 and §8.6, decisions 91 and 101): one row for each thing Tally applied,
-- with no amounts, counted from the day this ships (nothing is backfilled).
--   kind              'category': Jev gave a transaction its category. 'income': Jev marked it as income.
--                     'name': a person kept a name Tally guessed for a merchant.
--   transaction_id    the transaction, for category and income. Pending-merge moves a category row only when the
--                     pending row's category goes with it, and an income row always. Sync sets a category row's
--                     transaction_id to NULL when a bank correction clears Jev's category for a changed amount.
--                     The trigger below clears it when the transaction is deleted.
--   merchant_raw_name the merchant, for name (merchants.raw_name, its key).
--   household_day     the household's date when Tally did it (YYYY-MM-DD); its month is the first 7 characters.
--   created_at        when the row was written.
-- These columns have no foreign keys on purpose: a rebuild of transactions (as in 0017 and 0026) would
-- otherwise null or delete them, and a deleted transaction still counts as work Tally did.
-- A transaction gets one category row and one income row, and a merchant one name row, so the unique
-- indexes make a repeat write a no-op.
CREATE TABLE ai_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'income', 'name')),
  transaction_id INTEGER,
  merchant_raw_name TEXT,
  household_day TEXT NOT NULL CHECK (household_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The index leads with transaction_id, so the trigger's lookup is an index search, not a scan of the log.
CREATE UNIQUE INDEX ai_log_transaction_kind ON ai_log(transaction_id, kind) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX ai_log_merchant_name ON ai_log(merchant_raw_name) WHERE kind = 'name';
CREATE INDEX ai_log_household_day ON ai_log(household_day);

-- A deleted transaction's row still counts as work Tally did, but it must not keep the id: the table has no
-- AUTOINCREMENT, so SQLite gives the newest id to the next transaction, and that one would otherwise be
-- dropped from the log by the unique index or read as changed from this row. Covering the delete here
-- means no statement that deletes a transaction (a sync drop, a disconnect, a cash undo, a split's parts)
-- has to remember to do it. A later rebuild of transactions drops this trigger with the old table, so that
-- migration must recreate it, as 0035 does for bill_payments.
CREATE TRIGGER ai_log_forget_deleted AFTER DELETE ON transactions
BEGIN
  UPDATE ai_log SET transaction_id = NULL WHERE transaction_id = OLD.id;
END;
