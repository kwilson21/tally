-- The store lookup's answers (spec §5, §7 "The second ask", §8.6; decision 225): one row for each transaction Jev was asked
-- about with the line, saying whether the line-backed guess was the one kept.
--   transaction_id    the transaction; the row goes with it (ON DELETE CASCADE), so a reused row number never inherits an answer.
--   lookup_text       the store text the lookup searched.
--   kept              1 when the line-backed guess was kept, 0 when it was not.
--   kept_category_id  the category the kept guess named. A copy for comparison only, so it has no foreign key.
--   kept_confidence   the confidence the kept guess had. The row holds the guess only while the transaction's stored guess
--                     (jev_category_id and category_confidence) still equals both copies (lineGuessSql, src/db/suggestions-queue.ts).
CREATE TABLE lookup_answers (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  lookup_text TEXT NOT NULL,
  kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
  kept_category_id INTEGER,
  kept_confidence REAL
);

CREATE INDEX lookup_answers_lookup_text ON lookup_answers (lookup_text);

-- maybe_answers.with_line: 1 when the category answer answered a kept line-backed guess, read in the answer's own batch
-- (decision 225). 0 for every other answer, and always 0 for income and transfer. Existing rows read 0.
ALTER TABLE maybe_answers ADD COLUMN with_line INTEGER NOT NULL DEFAULT 0 CHECK (with_line IN (0, 1));
