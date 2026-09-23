-- Tally initial schema. Money is integer cents. Dates are 'YYYY-MM-DD' strings as Plaid sends them.

CREATE TABLE plaid_items (
  id INTEGER PRIMARY KEY,
  access_token_encrypted BLOB NOT NULL,
  institution_name TEXT NOT NULL,
  sync_cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_attention')),
  linked_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  plaid_item_id INTEGER REFERENCES plaid_items(id),
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  is_liability INTEGER NOT NULL DEFAULT 0 CHECK (is_liability IN (0, 1)),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(balance_cents) = 'integer'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE balance_history (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  balance_cents INTEGER NOT NULL CHECK (typeof(balance_cents) = 'integer'),
  PRIMARY KEY (account_id, date)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE budget_amounts (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  PRIMARY KEY (category_id, effective_month)
);

CREATE TABLE merchants (
  raw_name TEXT PRIMARY KEY,
  suggested_name TEXT,
  display_name TEXT,
  default_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  suggestion_status TEXT NOT NULL DEFAULT 'none'
    CHECK (suggestion_status IN ('none', 'pending', 'accepted', 'rejected'))
);

CREATE TABLE transactions (
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
  parent_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
  is_split INTEGER NOT NULL DEFAULT 0 CHECK (is_split IN (0, 1)),
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transactions_date ON transactions(date);
CREATE INDEX transactions_category ON transactions(category_id);
CREATE INDEX transactions_raw_name ON transactions(raw_name);
CREATE INDEX transactions_parent ON transactions(parent_id);

CREATE TABLE bills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
  anchor_month INTEGER CHECK (anchor_month BETWEEN 1 AND 12),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  merchant_raw_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (frequency = 'monthly' OR anchor_month IS NOT NULL)
);

CREATE TABLE bill_payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  matched_by TEXT NOT NULL CHECK (matched_by IN ('auto', 'user')),
  status TEXT NOT NULL CHECK (status IN ('linked', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Each bill gets at most one payment per period, and each transaction pays at most one bill (spec §6.1).
CREATE UNIQUE INDEX bill_payments_one_per_period ON bill_payments(bill_id, period) WHERE status = 'linked';
CREATE UNIQUE INDEX bill_payments_one_bill_per_transaction ON bill_payments(transaction_id) WHERE status = 'linked';

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);
