-- An Undo of a deleted cash entry pays the planned expenses it paid again (decision 101; #202). The delete unlinks a plan
-- (ON DELETE SET NULL), so the hold keeps each plan's id and the entry or part it paid, as JSON, and the restore points the
-- plan at the restored row. Holds made before this migration have no plans, so they restore as they did.
ALTER TABLE cash_delete_holds ADD COLUMN plan_rows TEXT NOT NULL DEFAULT '[]';
