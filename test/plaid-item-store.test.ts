import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearAttention,
	disconnectStatement,
	markNeedsAttention,
	markSyncSucceeded,
	readConnection,
} from "../src/plaid/item-store";

const REMINDED = "2026-10-06 04:00:00";
const LOCK = "lease-a";

async function addBank(
	status: "ok" | "needs_attention",
	options: {
		reminded?: string | null;
		lockId?: string | null;
		name?: string;
		reason?: "login" | "expiring";
	} = {},
): Promise<number> {
	// A flagged bank carries a reason (login unless the test says otherwise); an ok bank carries none.
	const reason = status === "ok" ? null : (options.reason ?? "login");
	const row = await env.DB.prepare(
		`INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status, reconnect_emailed_at, sync_lock_id, attention_reason)
		 VALUES (?, ?, 'person@example.com', ?, ?, ?, ?) RETURNING id`,
	)
		.bind(
			new Uint8Array([1, 2, 3]),
			options.name ?? "Bank",
			status,
			options.reminded ?? null,
			options.lockId ?? null,
			reason,
		)
		.first<{ id: number }>();
	return row?.id as number;
}

async function rowOf(id: number) {
	return env.DB.prepare(
		"SELECT status, disconnected_at, reconnect_emailed_at, attention_reason, sync_lock_id, sync_locked_until, length(access_token_encrypted) AS token_length FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first<{
			status: string;
			disconnected_at: string | null;
			reconnect_emailed_at: string | null;
			attention_reason: string | null;
			sync_lock_id: string | null;
			sync_locked_until: string | null;
			token_length: number;
		}>();
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM plaid_items").run();
});

describe("markNeedsAttention", () => {
	it("moves an ok bank to needs_attention and reports changed", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "login")).toBe("changed");
		expect((await rowOf(id))?.status).toBe("needs_attention");
	});

	it("reports unchanged, and writes nothing, when the bank already needs attention", async () => {
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
		// The caller read "ok", but the row is already needs_attention with a reminder sent. LOGIN_BROKEN from "ok"
		// would change it, so the guard must refuse the write rather than overwrite what is there now.
		const id = await addBank("needs_attention", { reminded: REMINDED });
		expect(await markNeedsAttention(env.DB, id, "login", { seen: "ok" })).toBe(
			"lost-race",
		);
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			reconnect_emailed_at: REMINDED,
		});
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

	it("answers lost-race, not unchanged, when the caller's seen state is no longer true and the event would leave it as it was", async () => {
		// The caller read needs_attention, but a sync has since made the bank ok. LOGIN_BROKEN from needs_attention
		// leaves needs_attention where it is, which is a no-op for the caller's view, yet the row now says ok.
		const id = await addBank("ok");
		expect(
			await markNeedsAttention(env.DB, id, "login", {
				seen: "needs_attention",
			}),
		).toBe("lost-race");
		expect((await rowOf(id))?.status).toBe("ok");
	});

	it("uses the seen state the caller passed, without reading the row again", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "login", { seen: "ok" })).toBe(
			"changed",
		);
	});
});

describe("clearAttention", () => {
	it("moves a needs_attention bank to ok and forgets the reminder email", async () => {
		const id = await addBank("needs_attention", { reminded: REMINDED });
		expect(await clearAttention(env.DB, id)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			reconnect_emailed_at: null,
		});
	});

	it("reports unchanged for a bank already ok", async () => {
		const id = await addBank("ok");
		expect(await clearAttention(env.DB, id)).toBe("unchanged");
	});

	it("a relink on a bank that is already ok is unchanged and leaves its row alone", async () => {
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
});

describe("markSyncSucceeded", () => {
	it("clears needs_attention and the reminder when a sync finishes while the bank needs attention", async () => {
		const id = await addBank("needs_attention", {
			reminded: REMINDED,
			lockId: LOCK,
		});
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
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
	it("reads ok, needs_attention and disconnected, and null for no bank", async () => {
		const ok = await addBank("ok");
		const needs = await addBank("needs_attention");
		const gone = await addBank("ok");
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(gone)
			.run();
		expect(await readConnection(env.DB, ok)).toBe("ok");
		expect(await readConnection(env.DB, needs)).toBe("needs_attention");
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
 * The database a store operation sees, where the bank changes between its read and its confirming read: `before`
 * runs first, once, as if a webhook or a sync landed in that gap.
 */
function raceBeforeConfirm(before: string, id: number): D1Database {
	let raced = false;
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop !== "prepare") {
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (sql: string) => {
				const statement = target.prepare(sql);
				if (raced || !sql.startsWith("SELECT 1 AS holds")) return statement;
				return {
					bind: (...values: unknown[]) => {
						const bound = statement.bind(...values);
						return {
							first: async () => {
								raced = true;
								await target.prepare(before).bind(id).run();
								return bound.first();
							},
						};
					},
				} as unknown as D1PreparedStatement;
			};
		},
	});
}

describe("the attention reason (decision 173)", () => {
	it("an expiry warning's flag survives a successful sync, and its reminder timestamp stays", async () => {
		const id = await addBank("needs_attention", {
			reason: "expiring",
			reminded: REMINDED,
			lockId: LOCK,
		});
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_reason: "expiring",
			reconnect_emailed_at: REMINDED,
		});
	});

	it("a login flag is cleared by a successful sync", async () => {
		const id = await addBank("needs_attention", {
			reason: "login",
			reminded: REMINDED,
			lockId: LOCK,
		});
		expect(await markSyncSucceeded(env.DB, id, LOCK)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_reason: null,
			reconnect_emailed_at: null,
		});
	});

	it("a relink clears an expiry warning too", async () => {
		const id = await addBank("needs_attention", {
			reason: "expiring",
			reminded: REMINDED,
		});
		expect(await clearAttention(env.DB, id)).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "ok",
			attention_reason: null,
			reconnect_emailed_at: null,
		});
	});

	it("a later expiry warning does not overwrite a login flag already set", async () => {
		const id = await addBank("needs_attention", {
			reason: "login",
			reminded: REMINDED,
		});
		expect(await markNeedsAttention(env.DB, id, "expiring")).toBe("unchanged");
		expect(await rowOf(id)).toMatchObject({
			attention_reason: "login",
			reconnect_emailed_at: REMINDED,
		});
	});

	it("an expiry warning on an ok bank records the expiring reason", async () => {
		const id = await addBank("ok");
		expect(await markNeedsAttention(env.DB, id, "expiring")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({
			status: "needs_attention",
			attention_reason: "expiring",
		});
	});

	it("a login error upgrades an expiry warning to a login flag", async () => {
		const id = await addBank("needs_attention", { reason: "expiring" });
		expect(await markNeedsAttention(env.DB, id, "login")).toBe("changed");
		expect(await rowOf(id)).toMatchObject({ attention_reason: "login" });
	});

	it("a relink on a bank read as ok answers lost-race when a webhook flags it before the confirming read", async () => {
		const id = await addBank("ok");
		const db = raceBeforeConfirm(
			"UPDATE plaid_items SET status = 'needs_attention', attention_reason = 'login' WHERE id = ?",
			id,
		);
		expect(await clearAttention(db, id)).toBe("lost-race");
		expect((await rowOf(id))?.status).toBe("needs_attention");
	});
});
