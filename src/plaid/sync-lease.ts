import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import { plaidItems } from "../db/schema";
import { releaseLeaseSql, takeLeaseSql } from "../machines/plaid-lease";
import type { SyncResult } from "./sync";

// The bank's sync lease as a scoped resource (#1164, decision 210): a run takes the lease, and the lease is given back on
// every way the run ends, a return, a throw, a refusal from Plaid or an interruption. A lease that is not taken is never
// released, so nothing is given back that another run holds.

/**
 * Takes the bank's lease for `lockId`. True when this run holds it. False when a live lease is held or the bank is
 * disconnected: the run is skipped. Throws "Plaid Item not found" when the bank has no row.
 */
async function takeLease(
	db: D1Database,
	itemRowId: number,
	lockId: string,
): Promise<boolean> {
	const lock = await db
		.prepare(takeLeaseSql("?", "?"))
		.bind(lockId, itemRowId)
		.run();

	if (lock.meta.changes === 0) {
		const exists = await drizzle(db)
			.select({ id: plaidItems.id })
			.from(plaidItems)
			.where(eq(plaidItems.id, itemRowId))
			.get();

		if (!exists) throw new Error("Plaid Item not found");

		return false;
	}

	return true;
}

/**
 * The lease as an Effect: taken, then `body` runs holding it, then released on every exit. The release is registered only
 * after a successful take, so a lease that was not taken is never released. A release that fails is logged and swallowed,
 * so the run's own result or error is the Effect's outcome.
 */
export function leaseScoped(
	db: D1Database,
	itemRowId: number,
	lockId: string,
	body: () => Promise<SyncResult>,
): Effect.Effect<SyncResult> {
	const skipped: SyncResult = { skipped: true };

	const releaseLease = () =>
		Effect.promise(async () => {
			try {
				await db
					.prepare(releaseLeaseSql("?", "?"))
					.bind(itemRowId, lockId)
					.run();
			} catch {
				// Only the item row id is logged: no error message, lock id, token or transaction detail.
				console.error(
					`plaid sync could not release its lease for item ${itemRowId}`,
				);
			}
		});

	// The take is the acquisition, so the release is registered with it: an interruption while the take is pending still
	// finds the release, and a take that lands is always given back. A take that is not taken (or fails) registers nothing
	// to release, since the finalizer releases only when the take took the lease.
	return Effect.scoped(
		Effect.acquireRelease(
			Effect.promise(() => takeLease(db, itemRowId, lockId)),
			(taken) => (taken ? releaseLease() : Effect.void),
		).pipe(
			Effect.flatMap((taken) =>
				taken ? Effect.promise(body) : Effect.succeed(skipped),
			),
		),
	);
}

/**
 * Runs `body` holding the bank's lease, and gives the lease back however the body ends. Resolves with the body's result
 * or `{ skipped: true }` when the lease is held; rejects with the body's own error. A release that fails is logged and
 * does not change either.
 */
export function withSyncLease(
	db: D1Database,
	itemRowId: number,
	lockId: string,
	body: () => Promise<SyncResult>,
): Promise<SyncResult> {
	return Effect.runPromise(leaseScoped(db, itemRowId, lockId, body));
}
