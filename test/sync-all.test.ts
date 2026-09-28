import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncAllItems } from "../src/plaid/sync-all";
import { encryptToken } from "../src/plaid/token-crypto";

const KEY = btoa("01234567890123456789012345678901");
const enabledEnv = {
	...env,
	DEMO: "false",
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: KEY,
};

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

async function addItem(status: "ok" | "needs_attention" = "ok") {
	const token = await encryptToken(`token-${crypto.randomUUID()}`, KEY);
	const row = await env.DB.prepare(
		`INSERT INTO plaid_items
			(access_token_encrypted, institution_name, linked_by, plaid_item_id, status)
		 VALUES (?, 'Bank', 'person@example.com', ?, ?) RETURNING id`,
	)
		.bind(token, crypto.randomUUID(), status)
		.first<{ id: number }>();
	return row?.id as number;
}

function fakePlaid(failToken?: string) {
	return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			access_token: string;
		};
		if (body.access_token === failToken) {
			return response(
				{ error_type: "API_ERROR", request_id: "request-safe" },
				500,
			);
		}
		if (String(url).endsWith("/accounts/get")) {
			return response({
				accounts: [
					{
						account_id: `account-${body.access_token}`,
						name: "Checking",
						type: "depository",
						balances: { current: 10 },
					},
				],
			});
		}
		return response({
			added: [
				{
					transaction_id: `transaction-${body.access_token}`,
					account_id: `account-${body.access_token}`,
					date: "2026-09-27",
					amount: 1,
					name: "SHOP",
					pending: false,
				},
			],
			modified: [],
			removed: [],
			next_cursor: "next",
			has_more: false,
		});
	});
}

