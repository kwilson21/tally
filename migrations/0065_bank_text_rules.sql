-- Change on a learned line (decision 163): a rule on the cleaned bank text (cleanBankText) that files a matching
-- transaction in one category before Jev is asked. It is made only from the learned page's Change, never from a
-- merchant name, and it never changes a merchant rule.
--   id            names the row.
--   cleaned_text  the cleaned bank text the rule is for. One rule per text.
--   category_id   the category the rule files a matching transaction in. Removing the category removes the rule.
--   created_at / updated_at  when it was first made, and when its category last changed.
CREATE TABLE bank_text_rules (
  id INTEGER PRIMARY KEY,
  cleaned_text TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The rule a Forget removed, so its Undo can put it back (decision 163). NULL when the text had no rule.
ALTER TABLE forgotten_texts ADD COLUMN rule_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
