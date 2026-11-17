-- Durable dispatch identities for the second ask. A sorting lease can expire while
-- its result save is unavailable; never let another run dispatch that row again.
-- No merchant text, transaction facts, response or credential is stored here.
-- Keep a claim until its transaction is deleted, including after an uncertain crash.
CREATE TABLE lookup_second_claims (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL
);
