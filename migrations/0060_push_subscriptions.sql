-- Each device a person turned Web Push notifications on for (decision 148, spec §4, §8.8). The endpoint is the push service's
--   URL for that device's subscription and is unique, so a device that subscribes again replaces its row. p256dh and auth are
--   the subscription's keys (base64url, RFC 8291). Device tokens are never exported (src/settings/export.ts) and go with the
--   person when they are removed (removeHouseholdMember).
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  member_email TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX push_subscriptions_member ON push_subscriptions (member_email);
