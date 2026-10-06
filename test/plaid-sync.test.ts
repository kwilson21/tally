import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { loadMonth } from "../src/db/month";
import {
	getTransaction,
	pendingForJev,
	removeSplit,
	saveEdit,
	saveJevResult,
	saveSplit,
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
			env.DB.prepare("DELETE FROM merchants"),
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
		).toEqual({ added: 3, modified: 0, removed: 0 });
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
		"clears a merchant rule's category when Plaid corrects the merchant (%s), and the sync gives it the new merchant's rule",
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
			// The old rule's category is cleared, and the sync's own rules step gives the new merchant's.
			expect(await state()).toEqual({
				"by-rule": [second, "merchant_rule"],
				"by-user": [first, "user"],
				"by-jev": [first, "jev"],
				same: [first, "merchant_rule"],
			});
			await env.DB.prepare(
				"DELETE FROM merchants WHERE raw_name = 'New Shop'",
			).run();
		},
	);

	it("applies merchant rules to the transactions a sync brings in, and never to one a person or Jev categorized", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({ transaction_id: "by-user" }),
							transaction({ transaction_id: "by-jev" }),
						],
					}),
				),
			),
		);
		const [rule, mine] = (
			await env.DB.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 2",
			).all<{ id: number }>()
		).results.map((r) => r.id) as [number, number];
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE plaid_transaction_id = 'by-user'",
			).bind(mine),
			env.DB.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE plaid_transaction_id = 'by-jev'",
			).bind(mine),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('Shop', ?)",
			).bind(rule),
		]);

		// The two already-sorted ones come back changed; a third arrives new.
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(
					page({
						added: [transaction({ transaction_id: "fresh" })],
						modified: [
							transaction({ transaction_id: "by-user", date: "2026-09-28" }),
							transaction({ transaction_id: "by-jev", date: "2026-09-28" }),
						],
					}),
				),
			),
		);

		expect(
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
			),
		).toEqual({
			fresh: [rule, "merchant_rule"],
			"by-user": [mine, "user"],
			"by-jev": [mine, "jev"],
		});
	});

	it("starts a merchant's settings as a copy of its bank-text row when Plaid first names it, so its rule, name and Not a bill carry over, and the sync's rules step then applies the rule", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name, merchant_raw_text) VALUES ('Internet', 1234, 27, 'monthly', 'COMCAST CABLE', 1)",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, suggested_name, default_category_id, not_a_bill) VALUES ('COMCAST CABLE', 'Comcast Cable', 'Comcast', (SELECT id FROM categories LIMIT 1), 1)",
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

		// The new row is the old row's settings, under the key.
		expect(
			(
				await env.DB.prepare(
					"SELECT raw_name, display_name, suggested_name, (default_category_id IS NOT NULL) AS ruled, not_a_bill FROM merchants ORDER BY raw_name",
				).all()
			).results,
		).toEqual([
			{
				raw_name: "COMCAST CABLE",
				display_name: "Comcast Cable",
				suggested_name: "Comcast",
				ruled: 1,
				not_a_bill: 1,
			},
			{
				raw_name: "Comcast",
				display_name: "Comcast Cable",
				suggested_name: "Comcast",
				ruled: 1,
				not_a_bill: 1,
			},
		]);
		const charge = await env.DB.prepare(
			"SELECT id, category_source FROM transactions",
		).first<{ id: number; category_source: string | null }>();
		expect(charge?.category_source).toBe("merchant_rule");
		expect(
			(await getTransaction(env.DB, charge?.id as number))?.displayName,
		).toBe("Comcast Cable");
		// The bill saved under the bank text still pays from the charge.
		expect(
			await env.DB.prepare(
				"SELECT bp.period FROM bill_payments bp WHERE bp.status = 'linked'",
			).first(),
		).toEqual({ period: "2026-09" });
	});

	it("copies on a modified transaction too, only the first time, and never again from the old row", async () => {
		const id = await addItem();
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('BANK TEXT ONE', 'First'), ('BANK TEXT TWO', 'Second')",
			),
		]);
		// Stored with no merchant name, as before Phase 3.5: nothing is copied.
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								transaction_id: "one",
								name: "BANK TEXT ONE",
								merchant_name: null,
							}),
						],
					}),
				),
			),
		);
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM merchants").first())?.n,
		).toBe(2);

		// Plaid now names it: the merchant's row starts as a copy of the old row.
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(
					page({
						modified: [
							transaction({
								transaction_id: "one",
								name: "BANK TEXT ONE",
								merchant_name: "Merchant",
							}),
						],
					}),
				),
			),
		);
		const name = async () =>
			(
				await env.DB.prepare(
					"SELECT display_name FROM merchants WHERE raw_name = 'Merchant'",
				).first()
			)?.display_name;
		expect(await name()).toBe("First");

		// Another bank text with the same name finds the row there and leaves it be, and a later edit to
		// an old row never reaches the merchant's.
		await env.DB.prepare(
			"UPDATE merchants SET display_name = 'Changed' WHERE raw_name IN ('BANK TEXT ONE', 'BANK TEXT TWO')",
		).run();
		await syncItem(
			opts,
			id,
			plaidFetch(() =>
				response(
					page({
						added: [
							transaction({
								transaction_id: "two",
								name: "BANK TEXT TWO",
								merchant_name: "Merchant",
							}),
						],
						modified: [
							transaction({
								transaction_id: "one",
								name: "BANK TEXT ONE",
								merchant_name: "Merchant",
								date: "2026-09-28",
							}),
						],
					}),
				),
			),
		);
		expect(await name()).toBe("First");
	});

	it("copies nothing when the merchant already has a row, the key is the bank text, or no row exists for the bank text", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('HAS ROW', 'Old'), ('Has Row Key', 'Mine'), ('SAME', 'Same')",
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
								transaction_id: "a",
								name: "HAS ROW",
								merchant_name: "Has Row Key",
							}),
							transaction({
								transaction_id: "b",
								name: "SAME",
								merchant_name: "SAME",
							}),
							transaction({
								transaction_id: "c",
								name: "NO ROW FOR THIS TEXT",
								merchant_name: "Unknown",
							}),
						],
					}),
				),
			),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT raw_name, display_name FROM merchants ORDER BY raw_name",
				).all()
			).results,
		).toEqual([
			{ raw_name: "HAS ROW", display_name: "Old" },
			{ raw_name: "Has Row Key", display_name: "Mine" },
			{ raw_name: "SAME", display_name: "Same" },
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
				response(
					page({
						added: [
							transaction({ amount: -12 }),
							transaction({ transaction_id: "purchase", amount: 50 }),
						],
					}),
				),
			),
		);
		const tx = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'transaction-1'",
		).first<{ id: number }>();
		const purchase = await env.DB.prepare(
			"SELECT id, date FROM transactions WHERE plaid_transaction_id = 'purchase'",
		).first<{ id: number; date: string }>();
		if (!purchase) throw new Error("Expected the purchase");
		await env.DB.prepare(
			"UPDATE transactions SET refund_of_id = ?, category_source = 'jev', category_confidence = 0.95, credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(purchase.id, tx?.id)
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
			refund_of_id: purchase.id,
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

	describe("a bank correction that leaves a purchase over-refunded (spec §8.5)", () => {
		const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
		type Refund = { id: string; amount: number; date: string };

		/** A $`purchase` purchase and refunds of the given dollars, all linked to it by a person. */
		async function linked(purchase: number, refunds: Refund[]) {
			const item = await addItem();
			await syncItem(
				opts,
				item,
				plaidFetch(() =>
					response(
						page({
							added: [
								transaction({
									transaction_id: "purchase",
									amount: purchase,
									name: "REFUND SHOP",
									date: "2026-09-01",
								}),
								...refunds.map((r) =>
									transaction({
										transaction_id: r.id,
										amount: -r.amount,
										name: "REFUND SHOP",
										date: r.date,
									}),
								),
							],
						}),
					),
				),
			);
			await env.DB.prepare(
				`UPDATE transactions SET refund_of_id = (SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase'),
					credit_reviewed = 1, credit_reviewed_by = 'user'
				WHERE plaid_transaction_id IN (${refunds.map(() => "?").join(", ")})`,
			)
				.bind(...refunds.map((r) => r.id))
				.run();
			return item;
		}

		/** Which refunds are still linked to the purchase, by Plaid id, oldest id first. */
		async function stillLinked() {
			const { results } = await env.DB.prepare(
				`SELECT r.plaid_transaction_id AS id FROM transactions r
				WHERE r.refund_of_id = (SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase')
				ORDER BY r.id`,
			).all<{ id: string }>();
			return results.map((r) => r.id);
		}

		const correct = (
			item: number,
			path: "added" | "modified",
			t: Record<string, unknown>,
		) =>
			syncItem(
				opts,
				item,
				plaidFetch(() => response(page({ [path]: [transaction(t)] }))),
			);

		const refundTx = (id: string, amount: number, date: string) => ({
			transaction_id: id,
			amount: -amount,
			name: "REFUND SHOP",
			date,
		});

		it.each(["added", "modified"] as const)(
			"unlinks a refund the bank corrected to more than its purchase (%s)",
			async (path) => {
				const item = await linked(50, [
					{ id: "refund", amount: 30, date: "2026-09-10" },
				]);
				await correct(item, path, refundTx("refund", 60, "2026-09-10"));
				expect(await stillLinked()).toEqual([]);
				// Only the link is gone: the refund keeps the bank's new amount and its review.
				expect(
					await env.DB.prepare(
						"SELECT amount_cents, refund_of_id, credit_reviewed, credit_reviewed_by FROM transactions WHERE plaid_transaction_id = 'refund'",
					).first(),
				).toEqual({
					amount_cents: -6000,
					refund_of_id: null,
					credit_reviewed: 1,
					credit_reviewed_by: "user",
				});
			},
		);

		it.each(["added", "modified"] as const)(
			"keeps a refund the bank corrected to a size that still fits (%s)",
			async (path) => {
				const item = await linked(50, [
					{ id: "refund", amount: 30, date: "2026-09-10" },
				]);
				await correct(item, path, refundTx("refund", 40, "2026-09-10"));
				expect(await stillLinked()).toEqual(["refund"]);
				// Up to the purchase's amount exactly is still a refund of it.
				await correct(item, path, refundTx("refund", 50, "2026-09-10"));
				expect(await stillLinked()).toEqual(["refund"]);
				await correct(item, path, refundTx("refund", 50.01, "2026-09-10"));
				expect(await stillLinked()).toEqual([]);
			},
		);

		it.each(["added", "modified"] as const)(
			"unlinks a refund when the bank corrected its purchase to less (%s)",
			async (path) => {
				const item = await linked(50, [
					{ id: "refund", amount: 30, date: "2026-09-10" },
				]);
				await correct(item, path, {
					transaction_id: "purchase",
					amount: 20,
					name: "REFUND SHOP",
					date: "2026-09-01",
				});
				expect(await stillLinked()).toEqual([]);
			},
		);

		it("removes the newest refunds first, until the rest fit", async () => {
			const item = await linked(50, [
				{ id: "first", amount: 20, date: "2026-09-10" },
				{ id: "second", amount: 20, date: "2026-09-12" },
				{ id: "third", amount: 5, date: "2026-09-14" },
			]);
			// $50 down to $30: the newest ($5, then $20) go; $20 stays.
			await correct(item, "modified", {
				transaction_id: "purchase",
				amount: 30,
				name: "REFUND SHOP",
				date: "2026-09-01",
			});
			expect(await stillLinked()).toEqual(["first"]);
		});

		it("takes refunds on the same day newest by id", async () => {
			const item = await linked(50, [
				{ id: "a", amount: 20, date: "2026-09-10" },
				{ id: "b", amount: 20, date: "2026-09-10" },
			]);
			await correct(item, "modified", {
				transaction_id: "purchase",
				amount: 30,
				name: "REFUND SHOP",
				date: "2026-09-01",
			});
			expect(await stillLinked()).toEqual(["a"]);
		});

		it("looks only at the purchases the sync changed, leaving other links alone", async () => {
			const item = await linked(50, [
				{ id: "refund", amount: 30, date: "2026-09-10" },
			]);
			// Another purchase that was over-refunded before this rule: nothing in this sync touches it.
			await syncItem(
				opts,
				item,
				plaidFetch(() =>
					response(
						page({
							added: [
								transaction({
									transaction_id: "old-purchase",
									amount: 10,
									name: "OTHER SHOP",
									date: "2026-08-01",
								}),
								transaction({
									transaction_id: "old-refund",
									amount: -25,
									name: "OTHER SHOP",
									date: "2026-08-05",
								}),
							],
						}),
					),
				),
			);
			await env.DB.prepare(
				"UPDATE transactions SET refund_of_id = (SELECT id FROM transactions WHERE plaid_transaction_id = 'old-purchase') WHERE plaid_transaction_id = 'old-refund'",
			).run();
			await correct(item, "modified", refundTx("refund", 60, "2026-09-10"));
			expect(await stillLinked()).toEqual([]);
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE plaid_transaction_id = 'old-refund' AND refund_of_id IS NOT NULL",
				).first(),
			).toEqual({ n: 1 });
		});

		it("a linked income credit doesn't count toward the purchase", async () => {
			const item = await linked(50, [
				{ id: "income", amount: 30, date: "2026-09-08" },
				{ id: "refund", amount: 20, date: "2026-09-10" },
			]);
			await env.DB.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = 'user' WHERE plaid_transaction_id = 'income'",
			).run();
			// $45 of refunds that count, $30 of income credit that doesn't: it fits.
			await correct(item, "modified", refundTx("refund", 45, "2026-09-10"));
			expect(await stillLinked()).toEqual(["income", "refund"]);
			await correct(item, "modified", refundTx("refund", 55, "2026-09-10"));
			expect(await stillLinked()).toEqual(["income"]);
		});

		describe("a split refund", () => {
			/** A $50 purchase and a $40 refund linked to it, split into two $20 parts, then the purchase corrected to $30. */
			async function trimmedSplit() {
				const item = await linked(50, [
					{ id: "refund", amount: 40, date: "2026-09-10" },
				]);
				const refund = (await env.DB.prepare(
					"SELECT id FROM transactions WHERE plaid_transaction_id = 'refund'",
				).first<{ id: number }>()) as { id: number };
				await saveSplit(
					env.DB,
					refund.id,
					[
						{ categoryId: 1, amountCents: -2000 },
						{ categoryId: 2, amountCents: -2000 },
					],
					"person@example.com",
				);
				await correct(item, "modified", {
					transaction_id: "purchase",
					amount: 30,
					name: "REFUND SHOP",
					date: "2026-09-01",
				});
				return { item, refundId: refund.id };
			}

			/** What is linked to the purchase and counts: every unsplit refund and every part, in cents. */
			async function refundedCents() {
				const row = await env.DB.prepare(
					`SELECT COALESCE(SUM(-amount_cents), 0) AS cents FROM transactions
					WHERE refund_of_id = (SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase')
						AND is_split = 0 AND amount_cents < 0 AND flag_income = 0`,
				).first<{ cents: number }>();
				return row?.cents;
			}

			it("loses the parts that no longer fit, one part at a time", async () => {
				const { refundId } = await trimmedSplit();
				const { results } = await env.DB.prepare(
					"SELECT refund_of_id IS NOT NULL AS linked FROM transactions WHERE parent_id = ? ORDER BY id",
				)
					.bind(refundId)
					.all<{ linked: number }>();
				expect(results.map((part) => part.linked)).toEqual([1, 0]);
				expect(await refundedCents()).toBe(2000);
			});

			it("is not over-refunded when the split is removed", async () => {
				const { refundId } = await trimmedSplit();
				const unlinked = await removeSplit(
					env.DB,
					refundId,
					"person@example.com",
				);
				// The whole $40 refund no longer fits the $30 purchase: it is unlinked, and the person is told.
				expect(unlinked).toEqual(["2026-09-10"]);
				expect(await refundedCents()).toBe(0);
				expect(
					await env.DB.prepare(
						"SELECT is_split, refund_of_id FROM transactions WHERE id = ?",
					)
						.bind(refundId)
						.first(),
				).toEqual({ is_split: 0, refund_of_id: null });
			});

			it("is not over-refunded when it is split again", async () => {
				const { refundId } = await trimmedSplit();
				const result = await saveSplit(
					env.DB,
					refundId,
					[
						{ categoryId: 1, amountCents: -2500 },
						{ categoryId: 2, amountCents: -1500 },
					],
					"person@example.com",
				);
				expect(result).toEqual({ saved: true, unlinked: ["2026-09-10"] });
				expect(await refundedCents()).toBe(0);
			});

			it("keeps its link when the split is removed and the whole refund still fits", async () => {
				const item = await linked(50, [
					{ id: "refund", amount: 40, date: "2026-09-10" },
				]);
				const refund = (await env.DB.prepare(
					"SELECT id FROM transactions WHERE plaid_transaction_id = 'refund'",
				).first<{ id: number }>()) as { id: number };
				await saveSplit(
					env.DB,
					refund.id,
					[
						{ categoryId: 1, amountCents: -2000 },
						{ categoryId: 2, amountCents: -2000 },
					],
					"person@example.com",
				);
				// A date-only correction to the purchase changes no amount.
				await correct(item, "modified", {
					transaction_id: "purchase",
					amount: 50,
					name: "REFUND SHOP",
					date: "2026-09-02",
				});
				expect(
					await removeSplit(env.DB, refund.id, "person@example.com"),
				).toEqual([]);
				expect(await stillLinked()).toEqual(["refund"]);
			});

			it("is checked as a whole when the bank corrects its amount and ends the split", async () => {
				const item = await linked(50, [
					{ id: "refund", amount: 40, date: "2026-09-10" },
				]);
				const refund = (await env.DB.prepare(
					"SELECT id FROM transactions WHERE plaid_transaction_id = 'refund'",
				).first<{ id: number }>()) as { id: number };
				await saveSplit(
					env.DB,
					refund.id,
					[
						{ categoryId: 1, amountCents: -2000 },
						{ categoryId: 2, amountCents: -2000 },
					],
					"person@example.com",
				);
				await correct(item, "modified", refundTx("refund", 60, "2026-09-10"));
				expect(await refundedCents()).toBe(0);
				expect(await stillLinked()).toEqual([]);
			});
		});
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

