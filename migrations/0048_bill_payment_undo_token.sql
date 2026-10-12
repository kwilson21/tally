-- Decision 99 (#340): the Undo token of a Not this one. Only a person's Not this one (a 'dismissed' row with matched_by
--   'user') gets one, when it is saved: the payment's transaction id, a dot and a random UUID (crypto.randomUUID in
--   src/routes/bills.tsx), so the Undo on its toast works once and two Not this ones saved in the same second never share
--   a token. Every other row stays NULL. Any later rebuild of bill_payments (a table copy) must copy this column.
ALTER TABLE bill_payments ADD COLUMN undo_token TEXT;
