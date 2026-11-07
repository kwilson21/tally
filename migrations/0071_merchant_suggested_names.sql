-- Suggested names as rows, not one packed text per merchant (#894, decision 64): merchant_suggested_names holds up to three
--   names per merchant key, by position. There is no foreign key: merchants rows are never deleted in production, and every
--   statement that clears a merchant's status clears its names with it (see test/helpers/merchants.ts).
-- names_asked replaces suggested_name = '': 1 means Workers AI was asked and had no usable name, so the text isn't asked again.
-- The backfill trims with ' ', tab and CR only, the set the CHECK and the code's SQL use. NBSP and other Unicode spaces are not trimmed.
CREATE TABLE merchant_suggested_names (
  merchant_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position IN (0, 1, 2)),
  name TEXT NOT NULL CHECK (name <> '' AND name = trim(name, ' ' || char(9) || char(13))),
  PRIMARY KEY (merchant_key, position)
);
ALTER TABLE merchants ADD COLUMN names_asked INTEGER NOT NULL DEFAULT 0 CHECK (names_asked IN (0, 1));

-- Asked and answered with no usable name, or a value no status keeps (unreachable in production): asked, no names.
UPDATE merchants SET names_asked = 1 WHERE suggestion_status = 'none' AND suggested_name IS NOT NULL;

-- A waiting, accepted or rejected suggestion's names: each line trimmed, the non-empty ones in order, the first three.
WITH RECURSIVE lines(raw_name, rest, i, line) AS (
  SELECT raw_name, suggested_name || char(10), 0, NULL FROM merchants
  WHERE suggestion_status IN ('pending', 'accepted', 'rejected') AND suggested_name IS NOT NULL
  UNION ALL
  SELECT raw_name, substr(rest, instr(rest, char(10)) + 1), i + 1,
    trim(substr(rest, 1, instr(rest, char(10)) - 1), ' ' || char(9) || char(13))
  FROM lines WHERE rest <> ''
),
numbered AS (
  SELECT raw_name, line, ROW_NUMBER() OVER (PARTITION BY raw_name ORDER BY i) - 1 AS position
  FROM lines WHERE line IS NOT NULL AND line <> ''
)
INSERT INTO merchant_suggested_names (merchant_key, position, name)
SELECT raw_name, position, line FROM numbered WHERE position < 3;

-- A waiting suggestion with no usable name is an empty answer: it stops waiting, and its text is not asked again.
UPDATE merchants SET suggestion_status = 'none', names_asked = CASE WHEN suggested_name IS NULL THEN 0 ELSE 1 END
WHERE suggestion_status = 'pending' AND NOT EXISTS (SELECT 1 FROM merchant_suggested_names n WHERE n.merchant_key = merchants.raw_name);

ALTER TABLE merchants DROP COLUMN suggested_name;
