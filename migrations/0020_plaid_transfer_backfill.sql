-- Phase 3.5 (decision 67, spec §8.5): sync now excludes a transaction Plaid calls a transfer, a loan
-- payment or a card payment (`excluded_source = 'plaid'`), but it only looks at what Plaid sends, and
-- Plaid doesn't send a transaction again unless it changes. This applies the same rule once to what
-- is already stored, so the family's older transfers stop counting as spending too.
--
-- Only a transaction nobody has decided about is changed: it counts (`excluded = 0`) and has no
-- source (`excluded_source IS NULL`), so a person's include or exclude and Jev's exclusion stay. A
-- payment linked to a bill also stays, so the bill isn't paid by something nothing counts, and so
-- does a credit a person decided about (income they chose, or a credit they reviewed), since a
-- person's choice about what it is wins (decision 70).
-- No schema change; running it twice changes nothing the second time.

-- 1. The bank transactions Plaid categorised as a transfer or a loan or card payment.
UPDATE transactions SET excluded = 1, excluded_source = 'plaid'
WHERE plaid_category IN ('TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS')
  AND excluded = 0
  AND excluded_source IS NULL
  AND COALESCE(income_source, '') != 'user'
  AND COALESCE(credit_reviewed_by, '') != 'user'
  AND NOT EXISTS (
    SELECT 1 FROM bill_payments
    WHERE bill_payments.transaction_id = transactions.id AND bill_payments.status = 'linked'
  );

-- 2. The parts of a split whose bank transaction Plaid just excluded. The budget counts the parts and
--    not the split's parent, so they follow it; a part someone decided about, or one that pays a
--    bill, stays as it is.
UPDATE transactions SET excluded = 1, excluded_source = 'plaid'
WHERE excluded = 0
  AND excluded_source IS NULL
  AND COALESCE(income_source, '') != 'user'
  AND COALESCE(credit_reviewed_by, '') != 'user'
  AND parent_id IN (
    SELECT id FROM transactions WHERE is_split = 1 AND excluded = 1 AND excluded_source = 'plaid'
  )
  AND NOT EXISTS (
    SELECT 1 FROM bill_payments
    WHERE bill_payments.transaction_id = transactions.id AND bill_payments.status = 'linked'
  );
