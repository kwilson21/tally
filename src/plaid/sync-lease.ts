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
 * A release that failed, kept until the run has settled. The release's error is thrown in place of the run's result or
 * error, as the `finally` that this replaces always did, so a failing release is never hidden behind the body's error.
 */
export type ReleaseFailure = { failure: { error: unknown } | null };

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
 * after a successful take, so a lease that was not taken is never released. A release that fails is kept in `failure`
 * and does not fail this Effect, so the caller decides what the run's outcome is (see withSyncLease).
 */
export function leaseScoped(
	db: D1Database,
	itemRowId: number,
	lockId: string,
	body: () => Promise<SyncResult>,
	failure: ReleaseFailure,
): Effect.Effect<SyncResult> {
	const skipped: SyncResult = { skipped: true };

	const releaseLease = () =>
		Effect.promise(async () => {
			try {
				await db
					.prepare(releaseLeaseSql("?", "?"))
					.bind(itemRowId, lockId)
					.run();
			} catch (error) {
				failure.failure = { error };
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
 * or `{ skipped: true }` when the lease is held; rejects with the body's error, or with the release's error when the
 * release fails, which wins over the body's result and error.
 */
export async function withSyncLease(
	db: D1Database,
	itemRowId: number,
	lockId: string,
	body: () => Promise<SyncResult>,
): Promise<SyncResult> {
	const failure: ReleaseFailure = { failure: null };
	let result: SyncResult;

	try {
		result = await Effect.runPromise(
			leaseScoped(db, itemRowId, lockId, body, failure),
		);
	} catch (error) {
		if (failure.failure) throw failure.failure.error;

		throw error;
	}

	if (failure.failure) throw failure.failure.error;

	return result;
}
