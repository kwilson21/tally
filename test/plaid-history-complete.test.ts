import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Plaid's 90-day history (spec §5, §8.8, #581): history_complete_at is set in the same write as the last page of a sync
// that ran after Plaid reported the history complete, from the webhook or from transactions_update_status.

const KEY = btoa("01234567890123456789012345678901");
const env2 = { ...env, TOKEN_ENCRYPTION_KEY: KEY };

const account = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 12.34 },
};

const page = (overrides: Record<string, unknown> = {}) => ({
	added: [],
	modified: [],
	removed: [],
	next_cursor: "cursor-1",
	has_more: false,
	...overrides,
});

const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** The Plaid calls: accounts, then whatever the sync answers for each /transactions/sync page. */
const plaidFetch = (
	sync: (body: Record<string, unknown>) => Promise<Response> | Response,
) =>
	vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		if (String(url).endsWith("/accounts/get"))
			return response({ accounts: [account] });
		return sync(JSON.parse(String(init?.body)));
	});

async function addItem() {
	const encrypted = await encryptToken("secret-access-token", KEY);
	const result = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();
	return result?.id as number;
}

const historyAt = async (id: number) =>
	(
		await env.DB.prepare(
			"SELECT history_complete_at AS at FROM plaid_items WHERE id = ?",
		)
			.bind(id)
			.first<{ at: string | null }>()
	)?.at ?? null;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("history_complete_at from the webhook", () => {
	it("is set on the last page of a sync the webhook says ran after history was complete", async () => {
		const id = await addItem();
		let calls = 0;
		const fetchImpl = plaidFetch(async () => {
			calls += 1;
			if (calls === 1)
				return response(page({ next_cursor: "c1", has_more: true }));
			// Before the last page commits, the first page's write has not set it.
			expect(await historyAt(id)).toBeNull();
			return response(page({ next_cursor: "c2" }));
		});
		await syncItem(env2, id, fetchImpl, { historyComplete: true });
		expect(calls).toBe(2);
		expect(await historyAt(id)).not.toBeNull();
	});

	it("is not set by a sync the webhook did not flag, with Plaid silent on the status", async () => {
		const id = await addItem();
		await syncItem(
			env2,
			id,
			plaidFetch(() => response(page())),
		);
		expect(await historyAt(id)).toBeNull();
	});

	it("is not set when the sync dies before its last page", async () => {
		const id = await addItem();
		let calls = 0;
		const fetchImpl = plaidFetch(() => {
			calls += 1;
			if (calls === 1)
				return response(page({ next_cursor: "c1", has_more: true }));
			return new Response(JSON.stringify({ error_type: "API_ERROR" }), {
				status: 500,
			});
		});
		await expect(
			syncItem(env2, id, fetchImpl, { historyComplete: true }),
		).rejects.toThrow("Plaid request failed");
		expect(await historyAt(id)).toBeNull();
	});
});

describe("history_complete_at from transactions_update_status", () => {
	it("is set on the last page when Plaid reports the history complete", async () => {
		const id = await addItem();
		await syncItem(
			env2,
			id,
			plaidFetch(() =>
				response(
					page({ transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" }),
				),
			),
		);
		expect(await historyAt(id)).not.toBeNull();
	});

	it("is not set while Plaid still reports the initial pull only", async () => {
		const id = await addItem();
		await syncItem(
			env2,
			id,
			plaidFetch(() =>
				response(
					page({ transactions_update_status: "INITIAL_UPDATE_COMPLETE" }),
				),
			),
		);
		expect(await historyAt(id)).toBeNull();
	});

	it("keeps the first time it was set, when a later sync also reports it complete", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = '2026-01-02 03:04:05' WHERE id = ?",
		)
			.bind(id)
			.run();
		await syncItem(
			env2,
			id,
			plaidFetch(() =>
				response(
					page({ transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" }),
				),
			),
		);
		expect(await historyAt(id)).toBe("2026-01-02 03:04:05");
	});
});

describe("a webhook sync skipped by a held lease", () => {
	it("is recovered by the next sync, from Plaid's status, once the lease is free (#581)", async () => {
		const id = await addItem();
		// Another run holds the Item's lease, so the webhook's sync is skipped before it reads anything.
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes'), sync_lock_id = 'other-run' WHERE id = ?",
		)
			.bind(id)
			.run();
		const skippedFetch = plaidFetch(() => response(page()));
		expect(
			await syncItem(env2, id, skippedFetch, { historyComplete: true }),
		).toEqual({ skipped: true });
		expect(skippedFetch).not.toHaveBeenCalled();
		expect(await historyAt(id)).toBeNull();

		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = NULL, sync_lock_id = NULL WHERE id = ?",
		)
			.bind(id)
			.run();
		// The lost webhook's signal is still in Plaid's status on the next sync, with no webhook flag.
		await syncItem(
			env2,
			id,
			plaidFetch(() =>
				response(
					page({ transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" }),
				),
			),
		);
		expect(await historyAt(id)).not.toBeNull();
	});
});
