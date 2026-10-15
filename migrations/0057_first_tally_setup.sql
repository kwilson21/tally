-- The first week (spec §5, §8.8, decision 114, #582): a household that already has a budget when this runs counts as set
--   up, so it never sees the setup. Its first_tally record (src/db/first-tally.ts) draws all five strokes with no day,
--   which the record reads as set up with the steps shown without days (§9). A household with no budget has no record
--   and starts the setup. D1 holds one household, so this is the household's whole rule.
INSERT INTO household_settings (key, value)
SELECT 'first_tally', '{"strokes":{"bank":null,"pay":null,"bills":null,"budgets":null,"count":null},"budgets":{}}'
WHERE EXISTS (SELECT 1 FROM budget_amounts)
ON CONFLICT(key) DO NOTHING;
