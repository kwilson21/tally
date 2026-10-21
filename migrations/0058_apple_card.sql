-- Apple Card by upload (spec §8.10, decision 138, #731). The household's one Apple Card account (subtype 'apple_card')
--   keeps when it was last uploaded (uploaded_on, the household's day), the balance's day (balance_on, NULL while no
--   balance counts, which Remove clears), when it was removed (removed_at, NULL while it's on) and the first balance
--   day its chart counts (counted_from, set when a balance is typed after balance_on was NULL). A row Apple's file gave
--   keeps Apple's own category (apple_category; Jev is told it as the hint Plaid's category is, decision 143), and its
--   upload key and twin number (upload_key, upload_twin): the key is the row's dates, text, type and amount, and the
--   twin counts identical rows in file order, so a row Tally holds is never added twice (src/apple-card/plan.ts).
-- Only the uploads write these. No table is rebuilt.
ALTER TABLE accounts ADD COLUMN uploaded_on TEXT;
ALTER TABLE accounts ADD COLUMN balance_on TEXT;
ALTER TABLE accounts ADD COLUMN removed_at TEXT;
ALTER TABLE accounts ADD COLUMN counted_from TEXT;
CREATE UNIQUE INDEX accounts_one_apple_card ON accounts(subtype) WHERE subtype = 'apple_card';
ALTER TABLE transactions ADD COLUMN apple_category TEXT;
ALTER TABLE transactions ADD COLUMN upload_key TEXT;
ALTER TABLE transactions ADD COLUMN upload_twin INTEGER;
CREATE UNIQUE INDEX transactions_upload_twin ON transactions(account_id, upload_key, upload_twin) WHERE upload_key IS NOT NULL;
