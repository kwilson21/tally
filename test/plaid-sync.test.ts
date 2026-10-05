import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { loadMonth } from "../src/db/month";
import {
	applyMerchantRules,
	getTransaction,
	saveEdit,
	saveJevResult,
} from "../src/db/transactions";
import { syncItem, TRANSIENT_ITEM_ERROR_CODES } from "../src/plaid/sync";
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
		"SELECT sync_cursor, sync_locked_until, sync_lock_id, status, last_synced_at FROM plaid_items WHERE id = ?",
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

	it("sets last_synced_at only after a successful sync", async () => {
		const successful = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			successful,
			plaidFetch(() => response(page())),
		);
		expect((await itemState(successful))?.last_synced_at).toEqual(
			expect.any(String),
		);

		const failed = await addItem();
		await expect(
			syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				failed,
				plaidFetch(() => response({}, 500)),
			),
		).rejects.toThrow();
		expect((await itemState(failed))?.last_synced_at).toBeNull();
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

	it("removes split children and remembers the old total when the bank changes an amount", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page({ added: [transaction()] }))),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id AS accountId, date, raw_name AS rawName FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; accountId: number; date: string; rawName: string }>();
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET is_split = 1, category_id = 2 WHERE id = ?",
			).bind(parent?.id),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, ?, 600, ?, ?), (?, ?, 634, ?, ?)",
			).bind(
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
			),
		]);
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({ modified: [transaction({ amount: 20, date: "2026-09-28" })] }),
				),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, category_id, is_split, split_removed_from_cents FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first(),
		).toEqual({
			amount_cents: 2000,
			category_id: null,
			is_split: 0,
			split_removed_from_cents: 1234,
		});
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
			)
				.bind(parent?.id)
				.first(),
		).toEqual({ n: 0 });
	});

	it("moves split children with a date-only bank change", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page({ added: [transaction()] }))),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id AS accountId, date, raw_name AS rawName FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; accountId: number; date: string; rawName: string }>();
		await env.DB.batch([
			env.DB.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?").bind(
				parent?.id,
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, ?, 600, ?, ?), (?, ?, 634, ?, ?)",
			).bind(
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
			),
		]);
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						modified: [
							transaction({ date: "2026-09-28", name: "RENAMED BY BANK" }),
						],
					}),
				),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ? AND date = '2026-09-28' AND raw_name = 'RENAMED BY BANK'",
			)
				.bind(parent?.id)
				.first(),
		).toEqual({ n: 2 });
		expect(
			await env.DB.prepare(
				"SELECT is_split, split_removed_from_cents FROM transactions WHERE id = ?",
			)
				.bind(parent?.id)
				.first(),
		).toEqual({ is_split: 1, split_removed_from_cents: null });
	});

	it("stores Plaid's merchant_name on added transactions, and null when Plaid sends none or a blank one", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								transaction_id: "named",
								name: "TARGET 1234",
								merchant_name: "Target",
							}),
							transaction({ transaction_id: "null", merchant_name: null }),
							transaction({ transaction_id: "blank", merchant_name: "  " }),
							// JSON drops undefined, so the field is absent, as for a payment with no merchant.
							transaction({
								transaction_id: "absent",
								merchant_name: undefined,
							}),
						],
					}),
				),
			),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT plaid_transaction_id AS id, merchant_name, pending FROM transactions ORDER BY transactions.id",
				).all()
			).results,
		).toEqual([
			{ id: "named", merchant_name: "Target", pending: 0 },
			{ id: "null", merchant_name: null, pending: 0 },
			{ id: "blank", merchant_name: null, pending: 0 },
			{ id: "absent", merchant_name: null, pending: 0 },
		]);
	});

	it("updates merchant_name on modified transactions, including a part of a split, and clears it when Plaid drops it", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(page({ added: [transaction({ merchant_name: null })] })),
			),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id AS accountId, date, raw_name AS rawName FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; accountId: number; date: string; rawName: string }>();
		await env.DB.batch([
			env.DB.prepare("UPDATE transactions SET is_split = 1 WHERE id = ?").bind(
				parent?.id,
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, ?, 600, ?, ?), (?, ?, 634, ?, ?)",
			).bind(
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
				parent?.accountId,
				parent?.date,
				parent?.rawName,
				parent?.id,
			),
		]);
		const merchantNames = async () =>
			(
				await env.DB.prepare(
					"SELECT merchant_name FROM transactions ORDER BY id",
				).all()
			).results.map((r) => r.merchant_name);
		expect(await merchantNames()).toEqual([null, null, null]);

		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({ modified: [transaction({ merchant_name: "Shop Co" })] }),
				),
			),
		);
		expect(await merchantNames()).toEqual(["Shop Co", "Shop Co", "Shop Co"]);

		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(page({ modified: [transaction({ merchant_name: null })] })),
			),
		);
		expect(await merchantNames()).toEqual([null, null, null]);
	});

	it("keeps a pending transaction out, as before: this only adds the column", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						added: [transaction({ transaction_id: "p", pending: true })],
					}),
				),
			),
		);

		expect(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
		).toEqual({ n: 0 });
	});

	it("matches a bill from raw names that share Plaid's merchant name", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Card', 1234, 27, 'monthly', 'Target')",
		).run();

		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								transaction_id: "a",
								date: "2026-08-27",
								name: "TARGET 1234",
								merchant_name: "Target",
							}),
							transaction({
								transaction_id: "b",
								date: "2026-09-27",
								name: "TARGET 5678",
								merchant_name: "Target",
							}),
						],
					}),
				),
			),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT bp.period, t.raw_name FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id WHERE bp.status = 'linked' ORDER BY bp.period",
				).all()
			).results,
		).toEqual([
			{ period: "2026-08", raw_name: "TARGET 1234" },
			{ period: "2026-09", raw_name: "TARGET 5678" },
		]);
	});

	it.each(["added", "modified"] as const)(
		"clears a merchant rule's category when Plaid corrects the merchant (%s), so the new merchant's rule applies",
		async (path) => {
			const id = await addItem();
			const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
			await syncItem(
				opts,
				id,
				plaidFetch(() =>
					response(
						page({
							added: [
								transaction({
									transaction_id: "by-rule",
									merchant_name: "Old Shop",
								}),
								transaction({
									transaction_id: "by-user",
									merchant_name: "Old Shop",
								}),
								transaction({
									transaction_id: "by-jev",
									merchant_name: "Old Shop",
								}),
								transaction({
									transaction_id: "same",
									merchant_name: "Old Shop",
								}),
							],
						}),
					),
				),
			);
			const [first, second] = (
				await env.DB.prepare(
					"SELECT id FROM categories ORDER BY id LIMIT 2",
				).all<{
					id: number;
				}>()
			).results.map((r) => r.id) as [number, number];
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'merchant_rule' WHERE plaid_transaction_id IN ('by-rule', 'same')",
				).bind(first),
				env.DB.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE plaid_transaction_id = 'by-user'",
				).bind(first),
				env.DB.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE plaid_transaction_id = 'by-jev'",
				).bind(first),
				env.DB.prepare(
					"INSERT OR REPLACE INTO merchants (raw_name, default_category_id) VALUES ('New Shop', ?)",
				).bind(second),
			]);

			await syncItem(
				opts,
				id,
				plaidFetch(() =>
					response(
						page({
							[path]: [
								transaction({
									transaction_id: "by-rule",
									merchant_name: "New Shop",
								}),
								transaction({
									transaction_id: "by-user",
									merchant_name: "New Shop",
								}),
								transaction({
									transaction_id: "by-jev",
									merchant_name: "New Shop",
								}),
								// Same merchant, a new date: its rule's category stays.
								transaction({
									transaction_id: "same",
									merchant_name: "Old Shop",
									date: "2026-09-28",
								}),
							],
						}),
					),
				),
			);

			const state = async () =>
				Object.fromEntries(
					(
						await env.DB.prepare(
							"SELECT plaid_transaction_id AS id, category_id, category_source FROM transactions",
						).all<{
							id: string;
							category_id: number | null;
							category_source: string | null;
						}>()
					).results.map((r) => [r.id, [r.category_id, r.category_source]]),
				);
			expect(await state()).toEqual({
				"by-rule": [null, null],
				"by-user": [first, "user"],
				"by-jev": [first, "jev"],
				same: [first, "merchant_rule"],
			});

			await applyMerchantRules(env.DB);
			expect(await state()).toMatchObject({
				"by-rule": [second, "merchant_rule"],
				"by-user": [first, "user"],
				"by-jev": [first, "jev"],
			});
			await env.DB.prepare(
				"DELETE FROM merchants WHERE raw_name = 'New Shop'",
			).run();
		},
	);

	it("keeps a bill, a rule and a name saved under the bank's raw text working once Plaid sends a merchant name", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Internet', 1234, 27, 'monthly', 'COMCAST CABLE')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('COMCAST CABLE', 'Comcast Cable', (SELECT id FROM categories LIMIT 1))",
			),
		]);

		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								name: "COMCAST CABLE",
								merchant_name: "Comcast",
								date: "2026-09-27",
							}),
						],
					}),
				),
			),
		);
		await applyMerchantRules(env.DB);

		expect(
			await env.DB.prepare(
				"SELECT bp.period, t.merchant_name, t.category_source FROM bill_payments bp JOIN transactions t ON t.id = bp.transaction_id WHERE bp.status = 'linked'",
			).first(),
		).toEqual({
			period: "2026-09",
			merchant_name: "Comcast",
			category_source: "merchant_rule",
		});
		expect(
			(
				await getTransaction(
					env.DB,
					(
						await env.DB.prepare("SELECT id FROM transactions").first<{
							id: number;
						}>()
					)?.id as number,
				)
			)?.displayName,
		).toBe("Comcast Cable");
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

	it("ignores a pending transaction for an unknown account", async () => {
		const id = await addItem();
		expect(
			await syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				id,
				plaidFetch(
					() =>
						response(
							page({
								added: [transaction({ account_id: "unknown", pending: true })],
							}),
						),
					[],
				),
			),
		).toEqual({ added: 0, modified: 0, removed: 0 });
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 0 });
	});

	it("adds and logs nothing when the same page is synced twice", async () => {
		const id = await addItem();
		const fetchImpl = plaidFetch(() =>
			response(page({ added: [transaction()] })),
		);
		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).toMatchObject({ added: 1 });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(
				await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
			).toEqual({ added: 0, modified: 0, removed: 0 });
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
		expect(
			await env.DB.prepare("SELECT COUNT(*) n FROM transactions").first(),
		).toEqual({ n: 1 });
	});

	it("restarts mutated pagination, corrects re-added rows, and preserves decisions", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_cursor = 'saved' WHERE id = ?",
		)
			.bind(id)
			.run();
		const cursors: unknown[] = [];
		let syncCalls = 0;
		let chosenCategory: number | undefined;
		const fetchImpl = plaidFetch(async (body) => {
			cursors.push(body.cursor);
			syncCalls += 1;
			if (syncCalls === 1)
				return response(
					page({
						added: [transaction({ amount: 10 })],
						next_cursor: "middle",
						has_more: true,
					}),
				);
			if (syncCalls === 2) {
				const category = await env.DB.prepare(
					"SELECT id FROM categories LIMIT 1",
				).first<{ id: number }>();
				chosenCategory = category?.id;
				await env.DB.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user', note = 'keep', excluded = 1 WHERE plaid_transaction_id = 'transaction-1'",
				)
					.bind(chosenCategory)
					.run();
				return response(
					{
						error_type: "TRANSACTIONS_ERROR",
						error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
						request_id: "mutation",
					},
					400,
				);
			}
			if (syncCalls === 3)
				return response(
					page({
						added: [transaction({ amount: 12, name: "CORRECTED RAW" })],
						next_cursor: "done",
					}),
				);
			throw new Error("unexpected request");
		});

		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).toEqual({ added: 1, modified: 0, removed: 0 });
		expect(cursors).toEqual(["saved", "middle", "saved"]);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, raw_name, category_id, category_source, note, excluded FROM transactions",
			).first(),
		).toEqual({
			amount_cents: 1200,
			raw_name: "CORRECTED RAW",
			category_id: chosenCategory,
			category_source: "user",
			note: "keep",
			excluded: 1,
		});
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

	it("preserves a person's income correction when Plaid updates the transaction", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ added: [transaction({ amount: -1200 })] })),
			),
		);
		await env.DB.prepare(
			"UPDATE transactions SET flag_income = 0, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user' WHERE plaid_transaction_id = 'transaction-1'",
		).run();
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ modified: [transaction({ amount: -1250 })] })),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first(),
		).toEqual({
			amount_cents: -125000,
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

	it.each([
		{ path: "added", amount: -12 },
		{ path: "added", amount: -13 },
		{ path: "modified", amount: -12 },
		{ path: "modified", amount: -13 },
	] as const)(
		"preserves user-owned income and review decisions on a $path sync at amount $amount",
		async ({ path, amount }) => {
			const id = await addItem();
			const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
			await syncItem(
				opts,
				id,
				plaidFetch(() =>
					response(page({ added: [transaction({ amount: -12 })] })),
				),
			);
			await env.DB.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = 'user', credit_reviewed = 0, credit_reviewed_by = 'user' WHERE plaid_transaction_id = 'transaction-1'",
			).run();

			await syncItem(
				opts,
				id,
				plaidFetch(() => response(page({ [path]: [transaction({ amount })] }))),
			);

			expect(
				await env.DB.prepare(
					"SELECT amount_cents, flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
				).first(),
			).toEqual({
				amount_cents: amount * 100,
				flag_income: 1,
				income_source: "user",
				credit_reviewed: 0,
				credit_reviewed_by: "user",
			});
		},
	);

	it("preserves Jev's reviewed credit on an unchanged replay and invalidates it when amount changes", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ added: [transaction({ amount: -3000 })] })),
			),
		);
		const tx = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number }>();
		await saveJevResult(env.DB, tx?.id as number, {
			categoryId: null,
			suggestedCategoryId: null,
			confidence: 0.95,
			flags: { transfer: false, reimbursement: false, income: true },
		});
		for (const amount of [-3000, -3000]) {
			await syncItem(
				opts,
				id,
				plaidFetch(() => response(page({ added: [transaction({ amount })] }))),
			);
			expect(
				await env.DB.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
				).first(),
			).toEqual({ flag_income: 1, income_source: "jev" });
			expect(
				await env.DB.prepare(
					"SELECT credit_reviewed, category_confidence, jev_category_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
				).first(),
			).toEqual({
				credit_reviewed: 1,
				category_confidence: 0.95,
				jev_category_id: null,
			});
		}
		for (const amount of [-3100, -3200]) {
			await syncItem(
				opts,
				id,
				plaidFetch(() =>
					response(page({ modified: [transaction({ amount })] })),
				),
			);
			expect(
				await env.DB.prepare(
					"SELECT flag_income, income_source FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
				).first(),
			).toEqual({ flag_income: 0, income_source: null });
			expect(
				await env.DB.prepare(
					"SELECT credit_reviewed, credit_reviewed_by, category_confidence, jev_category_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
				).first(),
			).toEqual({
				credit_reviewed: 0,
				credit_reviewed_by: null,
				category_confidence: null,
				jev_category_id: null,
			});
		}
	});

	it("keeps Jev ownership after a note-only save so a Plaid amount change reopens review", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ added: [transaction({ amount: -12 })] })),
			),
		);
		const tx = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number }>();
		await saveJevResult(env.DB, tx?.id as number, {
			categoryId: 1,
			suggestedCategoryId: 1,
			confidence: 0.95,
			flags: { transfer: false, reimbursement: false, income: false },
		});
		await saveEdit(
			env.DB,
			tx?.id as number,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: "synthetic note",
				excluded: false,
				income: false,
				creditReviewed: true,
			},
			"synthetic",
		);
		expect(
			await env.DB.prepare(
				"SELECT income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first(),
		).toEqual({
			income_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: null,
		});

		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ modified: [transaction({ amount: -12.75 })] })),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, income_source, credit_reviewed, credit_reviewed_by, category_confidence FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first(),
		).toEqual({
			amount_cents: -1275,
			income_source: null,
			credit_reviewed: 0,
			credit_reviewed_by: null,
			category_confidence: null,
		});
	});

	it("preserves explicit refund accounting after Plaid changes its amount", async () => {
		const item = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			item,
			plaidFetch(() =>
				response(page({ added: [transaction({ amount: -12 })] })),
			),
		);
		const tx = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number }>();
		const purchase = await env.DB.prepare(
			"SELECT date FROM transactions WHERE id = 1",
		).first<{ date: string }>();
		if (!purchase) throw new Error("Expected demo purchase 1");
		await env.DB.prepare(
			"UPDATE transactions SET refund_of_id = 1, category_source = 'jev', category_confidence = 0.95, credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(tx?.id)
			.run();
		const monthBefore = await loadMonth(env.DB, purchase.date.slice(0, 7));
		const budgetTotalBefore = monthBefore.transactions.reduce(
			(sum, row) => sum + row.amountCents,
			0,
		);
		expect(
			monthBefore.transactions.some(
				(row) => row.amountCents === -1200 && row.linked,
			),
		).toBe(true);
		await syncItem(
			opts,
			item,
			plaidFetch(() =>
				response(page({ modified: [transaction({ amount: -13 })] })),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, credit_reviewed, credit_reviewed_by, refund_of_id FROM transactions WHERE id = ?",
			)
				.bind(tx?.id)
				.first(),
		).toEqual({
			amount_cents: -1300,
			credit_reviewed: 0,
			credit_reviewed_by: null,
			refund_of_id: 1,
		});
		const monthAfter = await loadMonth(env.DB, purchase.date.slice(0, 7));
		expect(
			monthAfter.transactions.some(
				(row) => row.amountCents === -1300 && row.linked,
			),
		).toBe(false);
		expect(
			monthAfter.transactions.reduce((sum, row) => sum + row.amountCents, 0),
		).toBe(budgetTotalBefore + 1200);
	});

	it("reclassifies an updated non-reviewed purchase as a pending credit when Plaid changes its sign", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ added: [transaction({ amount: 12 })] })),
			),
		);
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(page({ modified: [transaction({ amount: -5 })] })),
			),
		);
		expect(
			await env.DB.prepare(
				"SELECT credit_reviewed FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first(),
		).toEqual({ credit_reviewed: 0 });
	});

	it("holds raw Plaid credits out of remaining budget without Jev or on Jev failure, until a person reviews a refund", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM categories"),
		]);
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color, sort_order) VALUES ('Synthetic', 'groceries', 'cat-blue', 1) RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO budget_amounts VALUES (?, '2026-09', 100000)",
		)
			.bind(category?.id)
			.run();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								transaction_id: "purchase",
								amount: 200,
								name: "PURCHASE",
							}),
							transaction({
								transaction_id: "payroll",
								amount: -3000,
								name: "PAYROLL",
							}),
							transaction({
								transaction_id: "refund",
								amount: -5,
								name: "REFUND",
							}),
						],
					}),
				),
			),
		);
		const monthSummary = async () =>
			summarizeMonth({
				month: "2026-09",
				...(await loadMonth(env.DB, "2026-09")),
				unpaidDueBillsCents: 0,
			});
		const unclassified = await monthSummary();
		expect(unclassified.totalSpentCents).toBe(20000);
		expect(unclassified.safeToSpendCents).toBe(80000);
		expect(
			await env.DB.prepare(
				"SELECT credit_reviewed, flag_income FROM transactions WHERE plaid_transaction_id = 'payroll'",
			).first(),
		).toEqual({ credit_reviewed: 0, flag_income: 0 });

		vi.spyOn(console, "error").mockImplementation(() => {});
		const failedJev = await categorizePending(
			{ DB: env.DB, JEV_API_KEY: "synthetic-key" },
			async () => response({}, 429),
		);
		expect(failedJev.asked).toBe(1);
		expect((await monthSummary()).safeToSpendCents).toBe(80000);

		const refund = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'refund'",
		).first<{ id: number }>();
		await saveEdit(
			env.DB,
			refund?.id as number,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: false,
				creditReviewed: true,
			},
			"synthetic-person",
		);
		const reviewedRefund = await monthSummary();
		expect(reviewedRefund.totalSpentCents).toBe(19500);
		expect(reviewedRefund.safeToSpendCents).toBe(80500);
	});

	it.each(["added", "modified"] as const)(
		"unlinks a refund of a part when a %s amount change removes the split",
		async (kind) => {
			const item = await addItem();
			await syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				item,
				plaidFetch(() => response(page({ added: [transaction()] }))),
			);
			const parent = await env.DB.prepare(
				"SELECT id, account_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
			).first<{ id: number; account_id: number }>();
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET is_split = 1 WHERE id = ?",
				).bind(parent?.id),
				env.DB.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, parent_id) VALUES (8801, ?, '2026-09-27', 1234, 'RAW SHOP', ?)",
				).bind(parent?.account_id, parent?.id),
				env.DB.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, refund_of_id) VALUES (8802, ?, '2026-09-29', -500, 'RAW SHOP', 8801)",
				).bind(parent?.account_id),
			]);
			await syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				item,
				plaidFetch(() =>
					response(page({ [kind]: [transaction({ amount: 20 })] })),
				),
			);
			expect(
				await env.DB.prepare(
					"SELECT refund_of_id FROM transactions WHERE id = 8802",
				).first(),
			).toEqual({ refund_of_id: null });
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
				)
					.bind(parent?.id)
					.first(),
			).toEqual({ n: 0 });
		},
	);

	it("moves split children with a date correction and removes them for an amount correction", async () => {
		const item = await addItem();
		const sync = (overrides: Record<string, unknown>) =>
			syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				item,
				plaidFetch(() =>
					response(page({ modified: [transaction(overrides)] })),
				),
			);
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			item,
			plaidFetch(() => response(page({ added: [transaction()] }))),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; account_id: number }>();
		const category = await env.DB.prepare(
			"SELECT id FROM categories LIMIT 1",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET is_split = 1, category_id = ? WHERE id = ?",
			).bind(category?.id, parent?.id),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, parent_id) VALUES (?, '2026-09-27', 500, 'RAW SHOP', ?, ?)",
			).bind(parent?.account_id, category?.id, parent?.id),
		]);
		await sync({ date: "2026-10-01" });
		expect(
			await env.DB.prepare("SELECT date FROM transactions WHERE parent_id = ?")
				.bind(parent?.id)
				.first(),
		).toEqual({ date: "2026-10-01" });
		await sync({ date: "2026-10-01", amount: 20 });
		expect(
			await env.DB.prepare(
				"SELECT is_split, category_id, split_removed_from_cents FROM transactions WHERE id = ?",
			)
				.bind(parent?.id)
				.first(),
		).toEqual({
			is_split: 0,
			category_id: null,
			split_removed_from_cents: 1234,
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id = ?",
				)
					.bind(parent?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
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

	it("does not release a newer owner's lock after its own lease expires", async () => {
		const id = await addItem();
		let releaseA!: () => void;
		let releaseB!: () => void;
		const waitA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const waitB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		const runA = syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(async () => {
				await waitA;
				return response(page());
			}),
		);
		await vi.waitFor(async () => {
			expect((await itemState(id))?.sync_lock_id).not.toBeNull();
		});
		const lockA = (await itemState(id))?.sync_lock_id;
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = datetime('now', '-1 minute') WHERE id = ?",
		)
			.bind(id)
			.run();
		const runB = syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(async () => {
				await waitB;
				return response(page());
			}),
		);
		await vi.waitFor(async () => {
			expect((await itemState(id))?.sync_lock_id).not.toBe(lockA);
		});
		const lockB = (await itemState(id))?.sync_lock_id;
		releaseA();
		await expect(runA).rejects.toThrow("lost its lock");
		expect(await itemState(id)).toMatchObject({ sync_lock_id: lockB });
		releaseB();
		await runB;
		expect(await itemState(id)).toMatchObject({
			sync_lock_id: null,
			sync_locked_until: null,
		});
	});

	it("never logs tokens, names, or amounts on success followed by an Item error", async () => {
		const id = await addItem();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		try {
			await expect(
				syncItem(
					{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
					id,
					plaidFetch(() => {
						calls += 1;
						if (calls === 1) {
							return response(
								page({
									added: [
										transaction({ name: "SECRET NAME", amount: 9876.54 }),
									],
									next_cursor: "secret-cursor",
									has_more: true,
								}),
							);
						}
						return response(
							{
								error_type: "ITEM_ERROR",
								error_code: "ITEM_LOGIN_REQUIRED",
								request_id: "safe-request-id",
							},
							400,
						);
					}),
				),
			).rejects.toThrow("Plaid request failed");
			const output = [...log.mock.calls, ...error.mock.calls].flat().join(" ");
			for (const secret of ["secret-access-token", "SECRET NAME", "9876.54"]) {
				expect(output).not.toContain(secret);
			}
		} finally {
			log.mockRestore();
			error.mockRestore();
		}
	});

	it("keeps page one and its cursor after page two fails, then resumes without duplicates", async () => {
		const id = await addItem();
		const run = () =>
			plaidFetch((body) =>
				body.cursor === undefined
					? response(
							page({
								added: [transaction()],
								next_cursor: "cursor-1",
								has_more: true,
							}),
						)
					: body.cursor === "cursor-1" && failing
						? response(
								{
									error_type: "API_ERROR",
									error_code: "INTERNAL_SERVER_ERROR",
								},
								500,
							)
						: response(
								page({
									added: [transaction({ transaction_id: "transaction-2" })],
									next_cursor: "cursor-2",
								}),
							),
			);
		let failing = true;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, run()),
		).rejects.toThrow();
		spy.mockRestore();
		expect((await itemState(id))?.sync_cursor).toBe("cursor-1");
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first())
				?.n,
		).toBe(1);

		failing = false;
		const resumed = run();
		expect(
			await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, resumed),
		).toEqual({ added: 1, modified: 0, removed: 0 });
		expect(JSON.parse(String(resumed.mock.calls[1]?.[1]?.body)).cursor).toBe(
			"cursor-1",
		);
		const { results } = await env.DB.prepare(
			"SELECT plaid_transaction_id FROM transactions ORDER BY id",
		).all();
		expect(results.map((row) => row.plaid_transaction_id)).toEqual([
			"transaction-1",
			"transaction-2",
		]);
		expect((await itemState(id))?.sync_cursor).toBe("cursor-2");
	});

	it("removes a transaction and its split children", async () => {
		const id = await addItem();
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
			id,
			plaidFetch(() => response(page({ added: [transaction()] }))),
		);
		const parent = await env.DB.prepare(
			"SELECT id, account_id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number; account_id: number }>();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, '2026-09-27', 600, 'RAW SHOP', ?), (?, '2026-09-27', 634, 'RAW SHOP', ?)",
		)
			.bind(parent?.account_id, parent?.id, parent?.account_id, parent?.id)
			.run();

		expect(
			await syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				id,
				plaidFetch(() =>
					response(
						page({
							removed: [{ transaction_id: "transaction-1" }],
							next_cursor: "cursor-2",
						}),
					),
				),
			),
		).toEqual({ added: 0, modified: 0, removed: 1 });
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first())
				?.n,
		).toBe(0);
	});

	it("writes nothing once another run has taken its expired lock", async () => {
		const id = await addItem();
		const fetchImpl = plaidFetch(async () => {
			await env.DB.prepare(
				"UPDATE plaid_items SET sync_lock_id = 'newer-run', sync_locked_until = datetime('now', '+5 minutes'), sync_cursor = 'newer-cursor' WHERE id = ?",
			)
				.bind(id)
				.run();
			return response(page({ added: [transaction()] }));
		});

		await expect(
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).rejects.toThrow("lost its lock");
		expect(await itemState(id)).toMatchObject({
			sync_cursor: "newer-cursor",
			sync_lock_id: "newer-run",
		});
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first())
				?.n,
		).toBe(0);
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first())?.n,
		).toBe(0);
	});

	it("doesn't flag the Item for an error after another run has taken its lock", async () => {
		const id = await addItem();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			syncItem(
				{ ...env, TOKEN_ENCRYPTION_KEY: KEY },
				id,
				plaidFetch(async () => {
					await env.DB.prepare(
						"UPDATE plaid_items SET sync_lock_id = 'newer-run', sync_locked_until = datetime('now', '+5 minutes') WHERE id = ?",
					)
						.bind(id)
						.run();
					return response(
						{ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" },
						400,
					);
				}),
			),
		).rejects.toThrow("Plaid request failed");
		spy.mockRestore();
		expect(await itemState(id)).toMatchObject({
			status: "ok",
			sync_lock_id: "newer-run",
		});
	});

	it("doesn't overwrite a repair completed while confirming a login error", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ?",
		)
			.bind(id)
			.run();
		const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url).endsWith("/accounts/get")) {
				return response({ accounts: [account()] });
			}
			if (String(url).endsWith("/item/get")) {
				await env.DB.prepare(
					"UPDATE plaid_items SET status = 'ok' WHERE id = ?",
				)
					.bind(id)
					.run();
				return response({
					item: { error: { error_code: "ITEM_LOGIN_REQUIRED" } },
				});
			}
			return response(
				{ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" },
				400,
			);
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
		).rejects.toThrow("Plaid request failed");
		spy.mockRestore();
		expect((await itemState(id))?.status).toBe("ok");
	});

	it.each([
		["the login was repaired", response({ item: { error: null } }), "ok"],
		["the error field is missing", response({ item: {} }), "needs_attention"],
		[
			"Plaid still reports the login error",
			response({ item: { error: { error_code: "ITEM_LOGIN_REQUIRED" } } }),
			"needs_attention",
		],
		["the confirmation request fails", response({}, 500), "needs_attention"],
	] as const)(
		"rethrows a login error and leaves the right status when %s",
		async (_case, itemResponse, expectedStatus) => {
			const id = await addItem();
			const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
				if (String(url).endsWith("/accounts/get"))
					return response({ accounts: [account()] });
				if (String(url).endsWith("/item/get")) return itemResponse;
				return response(
					{
						error_type: "ITEM_ERROR",
						error_code: "ITEM_LOGIN_REQUIRED",
						request_id: "safe-request-id",
					},
					400,
				);
			});
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			await expect(
				syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl),
			).rejects.toThrow("Plaid request failed");
			spy.mockRestore();
			expect((await itemState(id))?.status).toBe(expectedStatus);
			expect(
				fetchImpl.mock.calls.filter(([url]) =>
					String(url).endsWith("/item/get"),
				),
			).toHaveLength(1);
		},
	);

	it("flags every Item error except temporary ones, and always rethrows", async () => {
		expect(TRANSIENT_ITEM_ERROR_CODES).toEqual([
			"PRODUCT_NOT_READY",
			"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
		]);
		for (const [type, code, expectedStatus] of [
			["ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "needs_attention"],
			["ITEM_ERROR", "PASSWORD_RESET_REQUIRED", "needs_attention"],
			["ITEM_ERROR", "PRODUCT_NOT_READY", "ok"],
			["INSTITUTION_ERROR", "INSTITUTION_DOWN", "ok"],
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
								error_type: type,
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
