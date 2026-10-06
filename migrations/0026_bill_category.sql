-- `transactions.category_source` is checked, so adding `bill` requires the same safe rebuild as
-- 0017. Keep every transaction column, self-reference and secondary index, and temporarily remove
-- bill_payments so its ON DELETE CASCADE cannot unlink rows while transactions is replaced.
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
  category_source TEXT CHECK (category_source IN ('user', 'merchant_rule', 'jev', 'bill')),
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
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  entry_key TEXT,
  jev_none_fit INTEGER NOT NULL DEFAULT 0 CHECK (jev_none_fit IN (0, 1)),
  category_suggestion_id INTEGER REFERENCES category_suggestions(id)
);

INSERT INTO transactions_new (
  id, plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source,
  category_confidence, flag_transfer, flag_reimbursement, flag_income, excluded, parent_id, is_split,
  note, updated_by, updated_at, jev_category_id, jev_failed_at, excluded_source, plaid_category,
  split_removed_from_cents, refund_of_id, income_source, credit_reviewed, credit_reviewed_by,
  merchant_name, pending, entry_key, jev_none_fit, category_suggestion_id
)
SELECT
  id, plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source,
  category_confidence, flag_transfer, flag_reimbursement, flag_income, excluded, parent_id, is_split,
  note, updated_by, updated_at, jev_category_id, jev_failed_at, excluded_source, plaid_category,
  split_removed_from_cents, refund_of_id, income_source, credit_reviewed, credit_reviewed_by,
  merchant_name, pending, entry_key, jev_none_fit, category_suggestion_id
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX transactions_date ON transactions(date);
CREATE INDEX transactions_category ON transactions(category_id);
CREATE INDEX transactions_raw_name ON transactions(raw_name);
CREATE INDEX transactions_parent ON transactions(parent_id);
CREATE INDEX transactions_refund_of_id_idx ON transactions(refund_of_id);
CREATE UNIQUE INDEX transactions_entry_key ON transactions(entry_key) WHERE entry_key IS NOT NULL;
CREATE INDEX transactions_merchant_history
  ON transactions(COALESCE(NULLIF(merchant_name, ''), raw_name), date DESC, id DESC);
CREATE INDEX transactions_category_suggestion_id ON transactions(category_suggestion_id);

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

CREATE UNIQUE INDEX bill_payments_one_per_period ON bill_payments(bill_id, period) WHERE status = 'linked';
CREATE UNIQUE INDEX bill_payments_one_bill_per_transaction ON bill_payments(transaction_id) WHERE status = 'linked';

-- Existing links get the same default as new ones; explicit categories remain untouched.
UPDATE transactions
SET category_id = (SELECT b.category_id FROM bills b JOIN bill_payments bp ON bp.bill_id = b.id WHERE bp.transaction_id = transactions.id AND bp.status = 'linked'),
    category_source = 'bill',
    category_confidence = NULL,
    jev_category_id = NULL,
    jev_none_fit = 0,
    category_suggestion_id = NULL
WHERE category_id IS NULL
  AND EXISTS (
    SELECT 1 FROM bills b JOIN bill_payments bp ON bp.bill_id = b.id
    WHERE bp.transaction_id = transactions.id AND bp.status = 'linked' AND b.category_id IS NOT NULL
  );

CREATE TRIGGER bill_payment_category
AFTER INSERT ON bill_payments
WHEN NEW.status = 'linked'
BEGIN
  UPDATE transactions
  SET category_id = (SELECT category_id FROM bills WHERE id = NEW.bill_id),
      category_source = 'bill',
      category_confidence = NULL,
      jev_category_id = NULL,
      jev_none_fit = 0,
      category_suggestion_id = NULL
  WHERE id = NEW.transaction_id
    AND ((category_id IS NULL AND category_source IS NULL) OR category_source IN ('jev', 'bill'))
    AND (SELECT category_id FROM bills WHERE id = NEW.bill_id) IS NOT NULL;
END;

-- A pending payment's link can move onto the already-stored posted transaction during sync.
CREATE TRIGGER bill_payment_category_on_repoint
AFTER UPDATE OF transaction_id ON bill_payments
WHEN NEW.status = 'linked'
BEGIN
  UPDATE transactions
  SET category_id = (SELECT category_id FROM bills WHERE id = NEW.bill_id),
      category_source = 'bill',
      category_confidence = NULL,
      jev_category_id = NULL,
      jev_none_fit = 0,
      category_suggestion_id = NULL
  WHERE id = NEW.transaction_id
    AND ((category_id IS NULL AND category_source IS NULL) OR category_source IN ('jev', 'bill'))
    AND (SELECT category_id FROM bills WHERE id = NEW.bill_id) IS NOT NULL;
END;
