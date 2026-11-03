-- The name Workers AI gave a Maybe card's dashed "New category" row, kept once for each transaction (decision 161).
--   transaction_id  the transaction the name was asked for; the row goes with the transaction (ON DELETE CASCADE), so a
--                   reused row number never shows an old purchase's name.
--   name            the name Tally suggested, or NULL for "no name" (a null answer, an unusable one or a failed call), so
--                   a transaction is never asked twice. Only the name's text is kept, never the bank's text.
--   created_at      when the answer was kept.
CREATE TABLE maybe_names (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
