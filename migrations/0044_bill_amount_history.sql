-- Phase 5 (decisions 74, 79 and 101): a bill's amount history, like budget_amounts.
--   An occurrence's amount is the row with the latest effective month on or before its own month (its due
--   date's month). Editing a bill's amount writes a row from this month on, so earlier months keep theirs.
--   bills.amount_cents still holds the current amount.
-- Every existing bill gets its first row here: at the month of its earliest linked payment (decision 79),
-- or this month when it has none. SQL can't read the household's time zone (decision 67), so "this month"
-- is the UTC time less twelve hours. Settings' furthest-west zone is Hawaii (UTC-10), and no zone is more
-- than 12 hours behind UTC, so this month is never ahead of the household's. A row a month early is
-- harmless, because the earliest row gives both months the same amount.
-- Bills added later get their first row when they are added (src/bills/write.ts).
CREATE TABLE bill_amounts (
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(effective_month, 6, 2) BETWEEN '01' AND '12'),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  PRIMARY KEY (bill_id, effective_month)
);
INSERT INTO bill_amounts (bill_id, effective_month, amount_cents)
  SELECT b.id,
    COALESCE(
      (SELECT substr(MIN(t.date), 1, 7) FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id WHERE bp.bill_id = b.id AND bp.status = 'linked'),
      strftime('%Y-%m', 'now', '-12 hours')
    ),
    b.amount_cents
  FROM bills b
  WHERE NOT EXISTS (SELECT 1 FROM bill_amounts ba WHERE ba.bill_id = b.id);
