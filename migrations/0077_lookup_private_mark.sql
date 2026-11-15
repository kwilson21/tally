-- The store lookup's private mark is kept true by the writes, not only by the fill (spec §7, "The states"; #1079, brief A).
-- A transaction row that is flagged, excluded, a transfer, or has a transfer or income guess in its Maybe range makes its
-- merchant key private (the row facts of src/lookup/texts.ts, lookupTextRow). These two triggers set the key's private mark
-- to 1 in the same statement that writes such a row, so no save has to remember to. The row facts and both ranges are the
-- SQL the fill reads (askedSql in src/db/suggestions-queue.ts, the same bounds as src/ai/maybe.ts); the drift test in
-- test/lookup-private-mark.test.ts checks this text against them.
--
-- The triggers only raise: the UPDATE's `private = 0` guard means only the fill ever sets a mark back to 0. They only update a
-- key row that already exists, since a lookup text comes from TypeScript (lookupTextOf) and SQL cannot make one; sync writes
-- the row first for each key it writes (src/lookup/texts.ts, syncedTextsStatements). They never touch transactions, and cover
-- only the row facts: the text and Plaid-category facts are judged in TypeScript, and sync covers those.
-- D1's meta.changes counts the trigger's write; every reader of a transactions write's count compares it with 0 (audited 2026-11-15), as with 0067.

CREATE TRIGGER lookup_private_mark_insert AFTER INSERT ON transactions
WHEN NEW.flag_transfer = 1 OR NEW.flag_income = 1 OR NEW.flag_reimbursement = 1 OR NEW.kind = 'transfer' OR NEW.excluded = 1
  OR (CAST((NEW.transfer_confidence) * 10000 AS INTEGER) BETWEEN 4000 AND 7999)
  OR (CAST((NEW.income_confidence) * 10000 AS INTEGER) BETWEEN 2001 AND 7999)
BEGIN
  UPDATE merchant_lookup_texts SET private = 1
  WHERE merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name) AND private = 0;
END;

CREATE TRIGGER lookup_private_mark_update AFTER UPDATE OF flag_transfer, flag_income, flag_reimbursement,
  kind, excluded, transfer_confidence, income_confidence, merchant_name, raw_name ON transactions
WHEN NEW.flag_transfer = 1 OR NEW.flag_income = 1 OR NEW.flag_reimbursement = 1 OR NEW.kind = 'transfer' OR NEW.excluded = 1
  OR (CAST((NEW.transfer_confidence) * 10000 AS INTEGER) BETWEEN 4000 AND 7999)
  OR (CAST((NEW.income_confidence) * 10000 AS INTEGER) BETWEEN 2001 AND 7999)
BEGIN
  UPDATE merchant_lookup_texts SET private = 1
  WHERE merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name) AND private = 0;
END;
