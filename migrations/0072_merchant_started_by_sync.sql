-- The sync that made a merchant row (#1048, decision 218): started_by_sync holds that sync's lock id, a random id for
--   one run. Only the run that made the row may go on filling its empty settings from the rows saved under its bank
--   texts, and the statement that fills them checks this column, so two banks syncing at the same moment can't both
--   believe they started it. NULL for every row a person, an upload or an earlier release made: no run fills those.
ALTER TABLE merchants ADD COLUMN started_by_sync TEXT;
