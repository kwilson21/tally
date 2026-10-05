-- The household's own choices, one row per setting. The first is the time zone that decides "today" (decision 67).
CREATE TABLE household_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT INTO household_settings (key, value) VALUES ('time_zone', 'America/New_York');
