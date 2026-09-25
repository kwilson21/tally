-- Who last decided whether a transaction is excluded: 'user' (the edit panel), 'jev' (Jev flagged it
-- as a transfer or reimbursement), or null (the default). Jev never overrides a person (spec §6, #27).
ALTER TABLE transactions ADD COLUMN excluded_source TEXT CHECK (excluded_source IN ('user', 'jev'));

-- Transactions Jev flagged as a transfer or reimbursement start excluded. Before this, nobody could
-- change a transaction's exclusion, so no person's choice is overwritten.
UPDATE transactions SET excluded = 1, excluded_source = 'jev'
WHERE (flag_transfer = 1 OR flag_reimbursement = 1) AND excluded = 0;
