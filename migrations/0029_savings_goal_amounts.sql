CREATE TABLE savings_goal_amounts (
	effective_month TEXT NOT NULL CHECK (
		effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND
		substr(effective_month, 6, 2) BETWEEN '01' AND '12'
	),
	amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0 AND typeof(amount_cents) = 'integer'),
	UNIQUE (effective_month)
);
