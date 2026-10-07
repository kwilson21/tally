ALTER TABLE transactions ADD COLUMN income_confidence REAL
	CHECK (income_confidence IS NULL OR income_confidence BETWEEN 0 AND 1);
ALTER TABLE transactions ADD COLUMN transfer_confidence REAL
	CHECK (transfer_confidence IS NULL OR transfer_confidence BETWEEN 0 AND 1);
