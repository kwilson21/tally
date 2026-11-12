import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearAttention,
	connectionOf,
	disconnectStatement,
	markNeedsAttention,
	markSyncSucceeded,
	readConnection,
} from "../src/plaid/item-store";
import { isMethod, present } from "./helpers/present";

const REMINDED = "2026-10-06 04:00:00";
const LOCK = "lease-a";

/**
 * A bank row. A flagged bank has the login flag unless a test says otherwise; an ok bank has no flags. `held` is the
 * flag only a relink clears (an expiry warning, or a flag from before the flags).
 */
async function addBank(
	status: "ok" | "needs_attention",
	options: {
		reminded?: string | null;
		lockId?: string | null;
		name?: string;
		login?: boolean;
		held?: boolean;
	} = {},
): Promise<number> {
	const login = options.login ?? status === "needs_attention";
	const held = options.held ?? false;

	const row = await env.DB.prepare(
		`INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status, reconnect_emailed_at, sync_lock_id, attention_login, attention_held)
		 VALUES (?, ?, 'person@example.com', ?, ?, ?, ?, ?) RETURNING id`,
	)
		.bind(
			new Uint8Array([1, 2, 3]),
			options.name ?? "Bank",
			status,
			options.reminded ?? null,
			options.lockId ?? null,
			login ? 1 : 0,
			held ? 1 : 0,
		)
		.first<{ id: number }>();

	return present(row?.id);
}

async function rowOf(id: number) {
	return env.DB.prepare(
		"SELECT status, disconnected_at, reconnect_emailed_at, attention_login, attention_held, sync_lock_id, sync_locked_until, length(access_token_encrypted) AS token_length, connection_revision FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first<{
			status: string;
			disconnected_at: string | null;
			reconnect_emailed_at: string | null;
			attention_login: number;
			attention_held: number;
			sync_lock_id: string | null;
			sync_locked_until: string | null;
			token_length: number;
			connection_revision: number;
		}>();
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM plaid_items").run();
});

describe("connectionOf (the state a row is in)", () => {
	// A row's state comes from its status, its disconnected_at and its two flags. An inconsistent row (status ok with a
	// flag, or needs_attention with no login flag) reads as needs_relink, so only a relink clears it (decision 173).
	it.each([
		["ok", 0, 0, null, "ok"],
		["ok", 1, 0, null, "needs_relink"],
		["ok", 0, 1, null, "needs_relink"],
		["ok", 1, 1, null, "needs_relink"],
		["needs_attention", 1, 0, null, "login_broken"],
		["needs_attention", 0, 1, null, "needs_relink"],
		["needs_attention", 1, 1, null, "login_broken_and_needs_relink"],
		["needs_attention", 0, 0, null, "needs_relink"],
		["ok", 0, 0, REMINDED, "disconnected"],
		["needs_attention", 1, 1, REMINDED, "disconnected"],
	] as const)(
		"status %s, login %i, held %i, disconnected %s reads as %s",
		(status, login, held, disconnectedAt, expected) => {
			expect(
				connectionOf({
					status,
					disconnected_at: disconnectedAt,
					attention_login: login,
					attention_held: held,
				}),
			).toBe(expected);
		},
	);
});

