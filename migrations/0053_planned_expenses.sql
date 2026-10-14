-- Phase 5: planned one-time expenses (spec §5, §6, §8.4; decisions 74, 82 and 101; #202).
--   A known one-off cost set aside in one month until a payment is linked to it. A plan has no category: its
--   linked payment keeps its own (decision 82).
--   transaction_id   the payment linked to the plan. UNIQUE, so one payment pays at most one plan. ON DELETE SET NULL,
--                    so a bank that drops a pending payment (or a person who deletes the transaction) unlinks the plan
--                    and leaves it set aside again. Any later rebuild of transactions must copy this table aside first,
--                    as bill_payments is in 0035, or the rebuild's DROP would null these links.
--   created_by       the email claim of who planned it (or 'demo'), as cash and split rows keep updated_by.
CREATE TABLE planned_expenses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL
);

-- A payment pays a bill or a plan, never both (spec §5 and §6.1). An index can't span two tables, so each table
-- gets a trigger pair: a write that would link a payment some linked bill or plan already pays aborts. A payment's group
-- is the transaction, its split parent and its parts (decision 82, paysBillGroupSql and paysPlanGroupSql in
-- counted-month.ts): a bill on a part and a plan on the whole payment are one payment. A dismissed bill row doesn't
-- block a plan (only status 'linked' counts). The link step turns the abort into a field error, and the bill matcher
-- skips plan-paid transactions, so a sync never trips these.
CREATE TRIGGER planned_expense_not_a_bill_payment
BEFORE INSERT ON planned_expenses
WHEN NEW.transaction_id IS NOT NULL
	AND EXISTS (SELECT 1 FROM bill_payments bp WHERE bp.status = 'linked' AND bp.transaction_id IN (
		SELECT g.id FROM transactions g WHERE g.id = NEW.transaction_id
			OR g.id = (SELECT p.parent_id FROM transactions p WHERE p.id = NEW.transaction_id)
			OR g.parent_id = NEW.transaction_id))
BEGIN
  SELECT RAISE(ABORT, 'That payment already pays a bill.');
END;

CREATE TRIGGER planned_expense_not_a_bill_payment_on_update
BEFORE UPDATE OF transaction_id ON planned_expenses
WHEN NEW.transaction_id IS NOT NULL
	AND EXISTS (SELECT 1 FROM bill_payments bp WHERE bp.status = 'linked' AND bp.transaction_id IN (
		SELECT g.id FROM transactions g WHERE g.id = NEW.transaction_id
			OR g.id = (SELECT p.parent_id FROM transactions p WHERE p.id = NEW.transaction_id)
			OR g.parent_id = NEW.transaction_id))
BEGIN
  SELECT RAISE(ABORT, 'That payment already pays a bill.');
END;

CREATE TRIGGER bill_payment_not_a_planned_expense
BEFORE INSERT ON bill_payments
WHEN NEW.status = 'linked'
	AND EXISTS (SELECT 1 FROM planned_expenses pe WHERE pe.transaction_id IN (
		SELECT g.id FROM transactions g WHERE g.id = NEW.transaction_id
			OR g.id = (SELECT p.parent_id FROM transactions p WHERE p.id = NEW.transaction_id)
			OR g.parent_id = NEW.transaction_id))
BEGIN
  SELECT RAISE(ABORT, 'That payment already pays a planned expense.');
END;

-- OF lists status too, so a bill row that becomes linked without a new transaction_id is still checked.
CREATE TRIGGER bill_payment_not_a_planned_expense_on_update
BEFORE UPDATE OF transaction_id, status ON bill_payments
WHEN NEW.status = 'linked'
	AND EXISTS (SELECT 1 FROM planned_expenses pe WHERE pe.transaction_id IN (
		SELECT g.id FROM transactions g WHERE g.id = NEW.transaction_id
			OR g.id = (SELECT p.parent_id FROM transactions p WHERE p.id = NEW.transaction_id)
			OR g.parent_id = NEW.transaction_id))
BEGIN
  SELECT RAISE(ABORT, 'That payment already pays a planned expense.');
END;

-- A Delete on a plan can be undone for ten seconds (decision 101, like a cash entry). The hold keeps the plan's own
-- values and its payment, so Undo writes the same plan back under a new id, once. Holds older than ten seconds are
-- pruned by each delete and cleared by the demo reset. created_ms is the server's clock in epoch milliseconds.
CREATE TABLE planned_delete_holds (
  token TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  month TEXT NOT NULL,
  transaction_id INTEGER,
  created_by TEXT NOT NULL
);
