-- Why a bank needs attention (decision 173), as two flags. attention_login: a login problem that a good sync clears.
-- attention_held: a cause that only a relink clears (PENDING_EXPIRATION, PENDING_DISCONNECT, USER_PERMISSION_REVOKED, or
-- a flag set before these columns, whose cause is unknown). Every existing flagged bank is held, so it waits for a relink.
ALTER TABLE plaid_items ADD COLUMN attention_login INTEGER NOT NULL DEFAULT 0 CHECK (attention_login IN (0, 1));
ALTER TABLE plaid_items ADD COLUMN attention_held INTEGER NOT NULL DEFAULT 0 CHECK (attention_held IN (0, 1));

UPDATE plaid_items SET attention_held = 1 WHERE status = 'needs_attention';