describe("markNeedsAttention", () => {
	it("moves an ok bank to login_broken, with the login flag set", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "login")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 1,
			attention_held: 0,
		});
	});

	it("reports unchanged, and writes nothing, when the bank already needs attention for a login", async () => {
		const id = await addBank("needs_attention", { reminded: REMINDED });
		expect(await markNeedsAttention(env.DB, id, "login")).toBe("unchanged");
		expect((await rowOf(id))?.reconnect_emailed_at).toBe(REMINDED);
	});

	it("is refused for a disconnected bank and for a bank that is not there", async () => {
		const id = await addBank("ok");
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(id)
			.run();
		expect(await markNeedsAttention(env.DB, id, "login")).toBe("refused");
		expect(await markNeedsAttention(env.DB, 999_999, "login")).toBe("refused");
		expect((await rowOf(id))?.status).toBe("ok");
	});

	it("writes nothing when the caller's seen state is stale (the row moved on)", async () => {
		const id = await addBank("needs_attention", { reminded: REMINDED });
		expect(
			await markNeedsAttention(env.DB, id, "login", {
				seen: { state: "ok", revision: 0 },
			}),
		).toBe("lost-race");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			reconnect_emailed_at: REMINDED,
		});
	});

	it("answers lost-race when the seen state is no longer true, even if the event would leave the row as it was", async () => {
		// The caller read login_broken, but a sync has since made the bank ok.
		const id = await addBank("ok");
		expect(
			await markNeedsAttention(env.DB, id, "login", {
				seen: { state: "login_broken", revision: 0 },
			}),
		).toBe("lost-race");
		expect((await rowOf(id))?.status).toBe("ok");
	});

	it("writes nothing when the sync no longer holds its lease", async () => {
		const id = await addBank("ok", { lockId: "someone-else" });
		expect(
			await markNeedsAttention(env.DB, id, "login", { lockId: LOCK }),
		).toBe("lost-race");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			sync_lock_id: "someone-else",
		});
	});

	it("uses the seen state the caller passed", async () => {
		const id = await addBank("ok");
		expect(
			await markNeedsAttention(env.DB, id, "login", {
				seen: { state: "ok", revision: 0 },
			}),
		).toBe("changed");
	});
});

describe("clearAttention", () => {
	it("moves a flagged bank to ok, clears both flags and forgets the reminder email", async () => {
		const id = await addBank("needs_attention", {
			reminded: REMINDED,
			held: true,
		});

		expect(await clearAttention(env.DB, id)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
			reconnect_emailed_at: null,
		});
	});

	it("reports unchanged for a bank already ok, and leaves its row alone", async () => {
		const id = await addBank("ok");
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_cursor = 'kept' WHERE id = ?",
		)
			.bind(id)
			.run();
		expect(await clearAttention(env.DB, id)).toBe("unchanged");
		expect(
			await env.DB.prepare("SELECT sync_cursor FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ sync_cursor: "kept" });
	});

	it("is refused for a disconnected bank", async () => {
		const id = await addBank("needs_attention", { reminded: REMINDED });
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(id)
			.run();
		expect(await clearAttention(env.DB, id)).toBe("refused");
		expect((await rowOf(id))?.reconnect_emailed_at).toBe(REMINDED);
	});

	it("retries a relink that races a webhook's flag, so the relink still lands", async () => {
		const id = await addBank("ok");

		// A relink on an ok bank is a completion: it writes the revision, and that write is where the race lands.
		const db = raceBefore(
			"UPDATE plaid_items SET connection_revision = connection_revision + 1",
			"UPDATE plaid_items SET status = 'needs_attention', attention_login = 1, attention_held = 0 WHERE id = ?",
			id,
		);

		expect(await clearAttention(db, id)).toBe("changed");
		expect((await rowOf(id))?.status).toBe("ok");
	});
});

describe("markSyncSucceeded", () => {
	it("clears a login problem and the reminder when a sync finishes", async () => {
		const id = await addBank("needs_attention", {
			reminded: REMINDED,
			lockId: LOCK,
		});

		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
			reconnect_emailed_at: null,
		});
	});

	it("reports unchanged, and leaves the row alone, for an ok bank", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect((await rowOf(id))?.status).toBe("ok");
	});

	it("answers lost-race for an ok bank when this run no longer holds the lease", async () => {
		const id = await addBank("ok", { lockId: "newer-run" });
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("lost-race");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			sync_lock_id: "newer-run",
		});
	});

	it("writes nothing when a newer run has taken the lease", async () => {
		const id = await addBank("needs_attention", {
			reminded: REMINDED,
			lockId: "newer-run",
		});

		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("lost-race");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			reconnect_emailed_at: REMINDED,
			sync_lock_id: "newer-run",
		});
	});

	it("is refused for a disconnected bank", async () => {
		const id = await addBank("needs_attention", { lockId: LOCK });
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(id)
			.run();
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("refused");
	});
});

