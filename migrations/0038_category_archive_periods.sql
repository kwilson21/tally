-- Each archive is a period from archived_on until restored_on (NULL while still archived), so a budget
-- doesn't count in a month wholly inside one. Categories archived before this migration get one open period.
CREATE TABLE category_archive_periods (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  archived_on TEXT NOT NULL,
  restored_on TEXT
);
CREATE UNIQUE INDEX category_archive_periods_open ON category_archive_periods (category_id) WHERE restored_on IS NULL;
INSERT INTO category_archive_periods (category_id, archived_on)
  SELECT id, archived_on FROM categories WHERE archived = 1 AND archived_on IS NOT NULL;
