-- A Kind or For a person cleared is a deliberate empty choice (#304): Jev's answer and the pending merge leave it empty.
ALTER TABLE transactions ADD COLUMN kind_cleared INTEGER NOT NULL DEFAULT 0 CHECK (kind_cleared IN (0, 1));
ALTER TABLE transactions ADD COLUMN for_person_cleared INTEGER NOT NULL DEFAULT 0 CHECK (for_person_cleared IN (0, 1));
