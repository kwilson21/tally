-- Phase 5 (decisions 74, 79): bills can repeat weekly, every two weeks or every quarter.
--   bills.frequency takes weekly, biweekly and quarterly; yearly and quarterly need anchor_month, and
--   biweekly needs anchor_date (YYYY-MM-DD, one due date; the others fall every 14 days from it).
--   bill_payments.period takes YYYY-MM-DD (a weekly or every-two-weeks occurrence, keyed by its due date)
--   and YYYY-Qn (a quarterly occurrence, keyed by the calendar quarter that holds its due date).
--
-- SQLite can't change a CHECK, so both tables are rebuilt, keeping every row and id, column, index, trigger
-- and foreign key. Foreign keys are enforced and can't be switched off in D1, and DROP TABLE first deletes
-- the table's rows, which runs its children's ON DELETE actions: dropping `bills` while `bill_payments`
-- points at it would delete every bill payment (CASCADE). So, in order:
--   1. bill_payments is copied aside and dropped, so nothing points at bills any more.
--   2. bills is rebuilt: the new table takes its name once the old one is dropped.
--   3. bill_payments is recreated, pointing at the new bills, from the copy, and the copy is dropped.
--   4. every index and trigger on bill_payments is recreated (bills has none).
-- No statement leaves a foreign key unmet. The file runs as one transaction (D1 applies a migration file as
-- a single batch), so a failure anywhere leaves the database as it was.
CREATE TABLE bill_payments_keep AS SELECT * FROM bill_payments;
DROP TABLE bill_payments;

CREATE TABLE bills_new (
	 id INTEGER PRIMARY KEY,
	 name TEXT NOT NULL,
	 amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
	 due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
	 frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly', 'weekly', 'biweekly', 'quarterly')),
	 anchor_month INTEGER CHECK (anchor_month BETWEEN 1 AND 12),
	 anchor_date TEXT CHECK (anchor_date IS NULL OR anchor_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	 category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
	 merchant_raw_name TEXT NOT NULL,
	 merchant_raw_text INTEGER NOT NULL DEFAULT 0 CHECK (merchant_raw_text IN (0, 1)),
	 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
	 CHECK ((frequency IN ('yearly', 'quarterly') AND anchor_month IS NOT NULL) OR (frequency NOT IN ('yearly', 'quarterly') AND anchor_month IS NULL)),
	 CHECK ((frequency = 'biweekly' AND anchor_date IS NOT NULL) OR (frequency <> 'biweekly' AND anchor_date IS NULL)),
	 CHECK (frequency NOT IN ('weekly', 'biweekly') OR due_day BETWEEN 1 AND 7)
);
INSERT INTO bills_new (
  id, name, amount_cents, due_day, frequency, anchor_month, anchor_date, category_id,
  merchant_raw_name, merchant_raw_text, active
)
SELECT
  id, name, amount_cents, due_day, frequency, anchor_month, NULL, category_id,
  merchant_raw_name, merchant_raw_text, active
FROM bills;
DROP TABLE bills;
ALTER TABLE bills_new RENAME TO bills;

CREATE TABLE bill_payments (
	 id INTEGER PRIMARY KEY,
	 bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
	 period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
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
CREATE TRIGGER bill_payment_category
AFTER INSERT ON bill_payments
WHEN NEW.status = 'linked'
BEGIN
  UPDATE transactions
  SET category_id = (SELECT category_id FROM bills WHERE id = NEW.bill_id), category_source = 'bill',
      category_confidence = NULL, jev_category_id = NULL, jev_none_fit = 0, category_suggestion_id = NULL
  WHERE id = NEW.transaction_id
    AND ((category_id IS NULL AND category_source IS NULL) OR category_source IN ('jev', 'bill'))
    AND (SELECT category_id FROM bills WHERE id = NEW.bill_id) IS NOT NULL;
END;
CREATE TRIGGER bill_payment_category_on_repoint
AFTER UPDATE OF transaction_id ON bill_payments
WHEN NEW.status = 'linked'
BEGIN
  UPDATE transactions
  SET category_id = (SELECT category_id FROM bills WHERE id = NEW.bill_id), category_source = 'bill',
      category_confidence = NULL, jev_category_id = NULL, jev_none_fit = 0, category_suggestion_id = NULL
  WHERE id = NEW.transaction_id
    AND ((category_id IS NULL AND category_source IS NULL) OR category_source IN ('jev', 'bill'))
    AND (SELECT category_id FROM bills WHERE id = NEW.bill_id) IS NOT NULL;
END;
