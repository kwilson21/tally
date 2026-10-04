-- Remember the bank's pre-change total when its edit invalidates a user's split.
ALTER TABLE transactions ADD COLUMN split_removed_from_cents INTEGER;
