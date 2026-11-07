import { next } from "../machines/next";
import { plaidConnectionMachine } from "../machines/plaid-connection";

// The only file that writes plaid_items.status, the attention flags or disconnected_at. Routes and sync code call the
// named operations below; none of them writes those columns itself (test/plaid-item-writes.test.ts fails if one does).
//
// Every operation takes the same steps, each in its own function:
//   1. read the bank's row now (its state is derived from the status and the two flags), or check the `seen` state
//   2. ask the machine (src/machines/plaid-connection.ts) whether the event is allowed from that state, and where it lands
//   3. write the status and both flags for that state, but only if the row still matches what was read, and is still
//      held by the caller's lease
//   4. say what happened: changed, unchanged, refused or lost-race
//
// Decision 173: a login problem (attention_login) is cleared by a good sync; a cause only a relink clears
// (attention_held) is an expiry warning, or a flag set before these columns. The state names say which.

export type ConnectionState =
	| "ok"
	| "login_broken"
	| "expiring"
	| "login_broken_and_expiring"
	| "disconnected";

type LiveState = Exclude<ConnectionState, "disconnected">;

const LIVE_STATES: readonly LiveState[] = [
	"ok",
	"login_broken",
	"expiring",
	"login_broken_and_expiring",
];

/** The cause a caller reports: a login error (`login`), or Plaid's expiry warning (`expiring`). */
export type AttentionReason = "login" | "expiring";

/**
 * What an operation did:
 * - changed: the bank moved to a new state (or new flags), and the row was written.
 * - unchanged: the bank is already as the event leaves it, and the row still says so, so nothing was written.
 * - refused: the machine doesn't allow the event from this state, or there is no such bank.
 * - lost-race: the row changed, or the sync lost its lease, after it was read; nothing was written.
 */
export type ItemResult = "changed" | "unchanged" | "refused" | "lost-race";

type Event =
	| "LOGIN_BROKEN"
	| "EXPIRY_WARNING"
	| "SYNC_SUCCEEDED"
	| "RELINKED"
	| "DISCONNECT";

export type ItemOptions = {
	/** The state the caller read earlier. Without it, the operation reads the row itself. */
	seen?: ConnectionState;
	/** The sync's lease id. Without it, the write doesn't check a lease. */
	lockId?: string;
};

/** The row as the table stores it, for the state it is in. */
type Stored = { status: "ok" | "needs_attention"; login: 0 | 1; held: 0 | 1 };

/** The row each live state is written as. */
const STORED: Record<LiveState, Stored> = {
	ok: { status: "ok", login: 0, held: 0 },
	login_broken: { status: "needs_attention", login: 1, held: 0 },
	expiring: { status: "needs_attention", login: 0, held: 1 },
	login_broken_and_expiring: { status: "needs_attention", login: 1, held: 1 },
};

// The SET part of each write, one constant per landing state. Going to ok forgets the flags and the reminder email,
// so a bank that recovers is not reminded on its next failure. A flagged bank keeps its reminder timestamp.
const LANDING: Record<LiveState, string> = {
	ok: "status = 'ok', attention_login = 0, attention_held = 0, reconnect_emailed_at = NULL",
	login_broken:
		"status = 'needs_attention', attention_login = 1, attention_held = 0",
	expiring:
		"status = 'needs_attention', attention_login = 0, attention_held = 1",
	login_broken_and_expiring:
		"status = 'needs_attention', attention_login = 1, attention_held = 1",
};

const DISCONNECTED_SET =
	"disconnected_at = datetime('now'), access_token_encrypted = X'', sync_locked_until = NULL, sync_lock_id = NULL";

/** A bank's row as the store reads it. */
type Row = {
	status: string;
	disconnected_at: string | null;
	attention_login: number;
	attention_held: number;
};

/** A row's state, derived from its status and flags. An inconsistent row reads as expiring, so only a relink clears it. */
export function connectionOf(row: Row): ConnectionState {
	if (row.disconnected_at !== null) return "disconnected";
	const login = row.attention_login === 1;
	const held = row.attention_held === 1;
	if (row.status === "ok") {
		// Flags on an ok bank are a stray expiry, not a login problem: a good sync must not clear them.
		return login || held ? "expiring" : "ok";
	}
	if (login && held) return "login_broken_and_expiring";
	if (login) return "login_broken";
	// The held flag, or a flagged bank with no flags at all (inconsistent): only a relink clears it.
	return "expiring";
}

/** The bank's state from its row, or null when there is no such bank. */
export async function readConnection(
	db: D1Database,
	itemId: number,
): Promise<ConnectionState | null> {
	return (await readCurrent(db, itemId))?.state ?? null;
}