describe("syncAllItems", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
	});

	it.each([
		["the demo", { ...enabledEnv, DEMO: "true" }],
		[
			"missing secrets",
			{ ...enabledEnv, PLAID_CLIENT_ID: undefined, PLAID_SECRET: undefined },
		],
		[
			"an invalid encryption key",
			{ ...enabledEnv, TOKEN_ENCRYPTION_KEY: "bad" },
		],
	])("does nothing in %s", async (_name, disabledEnv) => {
		const fetchImpl = fakePlaid();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const withoutDb = {
			...disabledEnv,
			DB: undefined as unknown as D1Database,
		};
		expect(await syncAllItems(withoutDb, fetchImpl)).toEqual({
			added: 0,
			synced: 0,
			skipped: 0,
			busy: 0,
			failed: 0,
			failedBanks: [],
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"plaid daily sync: synced 0, skipped 0, failed 0",
		);
	});

	it("syncs every ok Item in order and leaves needs_attention alone", async () => {
		const first = await addItem();
		const second = await addItem();
		await addItem("needs_attention");
		const fetchImpl = fakePlaid();

		expect(await syncAllItems(enabledEnv, fetchImpl)).toEqual({
			added: 2,
			synced: 2,
			skipped: 0,
			busy: 0,
			failed: 0,
			failedBanks: [],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		const { results } = await env.DB.prepare(
			"SELECT plaid_item_id FROM accounts ORDER BY plaid_item_id",
		).all<{ plaid_item_id: number }>();
		expect(results.map((row) => row.plaid_item_id)).toEqual([first, second]);
	});

	it("continues after one Item fails", async () => {
		await addItem();
		await addItem();
		const fetchImpl = fakePlaid();
		let accountsCalls = 0;
		fetchImpl.mockImplementation(async (url, init) => {
			const body = JSON.parse(String(init?.body)) as { access_token: string };
			if (String(url).endsWith("/accounts/get") && accountsCalls++ === 0) {
				return response(
					{ error_type: "API_ERROR", request_id: "request-safe" },
					500,
				);
			}
			if (String(url).endsWith("/accounts/get"))
				return response({
					accounts: [
						{
							account_id: `account-${body.access_token}`,
							name: "Checking",
							type: "depository",
							balances: { current: 10 },
						},
					],
				});
			return response({
				added: [],
				modified: [],
				removed: [],
				next_cursor: "next",
				has_more: false,
			});
		});

		expect(await syncAllItems(enabledEnv, fetchImpl)).toEqual({
			added: 0,
			synced: 1,
			skipped: 0,
			busy: 0,
			failed: 1,
			failedBanks: ["Bank"],
		});
		expect(accountsCalls).toBe(2);
	});

	it("limits attempts per Item and records failed attempts", async () => {
		const fresh = await addItem();
		const stale = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_sync_attempt_at = datetime('now') WHERE id = ?",
		)
			.bind(fresh)
			.run();
		const fetchImpl = fakePlaid();
		expect(
			await syncAllItems(enabledEnv, fetchImpl, Date.now, true),
		).toMatchObject({ synced: 1, skipped: 1, busy: 1 });
		const staleAttempt = await env.DB.prepare(
			"SELECT last_sync_attempt_at FROM plaid_items WHERE id = ?",
		)
			.bind(stale)
			.first<{ last_sync_attempt_at: string | null }>();
		expect(staleAttempt?.last_sync_attempt_at).not.toBeNull();
	});

	it("lets only one of two overlapping manual syncs claim a bank", async () => {
		await addItem();
		let statusChecks = 0;
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) => {
						if (sql.startsWith("SELECT status FROM plaid_items"))
							statusChecks += 1;
						return target.prepare(sql);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const both = { ...enabledEnv, DB: db };
		const fetchImpl = fakePlaid();

		const [first, second] = await Promise.all([
			syncAllItems(both, fetchImpl, Date.now, true),
			syncAllItems(both, fetchImpl, Date.now, true),
		]);

		expect(first.synced + second.synced).toBe(1);
		expect(first.busy + second.busy).toBe(1);
		// The loser never got past the claim, so only one status check ran.
		expect(statusChecks).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("counts a live Item lock as skipped and busy", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes') WHERE id = ?",
		)
			.bind(id)
			.run();

		expect(await syncAllItems(enabledEnv, fakePlaid())).toEqual({
			added: 0,
			synced: 0,
			skipped: 1,
			busy: 1,
			failed: 0,
			failedBanks: [],
		});
	});

	it("stops starting Items after the twelve-minute budget", async () => {
		await addItem();
		await addItem();
		const fetchImpl = fakePlaid();
		const times = [0, 0, 12 * 60 * 1000 + 1];

		expect(
			await syncAllItems(enabledEnv, fetchImpl, () => times.shift() ?? 0),
		).toEqual({
			added: 1,
			synced: 1,
			skipped: 1,
			busy: 0,
			failed: 0,
			failedBanks: [],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("rechecks an Item's status just before syncing it", async () => {
		await addItem();
		const second = await addItem();
		const fetchImpl = fakePlaid();
		let calls = 0;
		fetchImpl.mockImplementation(async (url, init) => {
			calls += 1;
			if (calls === 2) {
				await env.DB.prepare(
					"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ?",
				)
					.bind(second)
					.run();
			}
			return fakePlaid()(url, init);
		});

		expect(await syncAllItems(enabledEnv, fetchImpl)).toEqual({
			added: 1,
			synced: 1,
			skipped: 1,
			busy: 0,
			failed: 0,
			failedBanks: [],
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("logs only the row id and error name for a non-Plaid failure", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET access_token_encrypted = ? WHERE id = ?",
		)
			.bind(new TextEncoder().encode("private-token"), id)
			.run();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await syncAllItems(enabledEnv, fakePlaid())).toEqual({
			added: 0,
			synced: 0,
			skipped: 0,
			busy: 0,
			failed: 1,
			failedBanks: ["Bank"],
		});
		expect(error.mock.calls).toEqual([
			[`plaid daily sync: item ${id} failed Error`],
		]);
		expect(JSON.stringify(error.mock.calls)).not.toMatch(
			/private-token|Bank|person@example\.com|token-|amount/,
		);
	});

	it("logs only request IDs and the final counts", async () => {
		await addItem();
		await addItem();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const fetchImpl = fakePlaid();
		fetchImpl.mockImplementation(async () => {
			calls += 1;
			return response(
				{ error_type: "API_ERROR", request_id: `request-${calls}` },
				500,
			);
		});

		await syncAllItems(enabledEnv, fetchImpl);

		expect(log.mock.calls).toEqual([
			["plaid daily sync: synced 0, skipped 0, failed 2"],
		]);
		expect(error.mock.calls).toEqual([
			["plaid sync error request-1"],
			[
				expect.stringMatching(
					/^plaid daily sync: item \d+ failed plaid request-1$/,
				),
			],
			["plaid sync error request-2"],
			[
				expect.stringMatching(
					/^plaid daily sync: item \d+ failed plaid request-2$/,
				),
			],
		]);
	});

	it("counts a failed status check as failed and carries on", async () => {
		const first = await addItem();
		await addItem();
		let statusChecks = 0;
		// A DB whose first per-Item status read throws; every other query is real.
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) => {
						if (
							sql.startsWith("SELECT status FROM plaid_items") &&
							++statusChecks === 1
						) {
							throw new Error("D1 unavailable");
						}
						return target.prepare(sql);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await syncAllItems({ ...enabledEnv, DB: db }, fakePlaid())).toEqual({
			added: 1,
			synced: 1,
			skipped: 0,
			busy: 0,
			failed: 1,
			failedBanks: ["Bank"],
		});
		expect(error).toHaveBeenCalledWith(
			`plaid daily sync: item ${first} failed Error`,
		);
	});
});
