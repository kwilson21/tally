import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEEDS_ATTENTION_ERROR_CODES, syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

const KEY = btoa("01234567890123456789012345678901");

const account = (current: number | null = 12.34) => ({
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current },
});

const page = (overrides: Record<string, unknown> = {}) => ({
	added: [],
	modified: [],
	removed: [],
	next_cursor: "cursor-1",
	has_more: false,
	...overrides,
});

const transaction = (overrides: Record<string, unknown> = {}) => ({
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 12.34,
	name: "RAW SHOP",
	merchant_name: "Shop",
	pending: false,
	personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
	...overrides,
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

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const plaidFetch = (
	sync: (body: Record<string, unknown>) => Response | Promise<Response>,
	accounts = [account()],
) =>
	vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		if (String(url).endsWith("/accounts/get")) return response({ accounts });
		return sync(JSON.parse(String(init?.body)));
	});

async function itemState(id: number) {
	return env.DB.prepare(
		"SELECT sync_cursor, sync_locked_until, sync_lock_id, status FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first();
}

describe("syncItem", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
	});

	it("gets and upserts accounts separately, stores raw names, and saves transactions", async () => {
		const id = await addItem();
		const fetchImpl = plaidFetch(() =>
			response(
				page({
					added: [
						transaction(),
						transaction({ transaction_id: "pending", pending: true }),
						transaction({ transaction_id: "refund", amount: -5 }),
					],
				}),
			),
		);

		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).toEqual({ added: 2, modified: 0, removed: 0 });
		expect(fetchImpl.mock.calls[0]?.[0].toString()).toContain("/accounts/get");
		expect(fetchImpl.mock.calls[1]?.[0].toString()).toContain(
			"/transactions/sync",
		);
		expect(
			await env.DB.prepare(
				"SELECT plaid_item_id, balance_cents, is_liability FROM accounts",
			).first(),
		).toEqual({ plaid_item_id: id, balance_cents: 1234, is_liability: 0 });
		const { results } = await env.DB.prepare(
			"SELECT amount_cents, raw_name, plaid_category FROM transactions ORDER BY id",
		).all();
		expect(results).toEqual([
			{
				amount_cents: 1234,
				raw_name: "RAW SHOP",
				plaid_category: "GENERAL_MERCHANDISE",
			},
			{
				amount_cents: -500,
				raw_name: "RAW SHOP",
				plaid_category: "GENERAL_MERCHANDISE",
			},
		]);
	});

	it("preserves a stored balance when accounts/get returns current null", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page()), [account(1234.56)]),
		);
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page()), [account(null)]),
		);
		expect(
			await env.DB.prepare(
				"SELECT balance_cents FROM accounts WHERE plaid_account_id = 'account-1'",
			).first(),
		).toEqual({ balance_cents: 123456 });
	});

	it("throws before writing a page containing a transaction for an unknown account", async () => {
		const id = await addItem();
		await expect(
			syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				id,
				plaidFetch(
					() =>
						response(
							page({
								added: [transaction({ account_id: "unknown-account" })],
							}),
						),
					[],
				),
			),
		).rejects.toThrow("unknown account");
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 0 });
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM accounts").first(),
		).toEqual({
			n: 0,
		});
		expect(await itemState(id)).toMatchObject({ sync_cursor: null });
	});

	it("accepts a transaction for an account already stored for the Item", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO accounts (plaid_item_id, plaid_account_id, name, type) VALUES (?, 'stored-account', 'Stored', 'depository')",
		)
			.bind(id)
			.run();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(
				() =>
					response(
						page({ added: [transaction({ account_id: "stored-account" })] }),
					),
				[],
			),
		);
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 1 });
	});

	it("restarts mutated pagination from the run's initial cursor without duplicates", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_cursor = 'saved' WHERE id = ?",
		)
			.bind(id)
			.run();
		const cursors: unknown[] = [];
		let syncCalls = 0;
		const fetchImpl = plaidFetch((body) => {
			cursors.push(body.cursor);
			syncCalls += 1;
			if (syncCalls === 1)
				return response(
					page({
						added: [transaction()],
						next_cursor: "middle",
						has_more: true,
					}),
				);
			if (syncCalls === 2)
				return response(
					{
						error_type: "TRANSACTIONS_ERROR",
						error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
						request_id: "mutation",
					},
					400,
				);
			if (syncCalls === 3)
				return response(
					page({
						added: [transaction()],
						next_cursor: "middle-2",
						has_more: true,
					}),
				);
			return response(
				page({
					added: [transaction({ transaction_id: "transaction-2" })],
					next_cursor: "done",
				}),
			);
		});

		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).toEqual({ added: 2, modified: 0, removed: 0 });
		expect(cursors).toEqual(["saved", "middle", "saved", "middle-2"]);
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 2 });
	});

	it("updates raw_name from name but preserves a person's decisions", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page({ added: [transaction()] }))),
		);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = (SELECT id FROM categories LIMIT 1), note = 'mine', excluded = 1 WHERE plaid_transaction_id = 'transaction-1'",
		).run();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						modified: [
							transaction({
								date: "2026-09-28",
								amount: -5,
								name: "NEW RAW NAME",
								merchant_name: "New merchant",
							}),
						],
					}),
				),
			),
		);
		const row = await env.DB.prepare(
			"SELECT date, amount_cents, raw_name, category_id, note, excluded FROM transactions",
		).first<Record<string, unknown>>();
		expect(row).toMatchObject({
			date: "2026-09-28",
			amount_cents: -500,
			raw_name: "NEW RAW NAME",
			note: "mine",
			excluded: 1,
		});
		expect(row?.category_id).not.toBeNull();
	});

	it("skips a concurrent run and releases the lock after success", async () => {
		const id = await addItem();
		let releaseAccounts!: () => void;
		const waiting = new Promise<void>((resolve) => {
			releaseAccounts = resolve;
		});
		const firstFetch = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url).endsWith("/accounts/get")) {
				await waiting;
				return response({ accounts: [account()] });
			}
			return response(page());
		});
		const first = syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			firstFetch,
		);
		await vi.waitFor(async () => {
			expect((await itemState(id))?.sync_locked_until).not.toBeNull();
		});
		const secondFetch = vi.fn();
		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, secondFetch),
		).toEqual({ skipped: true });
		expect(secondFetch).not.toHaveBeenCalled();
		releaseAccounts();
		await first;
		expect((await itemState(id))?.sync_locked_until).toBeNull();
	});

	it("takes an expired lock and releases it after failure", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '-1 minute') WHERE id = ?",
		)
			.bind(id)
			.run();
		await expect(
			syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				id,
				plaidFetch(() => response({ error_type: "API_ERROR" }, 500)),
			),
		).rejects.toThrow("Plaid request failed");
		expect((await itemState(id))?.sync_locked_until).toBeNull();
	});

	it("does not release a newer run's lock after its own lease expires", async () => {
		const id = await addItem();
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		const firstWaiting = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const secondWaiting = new Promise<void>((resolve) => {
			finishSecond = resolve;
		});
		const first = syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			vi.fn(async () => {
				await firstWaiting;
				throw new Error("first run finished late");
			}),
		);
		await vi.waitFor(async () => {
			expect((await itemState(id))?.sync_lock_id).not.toBeNull();
		});
		const firstLockId = (await itemState(id))?.sync_lock_id;
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '-1 minute') WHERE id = ?",
		)
			.bind(id)
			.run();

		const second = syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			vi.fn(async (url: RequestInfo | URL) => {
				await secondWaiting;
				return String(url).endsWith("/accounts/get")
					? response({ accounts: [account()] })
					: response(page());
			}),
		);
		await vi.waitFor(async () => {
			expect((await itemState(id))?.sync_lock_id).not.toBe(firstLockId);
		});
		const secondLock = await itemState(id);

		finishFirst();
		await expect(first).rejects.toThrow("first run finished late");
		expect(await itemState(id)).toMatchObject({
			sync_lock_id: secondLock?.sync_lock_id,
			sync_locked_until: secondLock?.sync_locked_until,
		});

		finishSecond();
		await second;
	});

	it("flags only documented errors that require user action", async () => {
		expect(NEEDS_ATTENTION_ERROR_CODES).toEqual([
			"ITEM_LOGIN_REQUIRED",
			"PENDING_EXPIRATION",
			"PENDING_DISCONNECT",
			"ITEM_LOCKED",
			"USER_SETUP_REQUIRED",
			"INVALID_CREDENTIALS",
			"INVALID_MFA",
			"INSUFFICIENT_CREDENTIALS",
			"ACCESS_NOT_GRANTED",
			"NO_ACCOUNTS",
		]);
		for (const [code, expectedStatus] of [
			["ITEM_LOGIN_REQUIRED", "needs_attention"],
			["PRODUCT_NOT_READY", "ok"],
		] as const) {
			const id = await addItem();
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			await expect(
				syncItem(
					{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
					id,
					plaidFetch(() =>
						response(
							{
								error_type: "ITEM_ERROR",
								error_code: code,
								request_id: "safe-request-id",
							},
							400,
						),
					),
				),
			).rejects.toThrow("Plaid request failed");
			expect((await itemState(id))?.status).toBe(expectedStatus);
			spy.mockRestore();
		}
	});
});
