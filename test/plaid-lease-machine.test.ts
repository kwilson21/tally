import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { disconnectStatement } from "../src/plaid/item-store";
import { resetDemo } from "../src/demo/reset";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { next } from "../src/machines/next";
import {
	extendLeaseSql,
	leaseStateOf,
	type PlaidLeaseState,
	plaidLeaseMachine,
	releaseLeaseSql,
	type StoredLease,
	takeLeaseSql,
	ownsLeaseSql,
} from "../src/machines/plaid-lease";
import { present } from "./helpers/present";

// The bank sync lease as a machine (issue #1100): four states, derived from the three columns a sync reads. The tests
// walk the machine's own moves, pin leaseStateOf on both sides of the lease boundary, and run every writer's SQL form
// from every state against a real D1 row. The writers in src/plaid are checked in their own tests as before.

const db = env.DB;
const TODAY = "2026-11-14";
const PAST = "2000-01-01 00:00:00";
const FUTURE = "2999-01-01 00:00:00";
const HOLDER = "lock-a";
const STALE = "lock-stale";
const NEW = "lock-new";

const EVENTS = ["TAKE", "EXTEND", "RELEASE", "DISCONNECT"] as const;
const STATES = ["free", "held", "expired", "disconnected"] as const;

/** Every move the machine makes, as [from, event, to]. Any other state and event pair is refused. */
const MOVES = [
	["free", "TAKE", "held"],
	["free", "DISCONNECT", "disconnected"],
	["held", "EXTEND", "held"],
	["held", "RELEASE", "free"],
	["held", "DISCONNECT", "disconnected"],
	["expired", "TAKE", "held"],
	["expired", "EXTEND", "held"],
	["expired", "RELEASE", "free"],
	["expired", "DISCONNECT", "disconnected"],
] as const;

describe("the plaid lease machine", () => {
	it("starts free", () => {
		expect(plaidLeaseMachine.config.initial).toBe("free");
	});

	it.each(STATES)("%s takes exactly the events its moves list", (state) => {
		for (const event of EVENTS) {
			const move = MOVES.find(([from, on]) => from === state && on === event);

			expect(next(plaidLeaseMachine, state, event)).toBe(move?.[2] ?? null);
		}
	});

	it("disconnected refuses every event, for good", () => {
		for (const event of EVENTS) {
			expect(next(plaidLeaseMachine, "disconnected", event)).toBeNull();
		}
	});

	it("TAKE is refused while a lease is held, and EXTEND and RELEASE are refused on a free bank", () => {
		expect(next(plaidLeaseMachine, "held", "TAKE")).toBeNull();
		expect(next(plaidLeaseMachine, "free", "EXTEND")).toBeNull();
		expect(next(plaidLeaseMachine, "free", "RELEASE")).toBeNull();
	});

	it("EXTEND by an expired holder revives the lease: the machine says what the SQL does", () => {
		// extendLeaseSql checks the lock id and not the time, so a lease nobody has taken since it ran out still moves.
		expect(next(plaidLeaseMachine, "expired", "EXTEND")).toBe("held");
	});
});

describe("leaseStateOf", () => {
	const NOW = Date.parse("2026-11-14T12:00:00Z");

	const row = (over: Partial<StoredLease>): StoredLease => ({
		lockId: null,
		lockedUntil: null,
		disconnectedAt: null,
		...over,
	});

	it("reads a lease that ends exactly now as held: SQLite's strict < makes only an earlier lease expired", () => {
		const state = leaseStateOf(
			row({ lockId: HOLDER, lockedUntil: "2026-11-14 12:00:00" }),
			NOW,
		);

		expect(state).toBe("held");
	});

	it("reads a lease one whole second in the past as expired", () => {
		const state = leaseStateOf(
			row({ lockId: HOLDER, lockedUntil: "2026-11-14 11:59:59" }),
			NOW,
		);

		expect(state).toBe("expired");
	});

	it("truncates now to the whole second, as datetime('now') does: 999 ms after a lease's second is still held", () => {
		const lease = row({ lockId: HOLDER, lockedUntil: "2026-11-14 11:59:59" });

		expect(leaseStateOf(lease, NOW - 1)).toBe("held");
		expect(leaseStateOf(lease, NOW - 1000)).toBe("expired");
	});

	it("reads a lease 1 ms past its second as expired only once the clock reaches the next second", () => {
		const lease = row({ lockId: HOLDER, lockedUntil: "2026-11-14 12:00:00" });

		expect(leaseStateOf(lease, NOW + 999)).toBe("held");
		expect(leaseStateOf(lease, NOW + 1000)).toBe("expired");
	});

	it("reads a lock id with no lease as expired, and a lease with no lock id as held (no production write makes that row)", () => {
		expect(leaseStateOf(row({ lockId: HOLDER }), NOW)).toBe("expired");
		expect(
			leaseStateOf(row({ lockedUntil: "2026-11-14 13:00:00" }), NOW),
		).toBe("held");
	});

	it("reads no lock and no live lease as free, even with a past lease left behind", () => {
		expect(leaseStateOf(row({}), NOW)).toBe("free");
		expect(leaseStateOf(row({ lockedUntil: PAST }), NOW)).toBe("free");
	});

	it("reads a disconnected bank as disconnected, whatever its lease columns say", () => {
		const disconnectedAt = "2026-11-13 09:00:00";

		expect(
			leaseStateOf(
				row({ disconnectedAt, lockId: HOLDER, lockedUntil: FUTURE }),
				NOW,
			),
		).toBe("disconnected");
		expect(leaseStateOf(row({ disconnectedAt }), NOW)).toBe("disconnected");
	});
});

