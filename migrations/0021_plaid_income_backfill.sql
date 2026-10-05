-- Plaid labels pay, interest and the like as INCOME, and sync now turns that into the income flag as each
-- transaction arrives. A transaction stored before that will not come through sync again, because sync
-- resumes where it left off, so this marks those once, the same way sync does.
-- It marks only a transaction nobody has decided: one a person or Jev chose income for, a credit a person
-- reviewed, and one already flagged are left as they are. Who set the flag stays empty, which is how
-- "Plaid set it" is told apart from a person's or Jev's choice.
UPDATE transactions
SET flag_income = 1
WHERE plaid_category = 'INCOME'
  AND flag_income = 0
  AND income_source IS NULL
  AND credit_reviewed_by IS NULL;
