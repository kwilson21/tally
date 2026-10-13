-- Phase 5 (decisions 74 and 101, #205): more than one payment can pay one bill occurrence, a bill paid in parts.
--   A person links each extra payment by hand; the matcher still links one per occurrence and skips an occurrence
--   that already has a linked payment. An occurrence is Paid once its linked payments reach 90% of its amount
--   (src/bills/status.ts, occurrencePaid); until then it is part paid.
-- Dropping the index is the whole change: SQLite drops an index without rebuilding the table. The unique index on
--   transaction_id among linked rows stays, so one transaction still pays one bill. Any later rebuild of
--   bill_payments (such as #204's, which widens the period check) must not recreate bill_payments_one_per_period.
DROP INDEX bill_payments_one_per_period;
