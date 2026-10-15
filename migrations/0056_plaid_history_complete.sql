-- The first week's question gate (spec §5, §8.8, decision 114, #581): the time Plaid's 90-day history was imported for
--   this bank. It is set in the same write as the last page of the first sync that ran after Plaid said so, from the
--   SYNC_UPDATES_AVAILABLE webhook's historical_update_complete or from /transactions/sync's transactions_update_status
--   (src/plaid/sync.ts), so it means the history is in, never just announced. Null until then, and never backfilled.
ALTER TABLE plaid_items ADD COLUMN history_complete_at TEXT;
