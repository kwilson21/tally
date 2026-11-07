-- Why a bank needs attention (decision 173): 'login' when Plaid says the login is broken, 'expiring' when Plaid warns
-- that it is about to expire. NULL when the bank is ok. Every flag already set is a login problem, so it becomes 'login'.
ALTER TABLE plaid_items ADD COLUMN attention_reason TEXT CHECK (attention_reason IN ('login', 'expiring'));

UPDATE plaid_items SET attention_reason = 'login' WHERE status = 'needs_attention';
