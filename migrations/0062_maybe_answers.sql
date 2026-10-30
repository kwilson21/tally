-- What a person answered to a "Maybe …" question (spec §5 and §8.6, decision 155): one row for each Yes or No that
-- changed a guess, counted from the day this ships (nothing is backfilled).
--   kind           'category', 'income' or 'transfer': the question's kind.
--   confidence     the guess's stored confidence when the person answered, so the record shows how sure Tally was.
--   answer         'yes', 'no' (income and transfer) or 'something_else' (category: a category other than Tally's guess).
--   household_day  the household's date when the answer was written (YYYY-MM-DD); its month is the first 7 characters.
--   created_at     when the row was written.
-- There is no transaction id, name, merchant or amount, on purpose: the record shows how often Tally's guesses were
-- right, by kind and how sure it was, and nothing about which purchase or store it was. A Skip writes nothing, and an
-- answer that changed no guess (a stale one) writes nothing either: the record and the answer are written in one batch.
CREATE TABLE maybe_answers (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'income', 'transfer')),
  confidence REAL NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'something_else')),
  household_day TEXT NOT NULL CHECK (household_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX maybe_answers_household_day ON maybe_answers(household_day);
