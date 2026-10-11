-- "Never suggest" rules (spec §5, §7, §8.6, decisions 79 and 101): one row per suggestion a person said
-- Yes to stopping for a store, so Tally never makes it again until the family removes the line in Settings.
-- `kind` is the suggestion: a name, a category, a new category, income or a transfer. `category_id` is only
-- for a category. `decided_on` is the household's day of the answer ("You said No on Oct 3").
CREATE TABLE never_suggest_rules (
  id INTEGER PRIMARY KEY,
  merchant_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('name', 'category', 'new_category', 'income', 'transfer')),
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  decided_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX never_suggest_rules_one ON never_suggest_rules (merchant_key, kind, COALESCE(category_id, 0));
