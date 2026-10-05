-- Keep the source of an income decision so a person's correction survives Jev and Plaid updates.
ALTER TABLE transactions ADD COLUMN income_source TEXT CHECK (income_source IN ('user', 'jev'));

-- A null value means this historic bank credit still needs a person to identify it.
ALTER TABLE transactions ADD COLUMN credit_reviewed INTEGER CHECK (credit_reviewed IN (0, 1));

-- Only a person's explicit choice makes a credit review portable through sign corrections from Plaid.
ALTER TABLE transactions ADD COLUMN credit_reviewed_by TEXT CHECK (credit_reviewed_by IN ('user'));

-- Historic person-decided credits already counted before the review queue existed.
UPDATE transactions
SET credit_reviewed = 1
WHERE amount_cents < 0
  AND (category_source = 'user' OR refund_of_id IS NOT NULL OR excluded_source = 'user');