describe("Plaid's INCOME category at sync (spec §8.5, decisions 67 and 70)", () => {
	const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
	const payroll = (overrides: Record<string, unknown> = {}) =>
		transaction({
			transaction_id: "payroll",
			amount: -3000,
			name: "PAYROLL",
			personal_finance_category: { primary: "INCOME" },
			...overrides,
		});
	const notIncomeByPlaid = {
		personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
	};
	const send = (
		id: number,
		path: "added" | "modified",
		...transactions: ReturnType<typeof transaction>[]
	) =>
		syncItem(
			opts,
			id,
			plaidFetch(() => response(page({ [path]: transactions }))),
		);
	const income = () =>
		env.DB.prepare(
			"SELECT flag_income, income_source, plaid_category FROM transactions WHERE plaid_transaction_id = 'payroll'",
		).first();
	const payrollId = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE plaid_transaction_id = 'payroll'",
			).first<{ id: number }>()
		)?.id as number;
	const jevAnswer = (income: boolean) => ({
		categoryId: null,
		suggestedCategoryId: null,
		confidence: 0.95,
		flags: { transfer: false, reimbursement: false, income },
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
	});

	it("counts a paycheck Plaid calls INCOME toward Income and not Spent, and never holds it for review", async () => {
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

		await send(
			id,
			"added",
			transaction({
				transaction_id: "purchase",
				amount: 200,
				name: "PURCHASE",
			}),
			payroll(),
			transaction({ transaction_id: "refund", amount: -5, name: "REFUND" }),
		);

		expect(await income()).toEqual({
			flag_income: 1,
			income_source: null,
			plaid_category: "INCOME",
		});
		const month = summarizeMonth({
			month: "2026-09",
			...(await loadMonth(env.DB, "2026-09")),
			unpaidDueBillsCents: 0,
		});
		expect(month.incomeCents).toBe(300000);
		// Only the purchase is spent: the paycheck is income, and the unreviewed refund is held.
		expect(month.totalSpentCents).toBe(20000);
		expect(month.safeToSpendCents).toBe(80000);
		const asked = (await pendingForJev(env.DB, 10)).map((t) => t.rawName);
		expect(asked).toContain("REFUND");
		expect(asked).not.toContain("PAYROLL");
	});

	it("does not ask Jev about a Plaid-income paycheck", async () => {
		const id = await addItem();
		await send(id, "added", payroll());
		const jev = vi.fn(async () => response({}, 500));
		expect(
			await categorizePending(
				{ DB: env.DB, JEV_API_KEY: "synthetic-key" },
				jev,
			),
		).toEqual({ asked: 0, applied: 0 });
		expect(jev).not.toHaveBeenCalled();
		expect(await income()).toMatchObject({
			flag_income: 1,
			income_source: null,
		});
	});

	it.each(["added", "modified"] as const)(
		"keeps a person's 'not income' through a %s sync that still says INCOME",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll());
			await env.DB.prepare(
				"UPDATE transactions SET flag_income = 0, income_source = 'user' WHERE plaid_transaction_id = 'payroll'",
			).run();

			await send(id, path, payroll());
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: "user",
			});
			// A corrected amount does not hand the choice back either.
			await send(id, path, payroll({ amount: -3100 }));
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: "user",
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"keeps a credit a person reviewed as non-income through a %s sync that says INCOME",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll({ amount: -30, ...notIncomeByPlaid }));
			await env.DB.prepare(
				"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE plaid_transaction_id = 'payroll'",
			).run();

			await send(id, path, payroll({ amount: -30 }));
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: null,
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"marks a transaction already synced as income when a %s sync first says INCOME",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll(notIncomeByPlaid));
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: null,
			});

			await send(id, path, payroll());
			expect(await income()).toEqual({
				flag_income: 1,
				income_source: null,
				plaid_category: "INCOME",
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"clears a Plaid-set flag when a %s sync says it is no longer INCOME",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll());
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: null,
			});

			await send(id, path, payroll(notIncomeByPlaid));
			expect(await income()).toEqual({
				flag_income: 0,
				income_source: null,
				plaid_category: "GENERAL_MERCHANDISE",
			});
			// Back to INCOME, it is marked again.
			await send(id, path, payroll());
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: null,
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"leaves a person's income flag alone when a %s sync says it is no longer INCOME",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll());
			await env.DB.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = 'user' WHERE plaid_transaction_id = 'payroll'",
			).run();

			await send(id, path, payroll(notIncomeByPlaid));
			expect(await income()).toEqual({
				flag_income: 1,
				income_source: "user",
				plaid_category: "GENERAL_MERCHANDISE",
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"leaves Jev's income flag alone through %s syncs that say INCOME and then not",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll(notIncomeByPlaid));
			await saveJevResult(env.DB, await payrollId(), jevAnswer(true));
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: "jev",
			});

			await send(id, path, payroll());
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: "jev",
			});
			await send(id, path, payroll(notIncomeByPlaid));
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: "jev",
			});
		},
	);

	it("marks a credit as income when Plaid says INCOME after Jev said it wasn't", async () => {
		const id = await addItem();
		await send(id, "added", payroll(notIncomeByPlaid));
		await saveJevResult(env.DB, await payrollId(), jevAnswer(false));
		expect(await income()).toMatchObject({
			flag_income: 0,
			income_source: null,
		});

		await send(id, "modified", payroll());
		expect(await income()).toMatchObject({
			flag_income: 1,
			income_source: null,
		});
	});

	it.each([
		{ answer: false, incomeSwitch: true },
		{ answer: true, incomeSwitch: true },
		{ answer: true, incomeSwitch: false },
		{ answer: false, incomeSwitch: false },
	])(
		"does not let Jev's income answer ($answer, income switch on: $incomeSwitch) clear or take over a Plaid-set flag",
		async ({ answer, incomeSwitch }) => {
			const id = await addItem();
			await send(id, "added", payroll());
			const written = await saveJevResult(
				env.DB,
				await payrollId(),
				jevAnswer(answer),
				{ switches: { income: incomeSwitch } },
			);

			expect(written).toBe(true);
			// Still Plaid's, not a person's or Jev's, so a later sync can still undo it.
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: null,
			});
			await send(id, "modified", payroll(notIncomeByPlaid));
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: null,
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"does not flag an outgoing payment Plaid labels INCOME, so it stays in Spent, on a %s sync",
		async (path) => {
			const id = await addItem();
			if (path === "modified") {
				await send(id, "added", payroll({ amount: 500, ...notIncomeByPlaid }));
			}
			await send(id, path, payroll({ amount: 500 }));

			expect(await income()).toEqual({
				flag_income: 0,
				income_source: null,
				plaid_category: "INCOME",
			});
			const month = summarizeMonth({
				month: "2026-09",
				...(await loadMonth(env.DB, "2026-09")),
				unpaidDueBillsCents: 0,
			});
			expect(month.incomeCents).toBe(0);
			expect(month.totalSpentCents).toBe(50000);
		},
	);

	it.each(["added", "modified"] as const)(
		"clears a Plaid-set flag when a %s sync turns the amount into money out",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll());
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: null,
			});

			await send(id, path, payroll({ amount: 3000 }));
			expect(await income()).toMatchObject({
				flag_income: 0,
				income_source: null,
			});
			// Money in again, it is marked again.
			await send(id, path, payroll());
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: null,
			});
		},
	);

	it.each(["added", "modified"] as const)(
		"leaves a person's income flag alone when a %s sync turns the amount into money out",
		async (path) => {
			const id = await addItem();
			await send(id, "added", payroll());
			await env.DB.prepare(
				"UPDATE transactions SET flag_income = 1, income_source = 'user' WHERE plaid_transaction_id = 'payroll'",
			).run();

			await send(id, path, payroll({ amount: 3000 }));
			expect(await income()).toMatchObject({
				flag_income: 1,
				income_source: "user",
			});
		},
	);

	it("still lets Jev set income where Plaid did not", async () => {
		const id = await addItem();
		await send(id, "added", payroll(notIncomeByPlaid));
		await saveJevResult(env.DB, await payrollId(), jevAnswer(true));
		expect(await income()).toMatchObject({
			flag_income: 1,
			income_source: "jev",
		});
	});
});
