-- The store lookup's privacy mark, one row per transaction Jev was asked the payee question about (spec §5, §7 "When it runs").
--   transaction_id  the transaction; the row goes with it (ON DELETE CASCADE), so a reused row number never inherits a mark.
--   input_mark      a SHA-256 fingerprint of everything Jev is told about the row, taken as the save leaves it (src/lookup/input-mark.ts).
--                   An answer counts only while the row's fingerprint still equals this one.
--   cleared         1 when Jev's answer cleared the row for the lookup (a sure business, no transfer, income or reimbursement
--                   answer at its threshold), 0 when it did not. Nothing reads it until the lookup's gate opens.
CREATE TABLE lookup_cleared (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  input_mark TEXT NOT NULL,
  cleared INTEGER NOT NULL CHECK (cleared IN (0, 1))
);
