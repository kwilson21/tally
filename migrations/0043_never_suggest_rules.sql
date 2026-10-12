-- "Never suggest" rules (spec §5, §7, §8.6, decisions 79 and 101): one row per suggestion a person said
-- Yes to stopping for a store, so Tally never makes it again until the family removes the line in Settings.
-- `kind` is the suggestion a Yes can stop: a new category, income or a transfer. A name or a category has
-- no No, so it never has a row. `decided_on` is the household's day of the answer ("You said No on Oct 3").
CREATE TABLE never_suggest_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new_category', 'income', 'transfer')),
  decided_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX never_suggest_rules_one ON never_suggest_rules (merchant_key, kind);

-- A No on a "Maybe income" or a "Maybe a transfer" (decision 101) changes nothing else on the transaction: it sets
-- one of these flags, which hides that Maybe from the review screen and the row, and no sync or Jev answer raises it
-- again. A pending row's flags move onto the posted row with the person's other choices (§6), whatever the amount.
ALTER TABLE transactions ADD COLUMN income_maybe_declined INTEGER NOT NULL DEFAULT 0 CHECK (income_maybe_declined IN (0, 1));
ALTER TABLE transactions ADD COLUMN transfer_maybe_declined INTEGER NOT NULL DEFAULT 0 CHECK (transfer_maybe_declined IN (0, 1));
