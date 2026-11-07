import { next } from "../machines/next";
import { plaidConnectionMachine } from "../machines/plaid-connection";

// The only file that writes plaid_items.status, attention_reason or disconnected_at. Routes and sync code call the
// named operations below; none of them writes those columns itself (test/plaid-item-writes.test.ts fails if one does).
//
// Every operation takes the same steps, each in its own function:
//   1. read the bank's row now, or check the `seen` state the caller read earlier
//   2. ask the machine (src/machines/plaid-connection.ts) what the event does from that state
//   3. write the new state, but only if the row still matches what was read, and is still held by the caller's lease
//   4. say what happened: changed, unchanged, refused or lost-race
//
// The machine says only the state. Why a bank needs attention, and which events clear it, is the store's own rule
// (decision 173): a login flag is cleared by a successful sync, and an expiry warning is cleared only by a relink.

export type ConnectionState = "ok" | "needs_attention" | "disconnected";

/** Why a bank needs attention: Plaid says its login is broken, or Plaid warns that the login is about to expire. */
export type AttentionReason = "login" | "expiring";

/**
 * What an operation did:
 * - changed: the bank moved to a new state (or a new reason) and the row was written.
 * - unchanged: the bank is already where the event leaves it, and the row still says so, so nothing was written.
 * - refused: the machine doesn't allow the event from this state, or there is no such bank.
 * - lost-race: the row changed, or the sync lost its lease, after it was read; nothing was written.
 */
export type ItemResult = "changed" | "unchanged" | "refused" | "lost-race";

type Event = "LOGIN_BROKEN" | "RELINKED" | "SYNC_SUCCEEDED" | "DISCONNECT";

export type ItemOptions = {
	/** The state the caller read earlier. Without it, the operation reads the row itself. */
	seen?: ConnectionState;
	/** The sync's lease id. Without it, the write doesn't check a lease. */
	lockId?: string;
	/** Why the bank needs attention, for markNeedsAttention. */
	reason?: AttentionReason;
};

/** A bank's row as the store reads it: its state, and the reason when it needs attention. */
type Current = { state: ConnectionState; reason: AttentionReason | null };

/** What the write leaves the row as: ok, or flagged with a reason. */
type Plan =
	| { state: "ok" }
	| { state: "needs_attention"; reason: AttentionReason };

// The SET part of each write. The reason is one of two fixed words, so it is safe to put in the SQL text.
const LANDING_OK =
	// Writing ok forgets the reason and the reminder email, so a bank that recovers is not reminded on its next failure.
	"status = 'ok', attention_reason = NULL, reconnect_emailed_at = NULL";
const landingFlagged = (reason: AttentionReason) =>
	`status = 'needs_attention', attention_reason = '${reason}'`;

const DISCONNECTED_SET =
	"disconnected_at = datetime('now'), access_token_encrypted = X'', sync_locked_until = NULL, sync_lock_id = NULL";

/** The bank's state from its row, or null when there is no such bank. */
export async function readConnection(
	db: D1Database,
	itemId: number,
): Promise<ConnectionState | null> {
	return (await readCurrent(db, itemId))?.state ?? null;
}

/** Step 1: the bank's state and reason from its row, or null when there is no such bank. */
async function readCurrent(
	db: D1Database,
	itemId: number,
): Promise<Current | null> {
	const row = await db
		.prepare(
			"SELECT status, disconnected_at, attention_reason FROM plaid_items WHERE id = ?",
		)
		.bind(itemId)
		.first<{
			status: string;
			disconnected_at: string | null;
			attention_reason: AttentionReason | null;
		}>();
	if (!row) return null;
	return { state: connectionOf(row), reason: row.attention_reason };
}

/** A row's state: disconnected once it has a disconnected_at, otherwise its status. */
export function connectionOf(row: {
	status: string;
	disconnected_at: string | null;
}): ConnectionState {
	if (row.disconnected_at !== null) return "disconnected";
	// The table's CHECK (migration 0001) allows only these two statuses, so this cast is safe.
	return row.status as "ok" | "needs_attention";
}

/** Step 2: the state the machine moves to on this event, or null when it refuses. */
function nextStateOf(
	from: ConnectionState,
	event: Event,
): ConnectionState | null {
	return next(plaidConnectionMachine, from, event) as ConnectionState | null;
}

/**
 * What the write should leave the row as. The machine has given the state; these are the reason rules:
 * - a successful sync clears a login flag, but leaves an expiry warning as it is (the bank still works);
 * - a login error takes the flag, but an expiry warning never replaces a login flag already there.
 */
function planFor(
	event: Event,
	current: Current,
	to: "ok" | "needs_attention",
	reason: AttentionReason | undefined,
): Plan {
	if (event === "SYNC_SUCCEEDED" && current.reason === "expiring") {
		return { state: "needs_attention", reason: "expiring" };
	}
	if (to === "ok") return { state: "ok" };
	if (current.reason === "login" && reason === "expiring") {
		return { state: "needs_attention", reason: "login" };
	}
	return { state: "needs_attention", reason: reason ?? "login" };
}

