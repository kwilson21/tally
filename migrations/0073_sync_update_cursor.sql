-- Where a bank's update began (decision 221): sync_update_cursor holds the cursor of the first page of an update that is
--   still being paged, written in the same batch as each page's position (sync_cursor). Plaid's rule for an update whose
--   data changed while it was being paged is to start again from that first cursor, and a later run only has the middle
--   position unless this is kept. '' means the update began with no cursor (a bank's first sync); NULL means no update
--   is part-way, which is every bank today.
ALTER TABLE plaid_items ADD COLUMN sync_update_cursor TEXT;
