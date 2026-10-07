-- Tally's guessed transaction details and the household names they can refer to (spec §5, decision 81).
CREATE TABLE household_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

INSERT INTO household_people (id, name) VALUES (1, 'Everyone');

ALTER TABLE transactions ADD COLUMN kind TEXT CHECK (kind IN ('subscription', 'one_off', 'bill', 'transfer'));
ALTER TABLE transactions ADD COLUMN for_person_id INTEGER REFERENCES household_people(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN note_guessed INTEGER NOT NULL DEFAULT 0 CHECK (note_guessed IN (0, 1));
ALTER TABLE transactions ADD COLUMN kind_guessed INTEGER NOT NULL DEFAULT 0 CHECK (kind_guessed IN (0, 1));
ALTER TABLE transactions ADD COLUMN for_person_guessed INTEGER NOT NULL DEFAULT 0 CHECK (for_person_guessed IN (0, 1));
ALTER TABLE transactions ADD COLUMN details_asked INTEGER NOT NULL DEFAULT 0 CHECK (details_asked IN (0, 1));

INSERT OR IGNORE INTO household_settings (key, value) VALUES ('ai_details', 'on');
