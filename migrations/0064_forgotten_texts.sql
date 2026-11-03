-- The Settings page "What Tally has learned" (decisions 156 and 162): a line is derived from confirmed answers, so a
-- Forget must be remembered or the line would come back at once.
--   id                     names the row, so an Undo within ten seconds can act on the one it just wrote.
--   cleaned_text           the cleaned bank text (cleanBankText) the person forgot. One row per text.
--   forgotten_at           when it was forgotten. Only an answer changed after this brings the line back.
--   previous_forgotten_at  the forgotten_at a second Forget replaced, so its Undo puts that back and the line is as it
--                          was before the second Forget. NULL when the text was forgotten once (its Undo deletes the row).
CREATE TABLE forgotten_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cleaned_text TEXT NOT NULL UNIQUE,
  forgotten_at TEXT NOT NULL DEFAULT (datetime('now')),
  previous_forgotten_at TEXT
);
