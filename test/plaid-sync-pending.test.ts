import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Spec §6 "Pending" and §6.1 (decisions 62 and 67): a pending transaction is stored and counted, and
// when the bank posts it under a new id, everything a person or Tally attached goes with it.

const KEY = btoa("01234567890123456789012345678901");
const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };

const account = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 100 },
};

const page = (overrides: Record<string, unknown> = {}) => ({
	added: [],
	modified: [],
	removed: [],
	next_cursor: "cursor-1",
	has_more: false,
	...overrides,
});

/** A pending charge by default; `posted` turns it into the posted twin of "pending-1". */
const pendingTx = (overrides: Record<string, unknown> = {}) => ({
	transaction_id: "pending-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 12.34,
	name: "RAW SHOP",
	merchant_name: "Shop",
	pending: true,
	pending_transaction_id: null,
	personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
	...overrides,
});
const postedTx = (overrides: Record<string, unknown> = {}) =>
	pendingTx({
		transaction_id: "posted-1",
		pending: false,
		pending_transaction_id: "pending-1",
		date: "2026-09-28",
		...overrides,
	});

const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Plaid answers /accounts/get with its account and /transactions/sync with whatever `sync` returns. */
const plaidFetch = (
	sync: (body: Record<string, unknown>) => Response | Promise<Response>,
) =>
	vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		if (String(url).endsWith("/accounts/get"))
			return response({ accounts: [account] });
		return sync(JSON.parse(String(init?.body)));
	});

const onePage = (overrides: Record<string, unknown>) =>
	plaidFetch(() => response(page(overrides)));

async function addItem() {
	const encrypted = await encryptToken("secret-access-token", KEY);
	const result = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();
	return result?.id as number;
}

const row = (plaidId: string) =>
	env.DB.prepare("SELECT * FROM transactions WHERE plaid_transaction_id = ?")
		.bind(plaidId)
		.first<Record<string, unknown>>();

const count = async (sql: string, ...args: unknown[]) =>
	(
		await env.DB.prepare(sql)
			.bind(...args)
			.first<{ n: number }>()
	)?.n;

/** Adds the pending charge and returns its row id. */
async function syncPending(item: number, overrides = {}) {
	await syncItem(opts, item, onePage({ added: [pendingTx(overrides)] }));
	return (await row("pending-1"))?.id as number;
}

/** The bank posts "pending-1" as "posted-1" and drops the pending id, as Plaid documents. */
const post = (item: number, overrides = {}, extra = {}) =>
	syncItem(
		opts,
		item,
		onePage({
			added: [postedTx(overrides)],
			removed: [{ transaction_id: "pending-1" }],
			next_cursor: "cursor-2",
			...extra,
		}),
	);

/** Two parts of a split purchase. */
async function splitInto(parent: number, a: number, b: number) {
	await env.DB.prepare(
		"UPDATE transactions SET is_split = 1, category_id = NULL WHERE id = ?",
	)
		.bind(parent)
		.run();
	const parentRow = await env.DB.prepare(
		"SELECT account_id, date, raw_name FROM transactions WHERE id = ?",
	)
		.bind(parent)
		.first<{ account_id: number; date: string; raw_name: string }>();
	const ids: number[] = [];
	for (const [cents, category] of [
		[a, 1],
		[b, 2],
	] as const) {
		const part = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id, category_id, category_source) VALUES (?, ?, ?, ?, ?, ?, 'user') RETURNING id",
		)
			.bind(
				parentRow?.account_id,
				parentRow?.date,
				cents,
				parentRow?.raw_name,
				parent,
				category,
			)
			.first<{ id: number }>();
		ids.push(part?.id as number);
	}
	return ids;
}

/** A credit that refunds `purchase`, already reviewed by a person. */
async function addRefund(purchase: number, cents = -300) {
	const result = await env.DB.prepare(
		"INSERT INTO transactions (account_id, date, amount_cents, raw_name, refund_of_id, credit_reviewed, credit_reviewed_by) SELECT account_id, '2026-09-29', ?, 'REFUND', ?, 1, 'user' FROM transactions WHERE id = ? RETURNING id",
	)
		.bind(cents, purchase, purchase)
		.first<{ id: number }>();
	return result?.id as number;
}

async function addBillLinkedTo(transactionId: number) {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (700, 'Phone', 1234, 28, 'monthly', 'Not a match')",
		),
		env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (700, '2026-09', ?, 'user', 'linked')",
		).bind(transactionId),
	]);
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare("DELETE FROM bills"),
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
});

