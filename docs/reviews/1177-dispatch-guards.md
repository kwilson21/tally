# Second-ask dispatch guards

Local proposal for the current review findings; no production migration or lookup activation is authorized by this document.

The second ask takes a durable per-transaction dispatch claim in the same SQL statement that checks the live line, privacy, switches, unchanged transaction and merchant mapping, sibling-name coverage, and ordinary-queue priority. Only the winner receives the line and can transmit. It rechecks the household day and time budget immediately afterward.

Because `cleanBankText` is intentionally TypeScript, the final statement verifies that every current sibling raw name was in the cleaned snapshot. A newly arrived name refuses this optional ask rather than using stale rule evidence. The save uses the same coverage and live-mapping guards.

## At-most-once boundary

A sorting lease is temporary; a dispatch claim is not. Another run cannot select or dispatch the transaction after that lease expires, even if saving the original answer remains unavailable. The answer is still saved with the existing identity, switch, household and turn guards. A claim is not a successful answer and does not cause a guess to be shown as line-backed.

A process can stop after the claim commits but before sending. There is no atomic transaction across D1 and the external model request. In that uncertain case the optional second ask is conservatively abandoned, retaining the original guess, rather than risking duplicate paid transmission. A known post-preflight day/budget refusal deletes only the current run's claim; failed cleanup conservatively retains it. A database error before dispatch never sends a request. No claim or answer text is logged.

## Migration and rollback

Migration 0080 adds a new table with a transaction primary key, a foreign key with `ON DELETE CASCADE`, and the owning turn ID. It stores no merchant text, financial facts, model responses or credentials. Claims are retained for the transaction's lifetime and included in the private data export. Deleting/resetting transactions deletes their claims. No timed pruning is safe: expiry would re-enable a possibly transmitted row.

Disable lookup and drain old workers/workflows before rollout because old code does not honor claims. Apply the additive migration before deploying this code, under separately authorized deployment procedures. Old code ignores this table, so schema-only rollback is unnecessary. However, reverting to old code while lookup is active could repeat claimed-but-unsaved rows: disable the second-ask/lookup path and drain existing workflows before an application rollback, and retain the claims for roll-forward. Do not drop the table as a rollback shortcut. Check migration-number availability against current main before publication.

## Verification limits

All requests in these tests use fake model responses and seeded local D1 data. Passing them proves neither current production settings nor live model quality. Remote migration, activation, paid calls and production financial data access are out of scope.

No deepening needed: the existing line module owns the single final-snapshot gate; this fix extends that boundary rather than adding a second rule implementation.
