-- The AI suggestions switches (spec §8.6, decision 73): one household_settings row each, all on to start.
-- A switch with no row also reads as on, so the demo's reset, which empties the table, turns them back on.
INSERT OR IGNORE INTO household_settings (key, value) VALUES
	('ai_names', 'on'),
	('ai_categories', 'on'),
	('ai_income', 'on'),
	('ai_sort_on_arrival', 'on');
