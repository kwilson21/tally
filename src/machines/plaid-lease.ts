import { setup } from "xstate";
import { SYNC_LEASE_MINUTES } from "../plaid/timing";

// The bank sync lease (issue #1100): one bank's sync holds `sync_locked_until` and `sync_lock_id` for SYNC_LEASE_MINUTES,
// and a run that is cut off leaves its lease to run out. A lease's id is a fencing token: every write a sync makes carries
// its lock id, so a run whose lease has passed and been taken writes nothing. The SQL forms below are the same rules, and
// test/plaid-lease-machine.test.ts walks every form from every state against this machine.
//
// What a move means for a bank, one plain sentence each:
//   TAKE        a run takes the bank's lease with a new lock id; the lease runs SYNC_LEASE_MINUTES from now.
//   EXTEND      the holder moves the lease forward (each page the sync reads). Today this also revives an expired lease
//               nobody has taken yet, because the SQL checks the lock id and not the time: the machine says the same.
//   RELEASE     the holder gives the lease back at the end of its run (a finally), and both columns are cleared.
//   DISCONNECT  the bank is disconnected: both columns are cleared, and nothing may take, extend or write again.
//
// The states are read from the stored columns by leaseStateOf below, not stored. Expiry is not an event: a held lease
// becomes expired when its time passes, and nothing writes that.
//
// The machine has no context: no move depends on a value (the lease's age is decided by leaseStateOf before an event is
// sent), so every transition is an object with a string target, as src/machines/ready-claim.ts does.

export const plaidLeaseMachine = setup({}).createMachine({
	id: "plaidLease",
	initial: "free",
	states: {
		// No live lease and no lock id: any run may take it.
		free: {
			on: {
				TAKE: { target: "held" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		// A live lease (not strictly past). The holder moves it, gives it back, or the bank is disconnected. A TAKE is refused.
		held: {
			on: {
				EXTEND: { target: "held" },
				RELEASE: { target: "free" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		// A lock id with no live lease: the holder was cut off, or its lease ran out. A new run may take it, and the holder may
		// still extend or release it until someone does.
		expired: {
			on: {
				TAKE: { target: "held" },
				EXTEND: { target: "held" },
				RELEASE: { target: "free" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		// Final: disconnected_at is set. Nothing moves it.
		disconnected: {},
	},
});

export type PlaidLeaseState = "free" | "held" | "expired" | "disconnected";

/** A bank's lease columns as the database stores them; `lockedUntil` and `disconnectedAt` are SQLite's UTC text or null. */
export type StoredLease = {
	lockId: string | null;
	lockedUntil: string | null;
	disconnectedAt: string | null;
};

/**
 * True when a stored lease is strictly before the current second. SQLite's datetime('now') has whole-second precision, so
 * `now` is cut to the second, and a lease that ends in the current second is still held (`sync_locked_until < datetime('now')`
 * is strict). A lease that cannot be read is read as held, so no run takes a bank on a time it cannot read.
 */
function leaseIsPast(lockedUntil: string, nowMs: number): boolean {
	const until = Date.parse(`${lockedUntil.replace(" ", "T")}Z`);
	const thisSecond = Math.floor(nowMs / 1000) * 1000;

	return until < thisSecond;
}

/**
 * The state a stored bank is in, from its columns, with `nowMs` (epoch milliseconds) passed in, so the machine itself reads
 * no clock. Disconnected wins over everything. A live lease is held whatever its lock id (production never writes a live
 * lease without a lock id; test rows do). Otherwise a lock id means expired, and no lock id means free.
 */
export function leaseStateOf(row: StoredLease, nowMs: number): PlaidLeaseState {
	if (row.disconnectedAt !== null) return "disconnected";

	if (row.lockedUntil !== null && !leaseIsPast(row.lockedUntil, nowMs))
		return "held";

	return row.lockId !== null ? "expired" : "free";
}

// The SQL forms of the same rules. Each takes its placeholders, so a caller keeps its own numbering and bind order: a plain
// `?` binds in the order it appears in the statement, and a numbered `?4` binds by its number. The builders bind nothing.

/** The lease length, in SQLite's modifier, as the TAKE and EXTEND statements write it. */
const LEASE_FOR = `datetime('now', '+${SYNC_LEASE_MINUTES} minutes')`;

/**
 * TAKE, from free or expired: a new lock id and a fresh lease. It changes a row only when the bank is not disconnected and
 * its lease is absent or strictly past. A row with a live lease is held, so the statement changes nothing.
 */
export function takeLeaseSql(itemPh: string, lockPh: string): string {
	return `UPDATE plaid_items SET sync_locked_until = ${LEASE_FOR}, sync_lock_id = ${lockPh}
	 WHERE id = ${itemPh} AND disconnected_at IS NULL AND (sync_locked_until IS NULL OR sync_locked_until < datetime('now'))`;
}

/**
 * EXTEND, held or expired by the holder: the lease moves forward. It checks the lock id and not the time, so an expired
 * lease that nobody has taken still moves (the machine's expired EXTEND); a stale lock id changes nothing.
 */
export function extendLeaseSql(itemPh: string, lockPh: string): string {
	return `UPDATE plaid_items SET sync_locked_until = ${LEASE_FOR}
	 WHERE id = ${itemPh} AND sync_lock_id = ${lockPh} AND disconnected_at IS NULL`;
}

/**
 * RELEASE, held or expired by the holder: both columns are cleared, and the bank is free. A stale lock id changes nothing,
 * and so does a free or disconnected bank, since each has no lock id to match.
 */
export function releaseLeaseSql(itemPh: string, lockPh: string): string {
	return `UPDATE plaid_items SET sync_locked_until = NULL, sync_lock_id = NULL
	 WHERE id = ${itemPh} AND sync_lock_id = ${lockPh}`;
}

/**
 * OWNS, the guard every page write carries: true only while the lock id is the bank's and the bank is not disconnected.
 * It checks no time, so an expired lease its holder still has passes until another run takes it (decision 230).
 * It is a statement-wide gate, not a test on the row being written: it is right on a write to another table, but an UPDATE
 * of plaid_items itself must also name the row (`id = ?`), or every bank's row matches while this bank holds its lock.
 */
export function ownsLeaseSql(itemPh: string, lockPh: string): string {
	return `EXISTS (SELECT 1 FROM plaid_items WHERE id = ${itemPh} AND sync_lock_id = ${lockPh} AND disconnected_at IS NULL)`;
}
