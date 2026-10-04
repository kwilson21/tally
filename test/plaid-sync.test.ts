import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { categorizePending } from "../src/categorize-pending";
import { loadMonth } from "../src/db/month";
import { saveEdit, saveJevResult } from "../src/db/transactions";
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

	it("keeps Jev's negative-credit income decision through added replays and modifications", async () => {
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
			confidence: 0.4,
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
			).toEqual({ flag_income: 1, income_source: "jev" });
		}
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
