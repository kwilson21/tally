-- The household's active categories when a kept name was asked for (decision 165): a short SHA-256 hex of the sorted
-- "id:name" list, truncated to 16 characters. A kept name is read back only while its key matches the categories now,
-- so a category made, renamed, archived or restored asks the purchase once more. NULL for a row kept before this
-- migration, so each such row is asked once more after the deploy.
ALTER TABLE maybe_names ADD COLUMN categories_key TEXT;
