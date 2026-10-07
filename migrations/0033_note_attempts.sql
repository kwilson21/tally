ALTER TABLE transactions ADD COLUMN note_tried_at TEXT;
ALTER TABLE transactions ADD COLUMN note_dismissed INTEGER NOT NULL DEFAULT 0 CHECK (note_dismissed IN (0, 1));
