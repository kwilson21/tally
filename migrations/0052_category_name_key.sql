-- Category names are unique ignoring case, Unicode-aware: "Café" and "CAFÉ" are one name (spec §7).
-- The NOCASE index from migration 0005 folds only A to Z, so two saves at once could still file "Café" and
-- "CAFÉ". Every save now stores the name's key (nameKey in src/settings/category-form.ts, the form's own fold),
-- and this index refuses a second row with the same key.
-- SQLite can't fold capitals outside A to Z, so this key is lower(name): a name with an accented capital keeps it
-- ("École" stays "École"), and the form's check still catches it. The key is correct again on its next save.
-- lower() folds exactly the letters the NOCASE index folds, so these keys can't collide and the index always builds.
ALTER TABLE categories ADD COLUMN name_key TEXT;

UPDATE categories SET name_key = lower(name);

CREATE UNIQUE INDEX categories_name_key ON categories (name_key);