/** True when the plan leaves the row exactly as it is, so the write can be skipped. */
function leavesRowAsIs(plan: Plan, current: Current): boolean {
	if (plan.state === "ok") return current.state === "ok";
	return current.state === "needs_attention" && plan.reason === current.reason;
}

/**
 * The row must still be live, in the state and with the reason we read, and (for a sync) held under the caller's
 * lease. Each condition and its value are pushed together, so the SQL and the values cannot fall out of step.
 */
function stillAsRead(
	itemId: number,
	current: Current,
	lockId: string | undefined,
) {
	const conditions = [
		"id = ?",
		"disconnected_at IS NULL",
		"status = ?",
		"attention_reason IS ?",
	];
	const values: unknown[] = [itemId, current.state, current.reason];
	if (lockId !== undefined) {
		conditions.push("sync_lock_id = ?");
		values.push(lockId);
	}
	return { where: conditions.join(" AND "), values };
}

type Guard = ReturnType<typeof stillAsRead>;

/** Step 3: the write itself. It lands only if the guard still holds; if not, the row moved on. */
async function writeIfStillAsRead(
	db: D1Database,
	guard: Guard,
	plan: Plan,
): Promise<ItemResult> {
	const landing =
		plan.state === "ok" ? LANDING_OK : landingFlagged(plan.reason);
	const result = await db
		.prepare(`UPDATE plaid_items SET ${landing} WHERE ${guard.where}`)
		.bind(...guard.values)
		.run();
	return result.meta.changes === 1 ? "changed" : "lost-race";
}

/**
 * The no-write path. The bank is already as the event leaves it, but the caller's answer was a read, so the read
 * must still hold now: a webhook or a sync that landed since then answers lost-race.
 */
async function stillTrue(db: D1Database, guard: Guard): Promise<ItemResult> {
	const row = await db
		.prepare(`SELECT 1 AS holds FROM plaid_items WHERE ${guard.where}`)
		.bind(...guard.values)
		.first();
	return row ? "unchanged" : "lost-race";
}

/** Runs the four steps for one event. Every named operation below is this with a different event. */
async function change(
	db: D1Database,
	itemId: number,
	event: Event,
	options: ItemOptions = {},
): Promise<ItemResult> {
	// Step 1: the row now. A caller's seen state must still be the state.
	const current = await readCurrent(db, itemId);
	if (current === null) return "refused";
	if (options.seen !== undefined && options.seen !== current.state) {
		return "lost-race";
	}
	// Step 2: the machine's answer. Only disconnectStatement moves a bank to disconnected, so no event here lands there.
	const to = nextStateOf(current.state, event);
	if (to === null || to === "disconnected") return "refused";
	const plan = planFor(event, current, to, options.reason);
	const guard = stillAsRead(itemId, current, options.lockId);
	// Step 3, without a write: the bank is already as it should be, and the read is confirmed.
	if (leavesRowAsIs(plan, current)) return stillTrue(db, guard);
	// Steps 3 and 4: the guarded write, and what it did.
	return writeIfStillAsRead(db, guard, plan);
}

/**
 * Plaid says the login needs signing in (a sync that met a login error, or a login webhook), or Plaid warns that
 * it is about to expire (`expiring`). Decision 173 keeps the two apart.
 */
export function markNeedsAttention(
	db: D1Database,
	itemId: number,
	reason: AttentionReason,
	options?: Omit<ItemOptions, "reason">,
): Promise<ItemResult> {
	return change(db, itemId, "LOGIN_BROKEN", { ...options, reason });
}

/** The person fixed the login (routes/plaid.tsx). Writing ok clears either reason and forgets the reminder email. */
export function clearAttention(
	db: D1Database,
	itemId: number,
): Promise<ItemResult> {
	return change(db, itemId, "RELINKED");
}

/**
 * A sync got every page while it held its lease, so the login works (decision 173). It clears a login flag only;
 * an expiry warning stays until a relink.
 */
export function markSyncSucceeded(
	db: D1Database,
	itemId: number,
	lockId: string,
): Promise<ItemResult> {
	return change(db, itemId, "SYNC_SUCCEEDED", { lockId });
}

/**
 * The disconnect, as a statement, because the disconnect route batches it with the history deletes and must
 * keep it last: its change count says whether this call disconnected the bank. Disconnect is allowed from both
 * live states, and this statement is built without reading the row, so it asks the machine about each live
 * state and guards on "not disconnected yet".
 */
export function disconnectStatement(
	db: D1Database,
	itemId: number,
): D1PreparedStatement {
	for (const live of ["ok", "needs_attention"] as const) {
		if (nextStateOf(live, "DISCONNECT") !== "disconnected") {
			throw new Error(`The connection machine refuses DISCONNECT from ${live}`);
		}
	}
	return db
		.prepare(
			`UPDATE plaid_items SET ${DISCONNECTED_SET} WHERE id = ? AND disconnected_at IS NULL`,
		)
		.bind(itemId);
}