describe("readConnection", () => {
	it("reads each state, and null for no bank", async () => {
		const ok = await addBank("ok");
		const login = await addBank("needs_attention");

		const held = await addBank("needs_attention", {
			login: false,
			held: true,
		});

		const gone = await addBank("ok");
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(gone)
			.run();
		expect(await readConnection(env.DB, ok)).toBe("ok");
		expect(await readConnection(env.DB, login)).toBe("login_broken");
		expect(await readConnection(env.DB, held)).toBe("needs_relink");
		expect(await readConnection(env.DB, gone)).toBe("disconnected");
		expect(await readConnection(env.DB, 999_999)).toBeNull();
	});
});

describe("disconnectStatement", () => {
	it("blanks the token and clears the lease, and reports the change", async () => {
		const id = await addBank("needs_attention", { lockId: LOCK });
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes') WHERE id = ?",
		)
			.bind(id)
			.run();
		const [result] = await env.DB.batch([disconnectStatement(env.DB, id)]);
		expect(result?.meta.changes).toBe(1);
		expect(await rowOf(id)).toMatchObject({
			token_length: 0,
			sync_lock_id: null,
			sync_locked_until: null,
		});
		expect((await rowOf(id))?.disconnected_at).not.toBeNull();
	});

	it("changes nothing on a second run", async () => {
		const id = await addBank("ok");
		await env.DB.batch([disconnectStatement(env.DB, id)]);
		const [again] = await env.DB.batch([disconnectStatement(env.DB, id)]);
		expect(again?.meta.changes).toBe(0);
	});

	it("runs inside a db.batch, as the last statement whose change count the disconnect route reads", async () => {
		const id = await addBank("ok", { reminded: REMINDED });

		const results = await env.DB.batch([
			env.DB.prepare(
				"UPDATE plaid_items SET reconnect_emailed_at = NULL WHERE id = ?",
			).bind(id),
			disconnectStatement(env.DB, id),
		]);

		expect(results.map((result) => result.meta.changes)).toEqual([1, 1]);
		expect((await rowOf(id))?.disconnected_at).not.toBeNull();
	});
});

/**
 * The database a store operation sees, where a webhook or a sync lands between the operation's read and its guarded
 * statement: `before` runs just ahead of each statement whose SQL starts with `prefix`, for at most `times` firings.
 * `fired` counts the firings, so a test can see how many attempts the store made.
 */
function raceBefore(
	prefix: string,
	before: string,
	id: number,
	options: { times?: number; fired?: { count: number } } = {},
): D1Database {
	const fired = options.fired ?? { count: 0 };
	const times = options.times ?? 1;

	const fire = async (target: D1Database) => {
		fired.count += 1;
		await target.prepare(before).bind(id).run();
	};

	return new Proxy(env.DB, {
		get(target, prop: keyof D1Database) {
			if (prop !== "prepare") {
				const value = target[prop];

				return isMethod(value) ? value.bind(target) : value;
			}

			return (sql: string) => {
				const statement = target.prepare(sql);

				if (!sql.startsWith(prefix) || fired.count >= times) return statement;

				// SAFETY: the stub has only the bind(...).run() and bind(...).first() paths the code under test takes for this SQL.
				return {
					bind: (...values: unknown[]) => {
						const bound = statement.bind(...values);

						return {
							run: async () => {
								await fire(target);

								return bound.run();
							},
							first: async () => {
								await fire(target);

								return bound.first();
							},
						};
					},
				} as D1PreparedStatement;
			};
		},
	});
}

const WRITE_LOGIN_AND_NEEDS_RELINK =
	"UPDATE plaid_items SET status = 'needs_attention', attention_login = 1, attention_held = 1";

const WRITE_OK =
	"UPDATE plaid_items SET status = 'ok', attention_login = 0, attention_held = 0, reconnect_emailed_at = NULL WHERE id = ?";

