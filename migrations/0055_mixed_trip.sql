-- Mixed trips (#233, decisions 89 and 113): Jev's answer to "does this trip span more than one category?" and the
--   other category it named. Written only with a Jev answer that was asked (categories on), cleared when Jev is asked
--   about the transaction again, never set by a failed or skipped call, and never backfilled, as jev_none_fit was.
--   A trip looks mixed when jev_mixed is at or above the threshold, and both it and jev_category_id name active
--   categories, different from each other (src/db/mixed-trip.ts). Archiving never deletes a category, so the FK's
--   ON DELETE SET NULL only covers a row a deletion would otherwise leave pointing nowhere.
ALTER TABLE transactions ADD COLUMN jev_mixed REAL;
ALTER TABLE transactions ADD COLUMN jev_also_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