// The real D1 walk. Each seeded row is a plaid_items row in one state; each writer's SQL form runs against it, and the
// stored columns must match the machine's move (or stay as they were when the machine refuses).

type Seed = {
	label: string;
	state: PlaidLeaseState;
	lockId: string | null;
	lockedUntil: string | null;
	disconnected: boolean;
};

const SEEDS: Seed[] = [
	{ label: "free with no lease", state: "free", lockId: null, lockedUntil: null, disconnected: false },
	{ label: "free with a lease that has passed", state: "free", lockId: null, lockedUntil: PAST, disconnected: false },
	{ label: "held", state: "held", lockId: HOLDER, lockedUntil: FUTURE, disconnected: false },
	{ label: "held with no lock id (no production write makes it)", state: "held", lockId: null, lockedUntil: FUTURE, disconnected: false },
	{ label: "expired with a lease that has passed", state: "expired", lockId: HOLDER, lockedUntil: PAST, disconnected: false },
	{ label: "expired with no lease", state: "expired", lockId: HOLDER, lockedUntil: null, disconnected: false },
	{ label: "disconnected", state: "disconnected", lockId: null, lockedUntil: null, disconnected: true },
];

async function seed(item: Seed): Promise<number> {
	const row = present(
		await db
			.prepare(
				`INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status)
				 VALUES (?, 'Bank', 'person@example.com', 'ok') RETURNING id`,
			)
			.bind(new Uint8Array([1, 2, 3]))
			.first<{ id: number }>(),
	);

	await db
		.prepare(
			"UPDATE plaid_items SET sync_lock_id = ?, sync_locked_until = ?, disconnected_at = CASE WHEN ? THEN datetime('now') END WHERE id = ?",
		)
		.bind(item.lockId, item.lockedUntil, item.disconnected ? 1 : 0, row.id)
		.run();

	return row.id;
}

async function columnsOf(id: number): Promise<StoredLease> {
	return present(
		await db
			.prepare(
				"SELECT sync_lock_id AS lockId, sync_locked_until AS lockedUntil, disconnected_at AS disconnectedAt FROM plaid_items WHERE id = ?",
			)
			.bind(id)
			.first<StoredLease>(),
	);
}

/** Runs one writer's SQL form, as the caller does, and returns the rows it changed. */
async function write(
	event: (typeof EVENTS)[number],
	id: number,
	caller: string,
): Promise<number> {
	const statement = {
		TAKE: db.prepare(takeLeaseSql("?", "?")).bind(caller, id),
		EXTEND: db.prepare(extendLeaseSql("?", "?")).bind(id, caller),
		RELEASE: db.prepare(releaseLeaseSql("?", "?")).bind(id, caller),
		DISCONNECT: disconnectStatement(db, id),
	}[event];

	return (await statement.run()).meta.changes;
}

describe("every writer from every state, against the machine", () => {
	for (const item of SEEDS) {
		for (const event of EVENTS) {
			it(`${event} from ${item.label}`, async () => {
				const id = await seed(item);
				const before = await columnsOf(id);
				const expected = next(plaidLeaseMachine, item.state, event);

				// TAKE and DISCONNECT need no lock id. EXTEND and RELEASE are the holder's moves, so they need one: a row with
				// no lock id has no holder, and the only caller is a stale one.
				const moves =
					expected !== null &&
					(event === "TAKE" || event === "DISCONNECT" || item.lockId !== null);

				const caller = event === "TAKE" ? NEW : (item.lockId ?? STALE);
				const changes = await write(event, id, caller);
				const after = await columnsOf(id);

				if (!moves) {
					expect(changes).toBe(0);
					expect(after).toEqual(before);
					return;
				}

				expect(changes).toBe(1);
				expect(leaseStateOf(after, Date.now())).toBe(expected);

				if (event === "TAKE") expect(after.lockId).toBe(NEW);
				if (event === "EXTEND") expect(after.lockId).toBe(HOLDER);
				if (event === "RELEASE")
					expect(after).toMatchObject({ lockId: null, lockedUntil: null });
			});
		}
	}

	for (const item of SEEDS) {
		it(`a stale lock id changes nothing on ${item.label}`, async () => {
			const id = await seed(item);
			const before = await columnsOf(id);

			expect(await write("EXTEND", id, STALE)).toBe(0);
			expect(await write("RELEASE", id, STALE)).toBe(0);
			expect(await columnsOf(id)).toEqual(before);
		});
	}
});

