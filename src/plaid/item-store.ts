import { next } from "../machines/next";
import { plaidConnectionMachine } from "../machines/plaid-connection";

// The only file that writes plaid_items.status or disconnected_at. Routes and sync code call the named operations
// below; none of them writes those columns itself (test/plaid-item-writes.test.ts fails if one does).
//
// Every operation takes the same steps, each in its own function:
//   1. read the bank's state now, or use the `seen` state the caller read earlier
//   2. ask the machine (src/machines/plaid-connection.ts) what the event does from that state
//   3. write the new state, but only if the row is still in the state read, and still held by the caller's lease
//   4. say what happened: changed, unchanged, refused or lost-race

export type ConnectionState = "ok" | "needs_attention" | "disconnected";

/**
 * What an operation did:
 * - changed: the bank moved to a new state and the row was written.
 * - unchanged: the machine allows the event, and the bank is already there, so nothing was written.
 * - refused: the machine doesn't allow the event from this state, or there is no such bank.
 * - lost-race: the row changed, or the sync lost its lease, after the state was read; nothing was written.
 */
export type ItemResult = "changed" | "unchanged" | "refused" | "lost-race";

type Event = "LOGIN_BROKEN" | "RELINKED" | "SYNC_SUCCEEDED" | "DISCONNECT";

export type ItemOptions = {
	/** The state the caller read earlier. Without it, the operation reads the row itself. */
	seen?: ConnectionState;
	/** The sync's lease id. Without it, the write doesn't check a lease. */
	lockId?: string;
};

/** The SET part of the write for each state a live bank can move to. Disconnect has its own statement below. */
const LANDING: Record<"ok" | "needs_attention", string> = {
	// Writing ok forgets the reminder email, so a bank that recovers is not reminded again on its next failure.
	ok: "status = 'ok', reconnect_emailed_at = NULL",
	needs_attention: "status = 'needs_attention'",
};

const DISCONNECTED_SET =
	"disconnected_at = datetime('now'), access_token_encrypted = X'', sync_locked_until = NULL, sync_lock_id = NULL";

/** Step 1: the bank's state from its row, or null when there is no such bank. */
export async function readConnection(
	db: D1Database,
	itemId: number,
): Promise<ConnectionState | null> {
	const row = await db
		.prepare("SELECT status, disconnected_at FROM plaid_items WHERE id = ?")
		.bind(itemId)
		.first<{ status: string; disconnected_at: string | null }>();
	return row ? connectionOf(row) : null;
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
 * The row must still be live, in the state we read, and (for a sync) held under the caller's lease. Each
 * condition and its value are pushed together, so the SQL and the values cannot fall out of step.
 */
function stillInState(
	itemId: number,
	from: ConnectionState,
	lockId: string | undefined,
) {
	const conditions = ["id = ?", "disconnected_at IS NULL", "status = ?"];
	const values: unknown[] = [itemId, from];
	if (lockId !== undefined) {
		conditions.push("sync_lock_id = ?");
		values.push(lockId);
	}
	return { where: conditions.join(" AND "), values };
}

type Guard = ReturnType<typeof stillInState>;

/** Step 3: the write itself. It lands only if the guard still holds; if not, the row moved on. */
async function writeIfStillIn(
	db: D1Database,
	guard: Guard,
	to: "ok" | "needs_attention",
): Promise<ItemResult> {
	const result = await db
		.prepare(`UPDATE plaid_items SET ${LANDING[to]} WHERE ${guard.where}`)
		.bind(...guard.values)
		.run();
	return result.meta.changes === 1 ? "changed" : "lost-race";
}

/**
 * The no-write path, for a bank already where the event leaves it. A caller that read the state or holds a
 * lease still needs that to be true now, so this reads the row and answers lost-race when it isn't.
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
	// Step 1: the state the caller saw, or the row's state now.
	const from = options.seen ?? (await readConnection(db, itemId));
	if (from === null) return "refused";
	// Step 2: the machine's answer.
	const to = nextStateOf(from, event);
	if (to === null) return "refused";
	const guard = stillInState(itemId, from, options.lockId);
	if (to === from) {
		// Nothing to write. A caller that passed a seen state or a lease is checked; a fresh read is unchanged.
		const checked = options.seen !== undefined || options.lockId !== undefined;
		return checked ? stillTrue(db, guard) : "unchanged";
	}
	// Only disconnectStatement moves a bank to disconnected, so no event here lands there.
	if (to === "disconnected") return "refused";
	// Steps 3 and 4: the guarded write, and what it did.
	return writeIfStillIn(db, guard, to);
}

/** Plaid says the login is broken: a webhook, or a sync that met a login error and confirmed it with Plaid. */
export function markNeedsAttention(
	db: D1Database,
	itemId: number,
	options?: ItemOptions,
): Promise<ItemResult> {
	return change(db, itemId, "LOGIN_BROKEN", options);
}

/** The person fixed the login (routes/plaid.tsx). Writing ok also forgets the reminder email. */
export function clearAttention(
	db: D1Database,
	itemId: number,
): Promise<ItemResult> {
	return change(db, itemId, "RELINKED");
}

/** A sync got every page while it held its lease, so the login works (decision 173). */
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
