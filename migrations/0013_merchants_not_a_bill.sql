ALTER TABLE merchants ADD COLUMN not_a_bill INTEGER NOT NULL DEFAULT 0 CHECK (not_a_bill IN (0,1));
