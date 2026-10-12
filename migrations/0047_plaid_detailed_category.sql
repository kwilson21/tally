-- Decision 99 (#339): Possible bills suggests a steady car, mortgage or student-loan payment that the bank marks as a
--   loan payment, but never a credit-card payment. Plaid's primary category LOAN_PAYMENTS covers both, so the detailed
--   category (LOAN_PAYMENTS_CAR_PAYMENT, LOAN_PAYMENTS_CREDIT_CARD_PAYMENT, ...) tells them apart. Sync stores it beside
--   plaid_category. A row synced before this migration has NULL, which is never suggested.
ALTER TABLE transactions ADD COLUMN plaid_detailed_category TEXT;
