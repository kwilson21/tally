-- A name a person gave one transaction only (spec §5, decisions 79 and 101): shown in place of its
-- merchant's name, and on a split's parts. NULL leaves the merchant's name in charge.
ALTER TABLE transactions ADD COLUMN own_name TEXT;
