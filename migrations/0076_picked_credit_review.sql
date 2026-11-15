-- A person's category pick settles a bank credit that Jev called not income (#870, decision 234).
-- A held credit (decision 70) waits for a review, and a pick of its category is one too: when Jev's income
-- answer was 20% or less, Jev has already said it is not income, so no question about it is ever asked, and
-- before this a credit the person had categorized stayed held for good. The trigger makes the pick the person's
-- review as not income: credit_reviewed = 1, credit_reviewed_by = 'user' and income_source = 'user', the same
-- columns the edit panel's "Reviewed as a refund or other non-income credit" box writes, so the row reads like
-- one the person reviewed by hand.
--
-- Only a pick counts: the trigger fires when category_source becomes 'user' from something else, so a merchant
-- rule, a Jev category or a Maybe never does. The guards, each on the row as the pick leaves it (NEW) or as it
-- was before (OLD):
--   OLD.category_source IS NOT 'user'                 a re-pick of a category the person already chose is not a new decision
--   NEW.amount_cents < 0, flag_income = 0             only a credit, and not one already counted as income
--   NEW.income_source IS NULL                         a person's or Jev's income answer already stands
--   NEW.is_split = 0 AND NEW.parent_id IS NULL        a split parent is not counted, and a part is counted by its own pick
--   NEW.excluded = 0 OR it pays a bill or a plan      INCLUDED (src/db/counted-month.ts): an excluded credit that pays nothing is not a row the held count reads
--   OLD.credit_reviewed_by IS NULL, OLD credit_reviewed 0   a person who un-reviewed a credit keeps it un-reviewed, even when the same save picks a category
--   income_confidence <= 0.20, floored to basis points  the same rule as src/ai/confidence.ts (floor, then <= 2000), so 20.00% counts and 20.01% does not
-- A split part's INSERT never fires an AFTER UPDATE trigger, and a row that is already reviewed fails the guards above.
-- Existing rows are not swept: a credit a person un-reviewed has the same columns as a stuck one, so a sweep would undo that
-- choice. A stuck row is reviewed with the edit panel's box.
CREATE TRIGGER picked_credit_review AFTER UPDATE OF category_source ON transactions
WHEN NEW.category_source = 'user' AND OLD.category_source IS NOT 'user'
  AND NEW.amount_cents < 0 AND NEW.flag_income = 0 AND NEW.income_source IS NULL
  AND NEW.is_split = 0 AND NEW.parent_id IS NULL
  AND (NEW.excluded = 0
    OR EXISTS (SELECT 1 FROM bill_payments linked_bill WHERE linked_bill.status = 'linked' AND linked_bill.transaction_id = NEW.id)
    OR EXISTS (SELECT 1 FROM planned_expenses linked_plan WHERE linked_plan.transaction_id = NEW.id))
  AND OLD.credit_reviewed_by IS NULL AND COALESCE(OLD.credit_reviewed, 0) = 0
  AND NEW.credit_reviewed_by IS NULL AND COALESCE(NEW.credit_reviewed, 0) = 0
  AND NEW.income_confidence IS NOT NULL AND CAST(NEW.income_confidence * 10000 AS INTEGER) <= 2000
BEGIN
  UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_source = 'user' WHERE id = NEW.id;
END;
