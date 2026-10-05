-- Phase 3.5 (decision 67): store Plaid's cleaned merchant name, mark pending transactions, and let
-- Plaid be the source of an exclusion (`excluded_source = 'plaid'`).
--   merchant_name  nullable. A transaction's merchant key is this when present, otherwise raw_name.
--   pending        0 or 1. Nothing sets it yet (sync still skips pending transactions).
--   excluded_source now accepts 'plaid' as well as 'user' and 'jev'.
--   bills.merchant_raw_text says that a bill was saved under the bank's raw text, before a merchant key
--   existed. Every bill that exists now was, so each starts at 1, and a bill written from now on holds a
--   key and starts at 0. Matching reads the flag, so old bills keep working without guessing which ones
--   are old (spec 6.1). merchants is not changed: its rows are keys, and every row that exists now is the
--   key of its charges, since none has a merchant name yet and so its key is its raw name.
--
-- SQLite can't change a CHECK, so `transactions` is rebuilt, keeping every row and id, column, index,
-- unique constraint and foreign key. Foreign keys are enforced and can't be switched off in D1, and
-- DROP TABLE first deletes the table's rows, which runs its children's ON DELETE actions: dropping
-- `transactions` while `bill_payments` points at it would delete every bill payment (CASCADE), and
-- while the new table pointed at it would delete every split part (CASCADE) and unlink every refund
-- (SET NULL). So, in order:
--   1. bill_payments, the only other table that points at transactions, is copied aside and dropped.
--   2. the new table points at itself by its temporary name, so dropping the old table touches nothing,
--      and the rename then rewrites those self-references to `transactions`.
--   3. bill_payments is recreated from the copy, and the copy is dropped.
-- No statement leaves a foreign key unmet, so none needs checking deferred. The file runs as one
-- transaction (D1 applies a migration file as a single batch), so a failure anywhere leaves the
-- database as it was.
CREATE TABLE bill_payments_keep AS SELECT * FROM bill_payments;
DROP TABLE bill_payments;

CREATE TABLE transactions_new (
  id INTEGER PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer'),
  raw_name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('user', 'merchant_rule', 'jev')),
  category_confidence REAL,
  flag_transfer INTEGER NOT NULL DEFAULT 0 CHECK (flag_transfer IN (0, 1)),
  flag_reimbursement INTEGER NOT NULL DEFAULT 0 CHECK (flag_reimbursement IN (0, 1)),
  flag_income INTEGER NOT NULL DEFAULT 0 CHECK (flag_income IN (0, 1)),
  excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
  parent_id INTEGER REFERENCES transactions_new(id) ON DELETE CASCADE,
  is_split INTEGER NOT NULL DEFAULT 0 CHECK (is_split IN (0, 1)),
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  jev_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  jev_failed_at TEXT,
  excluded_source TEXT CHECK (excluded_source IN ('user', 'jev', 'plaid')),
  plaid_category TEXT,
  split_removed_from_cents INTEGER,
  refund_of_id INTEGER REFERENCES transactions_new(id) ON DELETE SET NULL,
  income_source TEXT CHECK (income_source IN ('user', 'jev')),
  credit_reviewed INTEGER CHECK (credit_reviewed IN (0, 1)),
  credit_reviewed_by TEXT CHECK (credit_reviewed_by IN ('user')),
  merchant_name TEXT,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1))
);

INSERT INTO transactions_new (
  id, plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source,
  category_confidence, flag_transfer, flag_reimbursement, flag_income, excluded, parent_id, is_split,
  note, updated_by, updated_at, jev_category_id, jev_failed_at, excluded_source, plaid_category,
  split_removed_from_cents, refund_of_id, income_source, credit_reviewed, credit_reviewed_by
)
SELECT
  id, plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source,
  category_confidence, flag_transfer, flag_reimbursement, flag_income, excluded, parent_id, is_split,
  note, updated_by, updated_at, jev_category_id, jev_failed_at, excluded_source, plaid_category,
  split_removed_from_cents, refund_of_id, income_source, credit_reviewed, credit_reviewed_by
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX transactions_date ON transactions(date);
CREATE INDEX transactions_category ON transactions(category_id);
CREATE INDEX transactions_raw_name ON transactions(raw_name);
CREATE INDEX transactions_parent ON transactions(parent_id);
CREATE INDEX transactions_refund_of_id_idx ON transactions(refund_of_id);

CREATE TABLE bill_payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('auto', 'user')),
  status TEXT NOT NULL CHECK (status IN ('linked', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bill_payments (id, bill_id, period, transaction_id, matched_by, status, created_at)
SELECT id, bill_id, period, transaction_id, matched_by, status, created_at FROM bill_payments_keep;
DROP TABLE bill_payments_keep;

-- Each bill gets at most one payment per period, and each transaction pays at most one bill (spec §6.1).
CREATE UNIQUE INDEX bill_payments_one_per_period ON bill_payments(bill_id, period) WHERE status = 'linked';
CREATE UNIQUE INDEX bill_payments_one_bill_per_transaction ON bill_payments(transaction_id) WHERE status = 'linked';

-- Every bill saved before this migration is keyed by the bank's raw text.
ALTER TABLE bills ADD COLUMN merchant_raw_text INTEGER NOT NULL DEFAULT 0 CHECK (merchant_raw_text IN (0, 1));
UPDATE bills SET merchant_raw_text = 1;
