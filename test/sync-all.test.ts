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
			synced: 0,
			skipped: 0,
			failed: 0,
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
			synced: 2,
			skipped: 0,
			failed: 0,
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
			synced: 1,
			skipped: 0,
			failed: 1,
		});
		expect(accountsCalls).toBe(2);
	});

	it("counts a live Item lock as skipped", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes') WHERE id = ?",
		)
			.bind(id)
			.run();

		expect(await syncAllItems(enabledEnv, fakePlaid())).toEqual({
			synced: 0,
			skipped: 1,
			failed: 0,
		});
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
			["plaid sync error request-2"],
		]);
	});
});
