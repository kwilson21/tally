import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

const KEY = btoa("01234567890123456789012345678901");

const page = (overrides: Record<string, unknown> = {}) => ({
	accounts: [
		{
			account_id: "account-1",
			name: "Everyday",
			mask: "1234",
			type: "depository",
			subtype: "checking",
			balances: { current: 12.34 },
		},
	],
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

describe("syncItem", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
	});

	it("inserts accounts and posted transactions, skips pending, and saves cents and cursor", async () => {
		const id = await addItem();
		const fetchImpl = vi.fn(async () =>
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
		expect(
			await env.DB.prepare(
				"SELECT plaid_item_id, balance_cents, is_liability FROM accounts",
			).first(),
		).toEqual({ plaid_item_id: id, balance_cents: 1234, is_liability: 0 });
		const { results } = await env.DB.prepare(
			"SELECT plaid_transaction_id, amount_cents, raw_name, plaid_category FROM transactions ORDER BY id",
		).all();
		expect(results).toEqual([
			{
				plaid_transaction_id: "transaction-1",
				amount_cents: 1234,
				raw_name: "Shop",
				plaid_category: "GENERAL_MERCHANDISE",
			},
			{
				plaid_transaction_id: "refund",
				amount_cents: -500,
				raw_name: "Shop",
				plaid_category: "GENERAL_MERCHANDISE",
			},
		]);
		expect(
			await env.DB.prepare("SELECT sync_cursor FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ sync_cursor: "cursor-1" });
	});

	it("keeps the committed first page and resumes without duplicates after a failure", async () => {
		const id = await addItem();
		let call = 0;
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				call += 1;
				if (call === 1)
					return response(
						page({
							added: [transaction()],
							next_cursor: "after-first",
							has_more: true,
						}),
					);
				if (call === 2)
					return response(
						{ error_type: "API_ERROR", request_id: "request-2" },
						500,
					);
				const body = JSON.parse(String(init?.body));
				expect(body.cursor).toBe("after-first");
				return response(
					page({ accounts: [], added: [transaction()], next_cursor: "done" }),
				);
			},
		);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).rejects.toThrow("Plaid request failed");
		expect(
			await env.DB.prepare("SELECT sync_cursor FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ sync_cursor: "after-first" });
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 1 });
		expect(consoleSpy.mock.calls.flat().join(" ")).toBe(
			"plaid sync error request-2",
		);
		consoleSpy.mockRestore();
	});

	it("updates only Plaid fields and preserves a person's decisions", async () => {
		const id = await addItem();
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(page({ added: [transaction()] })),
		);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = (SELECT id FROM categories LIMIT 1), note = 'mine', excluded = 1 WHERE plaid_transaction_id = 'transaction-1'",
		).run();
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(
				page({
					accounts: [],
					modified: [
						transaction({
							date: "2026-09-28",
							amount: -5,
							merchant_name: "New name",
							personal_finance_category: { primary: "TRANSFER_OUT" },
						}),
					],
				}),
			),
		);
		const row = await env.DB.prepare(
			"SELECT date, amount_cents, raw_name, plaid_category, category_id, note, excluded FROM transactions",
		).first<Record<string, unknown>>();
		expect(row).toMatchObject({
			date: "2026-09-28",
			amount_cents: -500,
			raw_name: "New name",
			plaid_category: "TRANSFER_OUT",
			note: "mine",
			excluded: 1,
		});
		expect(row?.category_id).not.toBeNull();
	});

	it("preserves the stored account balance when Plaid omits the current balance", async () => {
		const id = await addItem();
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(
				page({
					accounts: [
						{
							...page().accounts[0],
							balances: { current: 1234.56 },
						},
					],
				}),
			),
		);
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(
				page({
					accounts: [
						{
							...page().accounts[0],
							balances: { current: null },
						},
					],
				}),
			),
		);

		expect(
			await env.DB.prepare(
				"SELECT balance_cents FROM accounts WHERE plaid_account_id = 'account-1'",
			).first(),
		).toEqual({ balance_cents: 123456 });
	});

	it("does not count a transaction skipped for an unknown account", async () => {
		const id = await addItem();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			async () =>
				response(
					page({
						accounts: [],
						added: [transaction({ account_id: "unknown-account" })],
					}),
				),
		);

		expect(result).toEqual({ added: 0, modified: 0, removed: 0 });
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 0 });
		expect(logSpy).toHaveBeenCalledWith(
			"plaid sync: skipped 1 transaction for an unknown account",
		);
		logSpy.mockRestore();
	});

	it("removes a transaction and its split children", async () => {
		const id = await addItem();
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(page({ added: [transaction()] })),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; account_id: number }>();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id, is_split) VALUES (?, '2026-09-27', 500, 'child', ?, 1)",
		)
			.bind(parent?.account_id, parent?.id)
			.run();
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
			response(
				page({
					accounts: [],
					removed: [{ transaction_id: "transaction-1" }],
				}),
			),
		);
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 0 });
	});

	it("restarts a mutation error from the last saved cursor at most three times", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_cursor = 'saved' WHERE id = ?",
		)
			.bind(id)
			.run();
		let calls = 0;
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				calls += 1;
				expect(JSON.parse(String(init?.body)).cursor).toBe("saved");
				if (calls < 3)
					return response(
						{
							error_type: "TRANSACTIONS_ERROR",
							error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
							request_id: `request-${calls}`,
						},
						400,
					);
				return response(page({ accounts: [], next_cursor: "done" }));
			},
		);
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("marks Item errors for attention without logging transaction secrets", async () => {
		const id = await addItem();
		const error = {
			error_type: "ITEM_ERROR",
			error_code: "ITEM_LOGIN_REQUIRED",
			request_id: "safe-request-id",
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, async () =>
				response(error, 400),
			),
		).rejects.toThrow();
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ status: "needs_attention" });
		expect(spy.mock.calls.flat().join(" ")).toBe(
			"plaid sync error safe-request-id",
		);
		spy.mockRestore();
	});
});
