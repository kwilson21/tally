-- Names (#468, decision 31): when Workers AI last failed to answer a merchant's name. The names pass asks a merchant
--   that failed after the merchants that were never tried, the longest-ago failure first, like jev_failed_at and
--   note_failed_at, so three merchants whose calls keep failing can't hold up the others every night. A successful
--   answer clears it. Every row starts NULL, so nothing changes until a call fails.
ALTER TABLE merchants ADD COLUMN name_failed_at TEXT;
