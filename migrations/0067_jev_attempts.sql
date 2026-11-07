-- Decision 169 (#864): how many times in a row Jev has failed on this one transaction. jev_failed_at only orders a failed row
--   last, so a row Jev can never answer was asked again on every run. At 5 the sorting run leaves the row out, until a
--   person's "ask again" sets it back to 0 (askAgainMany). Every row starts at 0, so nothing changes until a call fails.
--   The trigger starts the count again from 0 when the row's bank text, name, amount or account changes, the fields
--   decision 143 treats as a changed transaction. Only those columns: a note or a category never resets it.
ALTER TABLE transactions ADD COLUMN jev_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER transactions_jev_attempts_reset AFTER UPDATE OF raw_name, amount_cents, account_id, own_name ON transactions
WHEN OLD.jev_attempts > 0 AND (
	OLD.raw_name IS NOT NEW.raw_name
	OR OLD.amount_cents IS NOT NEW.amount_cents
	OR OLD.account_id IS NOT NEW.account_id
	OR OLD.own_name IS NOT NEW.own_name
)
BEGIN
	UPDATE transactions SET jev_attempts = 0 WHERE id = NEW.id;
END;