/** A bank as read: its derived state, and the stored values the guard checks. */
type Current = { state: ConnectionState; stored: Stored };

/** Step 1: the bank's state and stored values from its row, or null when there is no such bank. */
async function readCurrent(
	db: D1Database,
	itemId: number,
): Promise<Current | null> {
	const row = await db
		.prepare(
			"SELECT status, disconnected_at, attention_login, attention_held FROM plaid_items WHERE id = ?",
		)
		.bind(itemId)
		.first<Row>();
	if (!row) return null;
	return {
		state: connectionOf(row),
		stored: {
			status: row.status === "ok" ? "ok" : "needs_attention",
			login: row.attention_login === 1 ? 1 : 0,
			held: row.attention_held === 1 ? 1 : 0,
		},
	};
}

/** Step 2: the state the machine moves to on this event, or null when it refuses. */
function nextStateOf(
	from: ConnectionState,
	event: Event,
): ConnectionState | null {
	return next(plaidConnectionMachine, from, event) as ConnectionState | null;
}

/**
 * The row must still be live, with the stored values we read, and (for a sync) held under the caller's lease. Each
 * condition and its value are pushed together, so the SQL and the values cannot fall out of step.
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
		"attention_login = ?",
		"attention_held = ?",
	];
	const values: unknown[] = [
		itemId,
		current.stored.status,
		current.stored.login,
		current.stored.held,
	];
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
	to: LiveState,
): Promise<ItemResult> {
	const result = await db
		.prepare(`UPDATE plaid_items SET ${LANDING[to]} WHERE ${guard.where}`)
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

/** True when the stored values already are the ones the landing state is written as. */
function alreadyAs(current: Current, to: LiveState): boolean {
	const want = STORED[to];
	return (
		current.stored.status === want.status &&
		current.stored.login === want.login &&
		current.stored.held === want.held
	);
}

/** How many times a lost race is tried again, when the store read the row itself (decision 173). */
const MAX_ATTEMPTS = 3;

/**
 * Runs the four steps for one event. Every named operation below is this with a different event. A lost race is
 * retried against the latest state, but only when the store read the row itself: a caller that passed `seen`, or
 * holds a lease, decided on that state, so it hears about the race at once.
 */
async function change(
	db: D1Database,
	itemId: number,
	event: Event,
	options: ItemOptions = {},
): Promise<ItemResult> {
	const retryable = options.seen === undefined && options.lockId === undefined;
	let result: ItemResult = "lost-race";
	for (let attempt = 1; attempt <= (retryable ? MAX_ATTEMPTS : 1); attempt++) {
		result = await attemptChange(db, itemId, event, options);
		if (result !== "lost-race") break;
	}
	return result;
}

/** One attempt: read the row, ask the machine, and write or confirm. */
async function attemptChange(
	db: D1Database,
	itemId: number,
	event: Event,
	options: ItemOptions,
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
	const guard = stillAsRead(itemId, current, options.lockId);
	// Step 3, without a write: the bank is already as the event leaves it, and the read is confirmed.
	if (alreadyAs(current, to)) return stillTrue(db, guard);
	// Steps 3 and 4: the guarded write, and what it did.
	return writeIfStillAsRead(db, guard, to);
}

/**
 * Plaid says the login needs signing in (`login`: a sync that met a login error, or a login webhook), or Plaid
 * warns that it is about to expire (`expiring`). Each is its own event, so each keeps its own flag (decision 173).
 */
export function markNeedsAttention(
	db: D1Database,
	itemId: number,
	reason: AttentionReason,
	options?: ItemOptions,
): Promise<ItemResult> {
	return change(
		db,
		itemId,
		reason === "login" ? "LOGIN_BROKEN" : "EXPIRY_WARNING",
		options,
	);
}

/** The person fixed the login (routes/plaid.tsx). Writing ok clears both flags and forgets the reminder email. */
export function clearAttention(
	db: D1Database,
	itemId: number,
): Promise<ItemResult> {
	return change(db, itemId, "RELINKED");
}

/**
 * A sync got every page while it held its lease, so the login works (decision 173). It clears a login problem; an
 * expiry warning, or a flag from before the flags, stays until a relink.
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
 * keep it last: its change count says whether this call disconnected the bank. Disconnect is allowed from every
 * live state, and this statement is built without reading the row, so it asks the machine about each live state
 * and guards on "not disconnected yet".
 */
export function disconnectStatement(
	db: D1Database,
	itemId: number,
): D1PreparedStatement {
	for (const live of LIVE_STATES) {
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