describe("a pending transaction", () => {
	it("is stored with pending = 1 and counted in Spent like any other", async () => {
		const item = await addItem();
		const summary = await syncItem(
			opts,
			item,
			onePage({
				added: [
					pendingTx(),
					postedTx({
						transaction_id: "posted-other",
						pending_transaction_id: null,
						amount: 20,
					}),
				],
			}),
		);
		expect(summary).toEqual({ added: 2, modified: 0, removed: 0 });
		expect((await row("pending-1"))?.pending).toBe(1);
		expect((await row("posted-other"))?.pending).toBe(0);
		const month = summarizeMonth({
			month: "2026-09",
			...(await loadMonth(env.DB, "2026-09")),
			unpaidDueBillsCents: 0,
		});
		expect(month.totalSpentCents).toBe(1234 + 2000);
	});

	it("gets the same merchant name and Plaid category as a posted one", async () => {
		const item = await addItem();
		await syncPending(item, {
			merchant_name: "  Corner Shop ",
			personal_finance_category: { primary: "FOOD_AND_DRINK" },
		});
		expect(await row("pending-1")).toMatchObject({
			raw_name: "RAW SHOP",
			merchant_name: "Corner Shop",
			plaid_category: "FOOD_AND_DRINK",
			pending: 1,
		});
	});

	it("follows a change the bank makes while it is still pending", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 1, category_source = 'user', note = 'Dinner' WHERE id = ?",
		)
			.bind(id)
			.run();
		await syncItem(
			opts,
			item,
			onePage({ modified: [pendingTx({ amount: 15.5, date: "2026-09-28" })] }),
		);
		expect(await row("pending-1")).toMatchObject({
			id,
			amount_cents: 1550,
			date: "2026-09-28",
			pending: 1,
			category_id: 1,
			note: "Dinner",
		});
	});

	it("for an unknown account stops the sync, like a posted one", async () => {
		const item = await addItem();
		await expect(
			syncItem(
				opts,
				item,
				onePage({ added: [pendingTx({ account_id: "unknown" })] }),
			),
		).rejects.toThrow("unknown account");
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(0);
	});

	it("is added once when the same page is synced twice", async () => {
		const item = await addItem();
		const fetchImpl = onePage({ added: [pendingTx()] });
		expect(await syncItem(opts, item, fetchImpl)).toMatchObject({ added: 1 });
		expect(await syncItem(opts, item, fetchImpl)).toMatchObject({ added: 0 });
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
	});
});

