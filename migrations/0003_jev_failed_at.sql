-- When Jev last failed on this transaction specifically (decision 31). The nightly job asks about
-- such transactions last, so one that keeps failing can never block the others.
ALTER TABLE transactions ADD COLUMN jev_failed_at TEXT;
