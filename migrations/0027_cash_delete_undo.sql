-- Short-lived snapshots let a deleted cash entry be restored once from its toast.
CREATE TABLE cash_delete_holds (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  transaction_row TEXT NOT NULL,
  split_rows TEXT NOT NULL,
  payment_rows TEXT NOT NULL,
  refund_rows TEXT NOT NULL
);
