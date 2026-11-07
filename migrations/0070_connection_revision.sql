-- A count of the completions that can settle a bank's connection: each successful sync and each relink (decision 173).
-- A reader that saw an older count knows a completion landed since, even when the bank's state did not change.
ALTER TABLE plaid_items ADD COLUMN connection_revision INTEGER NOT NULL DEFAULT 0;
