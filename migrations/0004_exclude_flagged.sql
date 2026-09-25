-- Transactions Jev flagged as a transfer or reimbursement start excluded (spec §6, #27).
-- Before this, nobody could change a transaction's exclusion, so no person's choice is overwritten.
UPDATE transactions SET excluded = 1 WHERE (flag_transfer = 1 OR flag_reimbursement = 1) AND excluded = 0;