describe("a lost race is retried against the latest state (decision 173)", () => {
	it("an expiry warning racing a successful sync ends in needs_relink, not lost", async () => {
		// The bank reads login_broken. A sync makes it ok before the write; the retry then sees ok and writes needs_relink.
		const id = await addBank("needs_attention", { lockId: undefined });
		const db = raceBefore(WRITE_LOGIN_AND_NEEDS_RELINK, WRITE_OK, id);
		expect(await markNeedsAttention(db, id, "relink")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
		});
	});

	it("a login error racing a relink ends flagged for the login problem alone", async () => {
		// The bank reads needs_relink. A relink makes it ok before the write; the retry sees ok and writes a login error.
		const id = await addBank("needs_attention", { login: false, held: true });

		const db = raceBefore(
			"UPDATE plaid_items SET status = 'needs_attention', attention_login = 1, attention_held = 1",
			"UPDATE plaid_items SET status = 'ok', attention_login = 0, attention_held = 0, reconnect_emailed_at = NULL WHERE id = ?",
			id,
		);

		expect(await markNeedsAttention(db, id, "login")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 1,
			attention_held: 0,
		});
	});

	it("three consecutive lost races end in lost-race, after exactly three attempts", async () => {
		const id = await addBank("ok");
		const fired = { count: 0 };

		// Every write loses: the held flag is flipped ahead of each attempt's guarded write.
		const db = raceBefore(
			"UPDATE plaid_items SET status = 'needs_attention'",
			"UPDATE plaid_items SET attention_held = 1 - attention_held WHERE id = ?",
			id,
			{ times: 3, fired },
		);

		expect(await markNeedsAttention(db, id, "relink")).toBe("lost-race");
		expect(fired.count).toBe(3);
	});

	it("a caller that passed seen is not retried: its lost race comes back at once", async () => {
		const id = await addBank("ok");
		const fired = { count: 0 };

		const db = raceBefore(
			"UPDATE plaid_items SET status = 'needs_attention'",
			"UPDATE plaid_items SET attention_held = 1 WHERE id = ?",
			id,
			{ times: 3, fired },
		);

		expect(
			await markNeedsAttention(db, id, "relink", {
				seen: { state: "ok", revision: 0 },
			}),
		).toBe("lost-race");
		expect(fired.count).toBe(1);
	});

	it("a sync holding its lease is not retried either", async () => {
		const id = await addBank("needs_attention", { lockId: LOCK });
		const fired = { count: 0 };

		const db = raceBefore(
			"UPDATE plaid_items SET status = 'ok'",
			"UPDATE plaid_items SET sync_lock_id = 'newer-run' WHERE id = ?",
			id,
			{ times: 3, fired },
		);

		expect(await markSyncSucceeded(db, id, LOCK)).toBe("lost-race");
		// One attempt only: the lease is gone, so the store does not read and write again.
		expect(fired.count).toBe(1);
	});
});

describe("a sync's completion that loses a race (decision 173)", () => {
	// The sync read an ok bank under its lease. A webhook or a relink changes the bank before the completion write.
	it("a login error that lands before the completion is superseded: the bank ends ok, and the revision moves", async () => {
		const id = await addBank("ok", { lockId: LOCK });

		const db = raceBefore(
			"UPDATE plaid_items SET",
			"UPDATE plaid_items SET status = 'needs_attention', attention_login = 1, attention_held = 0 WHERE id = ?",
			id,
		);

		expect(await markSyncSucceeded(db, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
			connection_revision: 1,
		});
	});

	it("a needs-relink flag that lands before the completion survives it, and stays flagged for a relink", async () => {
		const id = await addBank("ok", { lockId: LOCK });

		const db = raceBefore(
			"UPDATE plaid_items SET",
			"UPDATE plaid_items SET status = 'needs_attention', attention_login = 0, attention_held = 1 WHERE id = ?",
			id,
		);

		expect(await markSyncSucceeded(db, id, LOCK)).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
			connection_revision: 1,
		});
	});

	it("a lost lease in that window writes nothing, and the result is lost-race", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		const fired = { count: 0 };

		const db = raceBefore(
			"UPDATE plaid_items SET",
			"UPDATE plaid_items SET sync_lock_id = 'newer-run' WHERE id = ?",
			id,
			{ fired },
		);

		expect(await markSyncSucceeded(db, id, LOCK)).toBe("lost-race");
		expect(fired.count).toBe(1);
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			connection_revision: 0,
			sync_lock_id: "newer-run",
		});
	});

	it("three consecutive state changes end lost-race after exactly three writes", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		const fired = { count: 0 };

		// Every completion write loses: the held flag is flipped just ahead of each attempt's write.
		const db = raceBefore(
			"UPDATE plaid_items SET",
			"UPDATE plaid_items SET attention_held = 1 - attention_held WHERE id = ?",
			id,
			{ times: 3, fired },
		);

		expect(await markSyncSucceeded(db, id, LOCK)).toBe("lost-race");
		expect(fired.count).toBe(3);
	});
});