describe("OWNS, the guard every page write carries", () => {
	const owns = async (id: number, caller: string): Promise<boolean> => {
		const row = present(
			await db
				.prepare(`SELECT ${ownsLeaseSql("?1", "?2")} AS owns`)
				.bind(id, caller)
				.first<{ owns: number }>(),
		);

		return row.owns === 1;
	};

	for (const item of SEEDS) {
		it(`is true only for the holder, and false for a stale id, on ${item.label}`, async () => {
			const id = await seed(item);

			expect(await owns(id, STALE)).toBe(false);

			// The holder owns the lock while the machine lets it extend: held, or expired and not yet taken by anyone.
			if (item.lockId !== null) {
				const holderMayExtend = next(plaidLeaseMachine, item.state, "EXTEND") !== null;

				expect(await owns(id, item.lockId)).toBe(holderMayExtend);
			}
		});
	}
});

describe("two runs over one bank", () => {
	beforeAll(async () => {
		await resetDemo(db, TODAY);
	});

	const bank = async (): Promise<number> =>
		seed({ label: "a free bank", state: "free", lockId: null, lockedUntil: null, disconnected: false });

	const take = async (id: number, lock: string) =>
		(await db.prepare(takeLeaseSql("?", "?")).bind(lock, id).run()).meta.changes;

	const expire = (id: number) =>
		db
			.prepare("UPDATE plaid_items SET sync_locked_until = ? WHERE id = ?")
			.bind(PAST, id)
			.run();

	const rowExists = async (plaidId: string) =>
		(await db
			.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = ?")
			.bind(plaidId)
			.first()) !== null;

	it("two takes at once on a free bank give the lease to exactly one run", async () => {
		const id = await bank();

		const changes = await Promise.all([
			take(id, "lock-one"),
			take(id, "lock-two"),
		]);

		expect(changes.sort()).toEqual([0, 1]);

		const winner = present(
			await db
				.prepare("SELECT sync_lock_id AS lockId FROM plaid_items WHERE id = ?")
				.bind(id)
				.first<{ lockId: string }>(),
		).lockId;

		expect(["lock-one", "lock-two"]).toContain(winner);
	});

	it("a holder whose lease ran out and was taken by another run writes nothing and cannot extend", async () => {
		const id = await bank();
		const pending = "pend-stale-holder";
		const posted = "post-stale-holder";

		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
				 VALUES (1, ?, -500, 'CORNER COFFEE', ?, 1, 'test'), (1, ?, -500, 'CORNER COFFEE', ?, 0, 'test')`,
			)
			.bind(TODAY, pending, TODAY, posted)
			.run();

		const merge = (lock: string) =>
			mergePendingIntoPosted(db, id, lock, pending, {
				id: posted,
				cents: -500,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			});

		expect(await take(id, HOLDER)).toBe(1);
		await expire(id);
		expect(await take(id, NEW)).toBe(1);

		await db.batch(merge(HOLDER));

		expect(await rowExists(pending)).toBe(true);
		expect(await write("EXTEND", id, HOLDER)).toBe(0);
		expect(await write("RELEASE", id, HOLDER)).toBe(0);
		expect(
			present(
				await db
					.prepare(`SELECT ${ownsLeaseSql("?1", "?2")} AS owns`)
					.bind(id, HOLDER)
					.first<{ owns: number }>(),
			).owns,
		).toBe(0);
		expect((await columnsOf(id)).lockId).toBe(NEW);

		// The run that now holds the lease completes the merge, and the pending row goes.
		await db.batch(merge(NEW));
		expect(await rowExists(pending)).toBe(false);
	});

	it("a run that never took the lease writes nothing", async () => {
		const id = await bank();
		const pending = "pend-never-took";
		const posted = "post-never-took";

		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
				 VALUES (1, ?, -700, 'CORNER COFFEE', ?, 1, 'test'), (1, ?, -700, 'CORNER COFFEE', ?, 0, 'test')`,
			)
			.bind(TODAY, pending, TODAY, posted)
			.run();

		await take(id, HOLDER);
		await db.batch(
			mergePendingIntoPosted(db, id, STALE, pending, {
				id: posted,
				cents: -700,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			}),
		);

		expect(await rowExists(pending)).toBe(true);
		expect((await columnsOf(id)).lockId).toBe(HOLDER);
	});
});