describe("when the bank posts a pending transaction", () => {
	it("keeps its category, note, exclusion and income choice, and takes the posted date", async () => {
		const item = await addItem();
		const id = await syncPending(item, { amount: -42 });
		await env.DB.prepare(
			`UPDATE transactions SET category_id = 3, category_source = 'user', category_confidence = NULL,
				note = 'Birthday money', excluded = 1, excluded_source = 'user',
				flag_income = 1, income_source = 'user', credit_reviewed = 1, credit_reviewed_by = 'user',
				updated_by = 'person@example.com'
			 WHERE id = ?`,
		)
			.bind(id)
			.run();

		// Posting is not a new transaction: the person already saw it as pending.
		expect(await post(item, { amount: -42 })).toEqual({
			added: 0,
			modified: 0,
			removed: 1,
		});

		expect(await row("pending-1")).toBeNull();
		expect(await row("posted-1")).toMatchObject({
			pending: 0,
			date: "2026-09-28",
			amount_cents: -4200,
			category_id: 3,
			category_source: "user",
			note: "Birthday money",
			excluded: 1,
			excluded_source: "user",
			flag_income: 1,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			updated_by: "person@example.com",
		});
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
	});

	it("keeps a bill link, and the bill is paid by the posted transaction", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		await addBillLinkedTo(id);
		await post(item);
		const posted = await row("posted-1");
		expect(
			await env.DB.prepare(
				"SELECT bill_id, period, transaction_id, matched_by, status FROM bill_payments",
			).all(),
		).toMatchObject({
			results: [
				{
					bill_id: 700,
					period: "2026-09",
					transaction_id: posted?.id,
					matched_by: "user",
					status: "linked",
				},
			],
		});
	});

	it("keeps a refund linked both ways", async () => {
		const item = await addItem();
		// A pending purchase that a refund points at, and a pending refund that points at a posted purchase.
		await syncItem(
			opts,
			item,
			onePage({
				added: [
					pendingTx(),
					postedTx({
						transaction_id: "purchase",
						pending_transaction_id: null,
						amount: 50,
					}),
					pendingTx({
						transaction_id: "pending-refund",
						amount: -9,
						name: "SHOP REFUND",
					}),
				],
			}),
		);
		const pendingPurchase = (await row("pending-1"))?.id as number;
		const purchase = (await row("purchase"))?.id as number;
		const refundOfPending = await addRefund(pendingPurchase);
		const pendingRefund = (await row("pending-refund"))?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET refund_of_id = ?, credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
		)
			.bind(purchase, pendingRefund)
			.run();

		await syncItem(
			opts,
			item,
			onePage({
				added: [
					postedTx(),
					postedTx({
						transaction_id: "posted-refund",
						pending_transaction_id: "pending-refund",
						amount: -9,
						name: "SHOP REFUND",
					}),
				],
				removed: [
					{ transaction_id: "pending-1" },
					{ transaction_id: "pending-refund" },
				],
				next_cursor: "cursor-2",
			}),
		);

		const postedPurchase = (await row("posted-1"))?.id;
		const postedRefund = await row("posted-refund");
		// The refund that pointed at the pending purchase now points at the posted one.
		expect(
			(
				await env.DB.prepare(
					"SELECT refund_of_id FROM transactions WHERE id = ?",
				)
					.bind(refundOfPending)
					.first()
			)?.refund_of_id,
		).toBe(postedPurchase);
		// The pending refund's own link to its purchase is on the posted refund.
		expect(postedRefund?.refund_of_id).toBe(purchase);
		expect(await row("pending-refund")).toBeNull();
	});

	it("keeps a split when the amount is unchanged, and the parts follow the new date", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		const parts = await splitInto(id, 600, 634);
		await post(item);
		const posted = await row("posted-1");
		expect(posted).toMatchObject({
			is_split: 1,
			amount_cents: 1234,
			split_removed_from_cents: null,
		});
		const { results } = await env.DB.prepare(
			"SELECT id, parent_id, amount_cents, date, category_id FROM transactions WHERE parent_id IS NOT NULL ORDER BY id",
		).all();
		expect(results).toEqual([
			{
				id: parts[0],
				parent_id: posted?.id,
				amount_cents: 600,
				date: "2026-09-28",
				category_id: 1,
			},
			{
				id: parts[1],
				parent_id: posted?.id,
				amount_cents: 634,
				date: "2026-09-28",
				category_id: 2,
			},
		]);
	});

	it("removes the split when the amount changed, as for any bank correction (decision 62)", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		const parts = await splitInto(id, 600, 634);
		const refundOfPart = await addRefund(parts[0] as number, -100);

		await post(item, { amount: 15 });

		expect(await row("posted-1")).toMatchObject({
			is_split: 0,
			amount_cents: 1500,
			category_id: null,
			split_removed_from_cents: 1234,
		});
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NOT NULL",
			),
		).toBe(0);
		// A refund that pointed at a removed part counts on its own again.
		expect(
			(
				await env.DB.prepare(
					"SELECT refund_of_id FROM transactions WHERE id = ?",
				)
					.bind(refundOfPart)
					.first()
			)?.refund_of_id,
		).toBeNull();
	});

	it("keeps Jev's category only while the amount is unchanged", async () => {
		const item = await addItem();
		await syncItem(
			opts,
			item,
			onePage({
				added: [
					pendingTx(),
					pendingTx({ transaction_id: "pending-2", amount: 20 }),
				],
			}),
		);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 2, category_source = 'jev', category_confidence = 0.93, jev_category_id = 2",
		).run();
		await syncItem(
			opts,
			item,
			onePage({
				added: [
					postedTx(),
					postedTx({
						transaction_id: "posted-2",
						pending_transaction_id: "pending-2",
						amount: 21,
					}),
				],
				removed: [
					{ transaction_id: "pending-1" },
					{ transaction_id: "pending-2" },
				],
				next_cursor: "cursor-2",
			}),
		);
		expect(await row("posted-1")).toMatchObject({
			category_id: 2,
			category_source: "jev",
			category_confidence: 0.93,
		});
		expect(await row("posted-2")).toMatchObject({
			category_id: null,
			category_source: null,
			category_confidence: null,
		});
	});

	it("is added as a new transaction when the bank names a pending one Tally never had", async () => {
		const item = await addItem();
		expect(
			await syncItem(opts, item, onePage({ added: [postedTx()] })),
		).toEqual({ added: 1, modified: 0, removed: 0 });
		expect(await row("posted-1")).toMatchObject({ pending: 0 });
	});

	it("does the same when the posted page is synced again", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 4, category_source = 'user', note = 'Kept' WHERE id = ?",
		)
			.bind(id)
			.run();
		await post(item);
		expect(await post(item)).toEqual({ added: 0, modified: 0, removed: 1 });
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
		expect(await row("posted-1")).toMatchObject({
			id,
			category_id: 4,
			note: "Kept",
		});
	});

	it("moves nothing onto a posted transaction that already exists", async () => {
		const item = await addItem();
		await syncPending(item);
		await syncItem(
			opts,
			item,
			onePage({ added: [postedTx({ pending_transaction_id: null })] }),
		);
		// Both rows exist, so the twin is not re-keyed (that would break the unique id); the drop removes the pending one.
		await post(item);
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
		expect(await row("posted-1")).toMatchObject({ pending: 0 });
	});
});