describe("the connection revision (decision 173)", () => {
	it("a good sync on an ok bank moves the revision, though the state does not change", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		expect((await rowOf(id))?.connection_revision).toBe(0);
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect((await rowOf(id))?.connection_revision).toBe(1);
	});

	it("a relink on an ok bank moves the revision, though the state does not change", async () => {
		const id = await addBank("ok");
		expect(await clearAttention(env.DB, id)).toBe("unchanged");
		expect((await rowOf(id))?.connection_revision).toBe(1);
	});

	it("a good sync on a bank that needs a relink keeps its flags and reminder, and moves the revision", async () => {
		const id = await addBank("needs_attention", {
			login: false,
			held: true,
			reminded: REMINDED,
			lockId: LOCK,
		});

		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_held: 1,
			reconnect_emailed_at: REMINDED,
			connection_revision: 1,
		});
	});

	it("a seen state from before a no-op sync is stale, so the caller's write is dropped", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		await markSyncSucceeded(env.DB, id, LOCK);
		expect(
			await markNeedsAttention(env.DB, id, "login", {
				seen: { state: "ok", revision: 0 },
			}),
		).toBe("lost-race");
		expect((await rowOf(id))?.status).toBe("ok");
	});
});

describe("USER_PERMISSION_REVOKED is a relink, not a login problem (decision 173)", () => {
	it("a revoked permission survives a good sync, flagged, with its reminder", async () => {
		const id = await addBank("needs_attention", {
			login: false,
			held: true,
			reminded: REMINDED,
			lockId: LOCK,
		});

		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
			reconnect_emailed_at: REMINDED,
		});
	});

	it("a relink clears a revoked permission", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "relink")).toBe("changed");
		expect(await clearAttention(env.DB, id)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
		});
	});
});

describe("the two attention flags (decision 173)", () => {
	it("a login problem, then an expiry warning, then a good sync leaves the bank flagged for the expiry", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		await markNeedsAttention(env.DB, id, "login");
		await markNeedsAttention(env.DB, id, "relink");
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
		});
	});

	it("an expiry warning, then a login problem, then a good sync leaves the bank flagged for the expiry", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		await markNeedsAttention(env.DB, id, "relink");
		await markNeedsAttention(env.DB, id, "login");
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
		});
	});

	it("a login problem alone is cleared by a good sync", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		await markNeedsAttention(env.DB, id, "login");
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
		});
	});

	it("a relink clears both flags", async () => {
		const id = await addBank("ok", { lockId: LOCK });
		await markNeedsAttention(env.DB, id, "login");
		await markNeedsAttention(env.DB, id, "relink");
		expect(await clearAttention(env.DB, id)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_login: 0,
			attention_held: 0,
		});
	});

	it("a flag held from before the flags survives a good sync, with its reminder", async () => {
		const id = await addBank("needs_attention", {
			login: false,
			held: true,
			reminded: REMINDED,
			lockId: LOCK,
		});

		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_held: 1,
			reconnect_emailed_at: REMINDED,
		});
	});

	it("an expiry warning on an ok bank flags it with the held flag only", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "relink")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
		});
	});

	it("an expiry warning does not clear a login problem already set", async () => {
		const id = await addBank("needs_attention", { reminded: REMINDED });
		expect(await markNeedsAttention(env.DB, id, "relink")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			attention_login: 1,
			attention_held: 1,
			reconnect_emailed_at: REMINDED,
		});
	});

	it("a sync on an ok bank with a stray held flag is treated as an expiry: the good sync keeps it flagged", async () => {
		const id = await addBank("ok", { lockId: LOCK, held: true });
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_login: 0,
			attention_held: 1,
		});
	});
});
