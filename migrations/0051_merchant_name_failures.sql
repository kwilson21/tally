-- Names (#468): when Workers AI last failed to name a bank text, kept apart from `merchants` so a failure never
--   creates a merchant row that sync could copy (Codex on #483). The names pass asks these texts after the never-tried
--   ones, longest-ago failure first, and an answer deletes the row; there is no foreign key, as a bank text often has no merchants row.
CREATE TABLE merchant_name_failures (raw_name TEXT PRIMARY KEY, failed_at TEXT NOT NULL);
