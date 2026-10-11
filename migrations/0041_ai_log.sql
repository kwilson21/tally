-- What AI did this month (spec §5 and §8.6, decisions 91 and 101): one row for each thing Tally applied,
-- with no amounts, counted from the day this ships (nothing is backfilled).
--   kind              'category': Jev gave a transaction its category. 'income': Jev marked it as income.
--                     'name': a person kept a name Tally guessed for a merchant.
--   transaction_id    the transaction, for category and income. Pending-merge moves it to the posted row.
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

CREATE UNIQUE INDEX ai_log_transaction_kind ON ai_log(kind, transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX ai_log_merchant_name ON ai_log(merchant_raw_name) WHERE kind = 'name';
CREATE INDEX ai_log_household_day ON ai_log(household_day);
