-- Decision 148: setup is done at the budgets stroke, so the count stroke and the first night's counts go; a household past its budgets step is set up.
UPDATE household_settings SET value = json_remove(value, '$.strokes.count', '$.night', '$.nightSync') WHERE key = 'first_tally';
