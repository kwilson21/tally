import { next } from "../machines/next";
import { plaidConnectionMachine } from "../machines/plaid-connection";

// The only file that writes plaid_items.status, the attention flags, connection_revision or disconnected_at. Routes
// and sync code call the named operations below; none of them writes those columns itself
// (test/plaid-item-writes.test.ts fails if one does).
//
// Every operation takes the same steps, each in its own function:
//   1. read the bank's row now (its state is derived from the status and the two flags), or check the `seen` state
//      and revision the caller read earlier
//   2. ask the machine (src/machines/plaid-connection.ts) whether the event is allowed from that state, and where it lands
//   3. write the status and both flags for that state, but only if the row still matches what was read (the state,
//      the flags and the revision), and is still held by the caller's lease
//   4. say what happened: changed, unchanged, refused or lost-race
//
// Decision 173: a login problem (attention_login) is cleared by a good sync; a cause only a relink clears
// (attention_held) is needs_relink: PENDING_EXPIRATION, PENDING_DISCONNECT, USER_PERMISSION_REVOKED, or a flag from
// before the flags. The revision counts each successful sync and each relink, so a read from before one is stale even
// when the state did not change.

export type ConnectionState =
	| "ok"
	| "login_broken"
	| "needs_relink"
	| "login_broken_and_needs_relink"
	| "disconnected";

type LiveState = Exclude<ConnectionState, "disconnected">;

const LIVE_STATES: readonly LiveState[] = [
	"ok",
	"login_broken",
	"needs_relink",
	"login_broken_and_needs_relink",
];

/** The cause a caller reports: a login error (`login`), or a cause only a relink clears (`relink`). */
export type AttentionReason = "login" | "relink";

/**
 * What an operation did:
 * - changed: the bank moved to a new state or new flags, and the row was written.
 * - unchanged: the bank is already as the event leaves it, and the row still says so, so nothing changed for the state.
 *   A good sync or a relink still counts as a completion and moves the revision.
 * - refused: the machine doesn't allow the event from this state, or there is no such bank.
 * - lost-race: the row changed, or the sync lost its lease, after it was read; nothing was written.
 */
export type ItemResult = "changed" | "unchanged" | "refused" | "lost-race";

type Event =
	| "LOGIN_BROKEN"
	| "RELINK_NEEDED"
	| "SYNC_SUCCEEDED"
	| "RELINKED"
	| "DISCONNECT";

/** What a caller read earlier: the state, and the revision it saw. */
export type Seen = { state: ConnectionState; revision: number };

export type ItemOptions = {
	/** The state and revision the caller read earlier. Without it, the operation reads the row itself. */
	seen?: Seen;
	/** The sync's lease id. Without it, the write doesn't check a lease. */
	lockId?: string;
};

/** A bank as read: its derived state, the stored values, and the revision. */
type Current = {
	state: ConnectionState;
	stored: Stored;
	revision: number;
};

/** The row as the table stores it, for the state it is in. */
type Stored = { status: "ok" | "needs_attention"; login: 0 | 1; held: 0 | 1 };

/** The row each live state is written as. */
const STORED: Record<LiveState, Stored> = {
	ok: { status: "ok", login: 0, held: 0 },
	login_broken: { status: "needs_attention", login: 1, held: 0 },
	needs_relink: { status: "needs_attention", login: 0, held: 1 },
	login_broken_and_needs_relink: {
		status: "needs_attention",
		login: 1,
		held: 1,
	},
};

// The SET part of each write, one constant per landing state. Going to ok forgets the flags and the reminder email,
// so a bank that recovers is not reminded on its next failure. A flagged bank keeps its reminder timestamp.
const LANDING: Record<LiveState, string> = {
	ok: "status = 'ok', attention_login = 0, attention_held = 0, reconnect_emailed_at = NULL",
	login_broken:
		"status = 'needs_attention', attention_login = 1, attention_held = 0",
	needs_relink:
		"status = 'needs_attention', attention_login = 0, attention_held = 1",
	login_broken_and_needs_relink:
		"status = 'needs_attention', attention_login = 1, attention_held = 1",
};

// A completion (a good sync, or a relink) moves the revision, so a read from before it is stale even if the state is the
// same. A login error or a relink-needed warning does not: nothing completed.
const COMPLETION_BUMP = "connection_revision = connection_revision + 1";

const DISCONNECTED_SET =
	"disconnected_at = datetime('now'), access_token_encrypted = X'', sync_locked_until = NULL, sync_lock_id = NULL";

/** A bank's row as the store reads it. */
type Row = {
	status: string;
	disconnected_at: string | null;
	attention_login: number;
	attention_held: number;
};

/**
 * A row's state, derived from its status and flags. An inconsistent row reads as needs_relink, so only a relink
 * clears it (decision 173).
 */
export function connectionOf(row: Row): ConnectionState {
	if (row.disconnected_at !== null) return "disconnected";
	const login = row.attention_login === 1;
	const held = row.attention_held === 1;

	if (row.status === "ok") {
		// Flags on an ok bank are a stray relink-needed flag, not a login problem: a good sync must not clear them.
		return login || held ? "needs_relink" : "ok";
	}

	if (login && held) return "login_broken_and_needs_relink";

	if (login) return "login_broken";

	// The held flag, or a flagged bank with no flags at all (inconsistent): only a relink clears it.
	return "needs_relink";
}

/** The bank's state from its row, or null when there is no such bank. */
export async function readConnection(
	db: D1Database,
	itemId: number,
): Promise<ConnectionState | null> {
	return (await readCurrent(db, itemId))?.state ?? null;
}

