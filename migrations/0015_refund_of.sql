ALTER TABLE transactions ADD COLUMN refund_of_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;
CREATE INDEX transactions_refund_of_id_idx ON transactions(refund_of_id);
