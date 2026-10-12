-- Decision 99 (#337): a bill's occurrence due before the day the bill was added counts as already handled, so a bill
--   added after its due date isn't overdue or set aside for it. bills.added_on is the household's day (YYYY-MM-DD)
--   when the bill was saved: insertBill (src/bills/write.ts) and the demo reset write it. It stays NULL only for a
--   bill written without it, which then has no cutoff.
-- SQLite can't add a column with a non-constant default, so the column starts NULL and is filled right after.
-- Every existing bill gets this migration's day. SQL can't read the household's time zone (decision 67), so the
-- day is the UTC day less twelve hours, as migration 0044 computes its month. No zone is more than 12 hours
-- behind UTC, so this day is never ahead of any household's day.
ALTER TABLE bills ADD COLUMN added_on TEXT CHECK (added_on IS NULL OR added_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
UPDATE bills SET added_on = date('now', '-12 hours') WHERE added_on IS NULL;