/** The state and revision a caller reads now, to pass back as `seen`, or null when there is no such bank. */
export async function readSeen(
	db: D1Database,
	itemId: number,
): Promise<Seen | null> {
	const current = await readCurrent(db, itemId);

	return current ? { state: current.state, revision: current.revision } : null;
}

/** Step 1: the bank's state, stored values and revision from its row, or null when there is no such bank. */
async function readCurrent(
	db: D1Database,
	itemId: number,
): Promise<Current | null> {
	const row = await db
		.prepare(
			"SELECT status, disconnected_at, attention_login, attention_held, connection_revision FROM plaid_items WHERE id = ?",
		)
		.bind(itemId)
		.first<Row & { connection_revision: number }>();

	if (!row) return null;

	return {
		state: connectionOf(row),
		stored: {
			status: row.status === "ok" ? "ok" : "needs_attention",
			login: row.attention_login === 1 ? 1 : 0,
			held: row.attention_held === 1 ? 1 : 0,
		},
		revision: row.connection_revision,
	};
}

/** Step 2: the state the machine moves to on this event, or null when it refuses. */
function nextStateOf(
	from: ConnectionState,
	event: Event,
): ConnectionState | null {
	// SAFETY: next returns a state name of plaidConnectionMachine or null, and ConnectionState lists exactly that machine's state names.
	return next(plaidConnectionMachine, from, event) as ConnectionState | null;
}

/**
 * The row must still be live, with the stored values and the revision we read, and (for a sync) held under the
 * caller's lease. Each condition and its value are pushed together, so the SQL and the values cannot fall out of step.
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
		"connection_revision = ?",
	];

	const values: unknown[] = [
		itemId,
		current.stored.status,
		current.stored.login,
		current.stored.held,
		current.revision,
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
	completes: boolean,
): Promise<ItemResult> {
	const landing = completes
		? `${LANDING[to]}, ${COMPLETION_BUMP}`
		: LANDING[to];

	const result = await db
		.prepare(`UPDATE plaid_items SET ${landing} WHERE ${guard.where}`)
		.bind(...guard.values)
		.run();

	return result.meta.changes === 1 ? "changed" : "lost-race";
}

/** The no-state-change completion: only the revision moves, and only if the row still matches what was read. */
async function bumpIfStillAsRead(
	db: D1Database,
	guard: Guard,
): Promise<ItemResult> {
	const result = await db
		.prepare(`UPDATE plaid_items SET ${COMPLETION_BUMP} WHERE ${guard.where}`)
		.bind(...guard.values)
		.run();

	return result.meta.changes === 1 ? "unchanged" : "lost-race";
}

/**
 * The no-write path for an event that is not a completion. The bank is already as the event leaves it, but the
 * caller's answer was a read, so the read must still hold now: a webhook or a sync that landed since then answers
 * lost-race.
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
	let result: ItemResult = "lost-race";

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		result = await attemptChange(db, itemId, event, options);

		if (result !== "lost-race") break;

		// Two kinds of lost race. A sync that has lost its lease is finished: another run owns the bank now, so
		// nothing more is written. A sync that still holds its lease lost only to a change of state (a webhook, or a
		// relink), so its completion is tried again against that state.
		if (options.lockId !== undefined) {
			if (!(await leaseHeld(db, itemId, options.lockId))) break;
		} else if (options.seen !== undefined) {
			// A caller that passed `seen` decided on that state, so it hears about the race at once.
			break;
		}
	}

	return result;
}

/** True when the row is still in a live state and this sync's lease is still its own. */
async function leaseHeld(
	db: D1Database,
	itemId: number,
	lockId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 AS held FROM plaid_items WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL",
		)
		.bind(itemId, lockId)
		.first();

	return row !== null;
}

/** One attempt: read the row, ask the machine, and write or confirm. */
async function attemptChange(
	db: D1Database,
	itemId: number,
	event: Event,
	options: ItemOptions,
): Promise<ItemResult> {
	// Step 1: the row now. A caller's seen state and revision must still be the row's.
	const current = await readCurrent(db, itemId);

	if (current === null) return "refused";

	if (
		options.seen !== undefined &&
		(options.seen.state !== current.state ||
			options.seen.revision !== current.revision)
	) {
		return "lost-race";
	}

	// Step 2: the machine's answer. Only disconnectStatement moves a bank to disconnected, so no event here lands there.
	const to = nextStateOf(current.state, event);

	if (to === null || to === "disconnected") return "refused";
	const guard = stillAsRead(itemId, current, options.lockId);
	// A good sync and a relink are completions: they count even when the state does not change.
	const completes = event === "SYNC_SUCCEEDED" || event === "RELINKED";

	if (alreadyAs(current, to)) {
		// Step 3, without a state change: a completion moves the revision; anything else is confirmed as read.
		return completes ? bumpIfStillAsRead(db, guard) : stillTrue(db, guard);
	}

	// Steps 3 and 4: the guarded write, and what it did.
	return writeIfStillAsRead(db, guard, to, completes);
}

/**
 * Plaid says the login needs signing in (`login`: a sync that met a login error, or a login webhook), or the bank
 * needs a relink (`relink`: PENDING_EXPIRATION, PENDING_DISCONNECT, USER_PERMISSION_REVOKED). Each sets its own flag
 * (decision 173).
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
		reason === "login" ? "LOGIN_BROKEN" : "RELINK_NEEDED",
		options,
	);
}

/** The person fixed the bank (routes/plaid.tsx). Writing ok clears both flags and forgets the reminder email. */
export function clearAttention(
	db: D1Database,
	itemId: number,
): Promise<ItemResult> {
	return change(db, itemId, "RELINKED");
}

/**
 * A sync got every page while it held its lease, so the login works (decision 173). It clears a login problem; a
 * relink-needed flag stays until a relink.
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