describe("a pending transaction the bank drops", () => {
	it("is removed with its bill link, refund links and split parts", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		await addBillLinkedTo(id);
		const parts = await splitInto(id, 600, 634);
		const refundOfPending = await addRefund(id);
		const refundOfPart = await addRefund(parts[1] as number, -50);

		expect(
			await syncItem(
				opts,
				item,
				onePage({
					removed: [{ transaction_id: "pending-1" }],
					next_cursor: "cursor-2",
				}),
			),
		).toEqual({ added: 0, modified: 0, removed: 1 });

		expect(await row("pending-1")).toBeNull();
		expect(await count("SELECT COUNT(*) AS n FROM bill_payments")).toBe(0);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NOT NULL",
			),
		).toBe(0);
		// Only the two refunds remain, and neither points at a row that's gone.
		const { results } = await env.DB.prepare(
			"SELECT id, refund_of_id FROM transactions ORDER BY id",
		).all();
		expect(results).toEqual([
			{ id: refundOfPending, refund_of_id: null },
			{ id: refundOfPart, refund_of_id: null },
		]);
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id NOT IN (SELECT id FROM transactions)",
			),
		).toBe(0);
	});
});

describe("a pending transaction and its posted twin on different pages", () => {
	/** Page one drops the pending id; page two, still the same update, adds the posted twin. */
	const twoPages = (second: () => Response | Promise<Response>) =>
		plaidFetch((body) =>
			body.cursor === "page-1"
				? second()
				: response(
						page({
							removed: [{ transaction_id: "pending-1" }],
							next_cursor: "page-1",
							has_more: true,
						}),
					),
		);
	const postedPage = () =>
		response(
			page({
				added: [postedTx()],
				next_cursor: "page-2",
			}),
		);

	it("still moves everything, because a drop waits for the end of the update", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 2, category_source = 'user', note = 'Kept' WHERE id = ?",
		)
			.bind(id)
			.run();
		await addBillLinkedTo(id);

		await syncItem(opts, item, twoPages(postedPage));

		expect(await row("pending-1")).toBeNull();
		expect(await row("posted-1")).toMatchObject({
			id,
			category_id: 2,
			note: "Kept",
		});
		expect(await count("SELECT COUNT(*) AS n FROM bill_payments")).toBe(1);
		expect(
			(await env.DB.prepare("SELECT sync_cursor FROM plaid_items").first())
				?.sync_cursor,
		).toBe("page-2");
	});

	it("keeps the drop pending if the update stops partway, so the next run sees it again", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			syncItem(
				opts,
				item,
				twoPages(() => response({}, 500)),
			),
		).rejects.toThrow();
		// The pending row is still there, and the saved position is before the page that dropped it.
		expect((await row("pending-1"))?.id).toBe(id);
		expect(
			(await env.DB.prepare("SELECT sync_cursor FROM plaid_items").first())
				?.sync_cursor,
		).toBe("cursor-1");

		await syncItem(opts, item, twoPages(postedPage));
		expect(await row("pending-1")).toBeNull();
		expect((await row("posted-1"))?.id).toBe(id);
	});

	it("saves the position as usual when the twin is on the same page as the drop", async () => {
		const item = await addItem();
		const id = await syncPending(item);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			syncItem(
				opts,
				item,
				plaidFetch((body) =>
					body.cursor === "page-1"
						? response({}, 500)
						: response(
								page({
									added: [postedTx()],
									removed: [{ transaction_id: "pending-1" }],
									next_cursor: "page-1",
									has_more: true,
								}),
							),
				),
			),
		).rejects.toThrow();
		expect((await row("posted-1"))?.id).toBe(id);
		expect(
			(await env.DB.prepare("SELECT sync_cursor FROM plaid_items").first())
				?.sync_cursor,
		).toBe("page-1");
	});

	it("removes a dropped pending one at the end when no twin follows", async () => {
		const item = await addItem();
		await syncPending(item);
		await syncItem(
			opts,
			item,
			twoPages(() => response(page({ next_cursor: "page-2" }))),
		);
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(0);
	});

	it("removes a posted transaction the bank drops at once, without waiting", async () => {
		const item = await addItem();
		await syncItem(
			opts,
			item,
			onePage({
				added: [postedTx({ pending_transaction_id: null })],
			}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			syncItem(
				opts,
				item,
				plaidFetch((body) =>
					body.cursor === "page-1"
						? response({}, 500)
						: response(
								page({
									removed: [{ transaction_id: "posted-1" }],
									next_cursor: "page-1",
									has_more: true,
								}),
							),
				),
			),
		).rejects.toThrow();
		// Page one was saved with its drop, and the saved position moved past it.
		expect(await row("posted-1")).toBeNull();
		expect(
			(await env.DB.prepare("SELECT sync_cursor FROM plaid_items").first())
				?.sync_cursor,
		).toBe("page-1");
	});
});
