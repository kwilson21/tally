-- Who is still on the first week's pages (decision 146): the last time a person's Home setup or questions page checked in,
--   in UTC (datetime('now')). The page checks in every 30 seconds while it is open (POST /home/seen), so the ready email goes
--   only to a person whose check-in is ten minutes old. NULL until the first check-in, which counts as away.
ALTER TABLE household_members ADD COLUMN home_seen_at TEXT;
