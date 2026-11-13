-- The store lookup's state, one row per bank text searched (spec §7, "Store lookup"): merchant_lookups holds the web
--   search's outcome for a lookup text, and its status is the state in src/machines/store-lookup.ts. line is set only
--   when status is 'found'. claimed_at and claimed_by are the run that holds the search (a 15-minute lease); failed_at
--   and attempts count failed searches in a row, and gave_up stops the lookup.
-- merchant_lookup_texts says which lookup text a merchant key uses, and whether that text is private (never searched).
--   No foreign key: both are written by the lookup, and the demo reset clears them with the other merchant tables.
CREATE TABLE merchant_lookups (
  lookup_text TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('found', 'nothing_found', 'skipped', 'gave_up', 'pending')),
  line TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  claimed_by TEXT,
  failed_at TEXT,
  looked_up_at TEXT
);

CREATE TABLE merchant_lookup_texts (
  merchant_key TEXT PRIMARY KEY,
  lookup_text TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1))
);

CREATE INDEX merchant_lookup_texts_lookup_text ON merchant_lookup_texts (lookup_text);
