-- The store lookup's line clear (spec §7 "One answer corrects the whole store", #1032, brief C of #987).
-- When a person or a merchant or bank-text rule files a transaction, these two triggers clear the line-backed guess of every other
-- row under the same lookup text, so the next sort asks those rows again without the line, and end the lookup_answers rows of the
-- store, so none of them counts any more. The filed row keeps its own lookup_answers row, so an Undo of that answer brings its
-- line-backed Maybe back (#1032). A key with no merchant_lookup_texts row clears nothing, since the row is found through that
-- table. The body writes no column that any trigger on transactions listens to, so nothing fires again from it.
-- UPDATE OF fires whenever either of its columns is in a statement's SET list, even when the value does not change.
-- D1's meta.changes counts these writes, and every reader of a write that can fire them compares it with 0 or reads RETURNING (audited 2026-11-15).
-- The clear's SET list is LINE_GUESS_CLEAR in src/db/store-lookups.ts, and the guess predicate is lineGuessSql in src/db/suggestions-queue.ts.
-- The drift test in test/lookup-line-clear.test.ts checks this text against them, and against KEPT_OFF and dropLineStatements.

CREATE TRIGGER lookup_line_clear_update AFTER UPDATE OF category_id, category_source ON transactions
WHEN NEW.category_source IN ('user', 'merchant_rule') AND NEW.category_id IS NOT NULL
BEGIN
  UPDATE transactions SET category_confidence = NULL, jev_category_id = NULL, jev_mixed = NULL, jev_also_category_id = NULL, jev_none_fit = 0
  WHERE id IN (SELECT sib.transaction_id FROM lookup_answers sib WHERE sib.transaction_id != NEW.id
      AND sib.lookup_text = (SELECT mlt.lookup_text FROM merchant_lookup_texts mlt
        WHERE mlt.merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name)))
    AND EXISTS (SELECT 1 FROM lookup_answers la WHERE la.transaction_id = transactions.id AND la.kept = 1
		AND transactions.category_id IS NULL AND transactions.category_source IS NULL
		AND la.kept_category_id IS transactions.jev_category_id AND la.kept_confidence = transactions.category_confidence);
  UPDATE lookup_answers SET kept = 0 WHERE kept = 1 AND transaction_id != NEW.id
    AND lookup_text = (SELECT mlt.lookup_text FROM merchant_lookup_texts mlt
      WHERE mlt.merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name));
END;

CREATE TRIGGER lookup_line_clear_insert AFTER INSERT ON transactions
WHEN NEW.category_source IN ('user', 'merchant_rule') AND NEW.category_id IS NOT NULL
BEGIN
  UPDATE transactions SET category_confidence = NULL, jev_category_id = NULL, jev_mixed = NULL, jev_also_category_id = NULL, jev_none_fit = 0
  WHERE id IN (SELECT sib.transaction_id FROM lookup_answers sib WHERE sib.transaction_id != NEW.id
      AND sib.lookup_text = (SELECT mlt.lookup_text FROM merchant_lookup_texts mlt
        WHERE mlt.merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name)))
    AND EXISTS (SELECT 1 FROM lookup_answers la WHERE la.transaction_id = transactions.id AND la.kept = 1
		AND transactions.category_id IS NULL AND transactions.category_source IS NULL
		AND la.kept_category_id IS transactions.jev_category_id AND la.kept_confidence = transactions.category_confidence);
  UPDATE lookup_answers SET kept = 0 WHERE kept = 1 AND transaction_id != NEW.id
    AND lookup_text = (SELECT mlt.lookup_text FROM merchant_lookup_texts mlt
      WHERE mlt.merchant_key = COALESCE(NULLIF(NEW.merchant_name, ''), NEW.raw_name));
END;
