-- Decision 99: when the bank changes a split purchase's amount, sync removes the split, and the bills its parts
-- paid are unlinked. The purchase's note names them, so they are kept here as a JSON list of {billId, name, period}
-- (NULL for none). Read only while split_removed_from_cents is set, like that column's note.
ALTER TABLE transactions ADD COLUMN split_removed_bills TEXT;
