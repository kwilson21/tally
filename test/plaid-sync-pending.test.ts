import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { pendingForJev } from "../src/db/transactions";
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
		expect(summary).toMatchObject({ added: 2, modified: 0, removed: 0 });
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
		expect(await post(item, { amount: -42 })).toMatchObject({
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
		).toMatchObject({ added: 1, modified: 0, removed: 0 });
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
		expect(await post(item)).toMatchObject({
			added: 0,
			modified: 0,
			removed: 1,
		});
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
		expect(await row("posted-1")).toMatchObject({
			id,
			category_id: 4,
			note: "Kept",
		});
	});

	it("leaves one row when both ids are already stored, never colliding on the unique id", async () => {
		const item = await addItem();
		await syncPending(item);
		await syncItem(
			opts,
			item,
			onePage({ added: [postedTx({ pending_transaction_id: null })] }),
		);
		// Both rows exist, so the pending one can't take the posted id; it is merged into it instead (below).
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
		).toMatchObject({ added: 0, modified: 0, removed: 1 });

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

describe("when the posted transaction is already stored as the link arrives", () => {
	/** The bank first sent the posted one with no link to the pending one, and sends the link now. */
	async function bothStored(item: number, pending = {}) {
		const id = await syncPending(item, pending);
		await syncItem(
			opts,
			item,
			onePage({
				added: [postedTx({ pending_transaction_id: null, ...pending })],
			}),
		);
		return { pending: id, posted: (await row("posted-1"))?.id as number };
	}

	const refundOf = async (id: number) =>
		(
			await env.DB.prepare("SELECT refund_of_id FROM transactions WHERE id = ?")
				.bind(id)
				.first()
		)?.refund_of_id;

	it("moves a person's category, note, exclusion and income choice onto it, over a machine's", async () => {
		const item = await addItem();
		const ids = await bothStored(item, { amount: -42 });
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE transactions SET category_id = 3, category_source = 'user', note = 'Birthday money',
					excluded = 1, excluded_source = 'user', flag_income = 1, income_source = 'user',
					credit_reviewed = 1, credit_reviewed_by = 'user', updated_by = 'person@example.com'
				 WHERE id = ?`,
			).bind(ids.pending),
			env.DB.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'jev', category_confidence = 0.9, jev_category_id = 2 WHERE id = ?",
			).bind(ids.posted),
		]);

		expect(await post(item, { amount: -42 })).toMatchObject({
			added: 0,
			modified: 0,
			removed: 1,
		});

		expect(await row("pending-1")).toBeNull();
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
		expect(await row("posted-1")).toMatchObject({
			id: ids.posted,
			pending: 0,
			category_id: 3,
			category_source: "user",
			category_confidence: null,
			note: "Birthday money",
			excluded: 1,
			excluded_source: "user",
			flag_income: 1,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			updated_by: "person@example.com",
		});
	});

	describe("Tally's own answer", () => {
		/** What Tally's answer (decisions 27 and 79) leaves on a row. */
		const answerOf = (plaidId: string) =>
			env.DB.prepare(
				`SELECT category_id, category_source, category_confidence, jev_category_id,
					flag_transfer, flag_reimbursement, flag_income, income_source,
					excluded, excluded_source, credit_reviewed, credit_reviewed_by
				 FROM transactions WHERE plaid_transaction_id = ?`,
			)
				.bind(plaidId)
				.first();

		it("moves a category Jev picked from the pending row onto the posted one", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'jev', category_confidence = 0.93, jev_category_id = 2 WHERE id = ?",
			)
				.bind(ids.pending)
				.run();
			await post(item);
			expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: 2,
				category_source: "jev",
				category_confidence: 0.93,
				jev_category_id: 2,
			});
		});

		it("moves an answer Jev wasn't sure of, so the posted row isn't asked again", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.prepare(
				"UPDATE transactions SET category_confidence = 0.4, jev_category_id = 3 WHERE id = ?",
			)
				.bind(ids.pending)
				.run();
			await post(item);
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: null,
				category_source: null,
				category_confidence: 0.4,
				jev_category_id: 3,
			});
			expect(await pendingForJev(env.DB, 10)).toEqual([]);
		});

		it("moves Jev's transfer and income answers with the exclusion and review they made", async () => {
			const item = await addItem();
			const ids = await bothStored(item, { amount: -42 });
			await env.DB.prepare(
				`UPDATE transactions SET category_confidence = 0.9, jev_category_id = 4,
					flag_transfer = 1, excluded = 1, excluded_source = 'jev',
					flag_income = 1, income_source = 'jev', credit_reviewed = 1
				 WHERE id = ?`,
			)
				.bind(ids.pending)
				.run();
			await post(item, { amount: -42 });
			expect(await answerOf("posted-1")).toMatchObject({
				category_confidence: 0.9,
				jev_category_id: 4,
				flag_transfer: 1,
				excluded: 1,
				excluded_source: "jev",
				flag_income: 1,
				income_source: "jev",
				credit_reviewed: 1,
				credit_reviewed_by: null,
			});
		});

		it("leaves an answer the posted row already has, from Jev or a rule or a person", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET category_id = 2, category_source = 'jev', category_confidence = 0.93, jev_category_id = 2 WHERE id = ?",
				).bind(ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET category_id = 4, category_source = 'merchant_rule' WHERE id = ?",
				).bind(ids.posted),
			]);
			await post(item);
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: 4,
				category_source: "merchant_rule",
				category_confidence: null,
			});
		});

		it("gives a person's own pick on the pending row precedence over Tally's, which doesn't move with it", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET category_id = 3, category_source = 'user', category_confidence = NULL, jev_category_id = 2 WHERE id = ?",
				).bind(ids.pending),
			]);
			await post(item);
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: 3,
				category_source: "user",
				category_confidence: null,
			});
		});

		it("doesn't move an answer made for a different amount, so the posted row is asked again", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.prepare(
				"UPDATE transactions SET category_id = 2, category_source = 'jev', category_confidence = 0.93, jev_category_id = 2 WHERE id = ?",
			)
				.bind(ids.pending)
				.run();
			await post(item, { amount: 20 });
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: null,
				category_source: null,
				category_confidence: null,
				jev_category_id: null,
			});
			expect(await pendingForJev(env.DB, 10)).toHaveLength(1);
		});

		it("doesn't move a merchant rule's pick, which the rule applies to the posted row itself", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			await env.DB.prepare(
				"UPDATE transactions SET category_id = 4, category_source = 'merchant_rule' WHERE id = ?",
			)
				.bind(ids.pending)
				.run();
			await post(item);
			expect(await answerOf("posted-1")).toMatchObject({
				category_id: null,
				category_source: null,
			});
		});
	});

	it("keeps what a person already chose on the posted transaction", async () => {
		const item = await addItem();
		const ids = await bothStored(item, { amount: -42 });
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE transactions SET category_id = 3, category_source = 'user', note = 'From pending',
					excluded = 1, excluded_source = 'user', flag_income = 1, income_source = 'user',
					credit_reviewed = 1, credit_reviewed_by = 'user'
				 WHERE id = ?`,
			).bind(ids.pending),
			env.DB.prepare(
				`UPDATE transactions SET category_id = 4, category_source = 'user', note = 'From posted',
					excluded = 0, excluded_source = 'user', flag_income = 0, income_source = 'user',
					credit_reviewed = 0, credit_reviewed_by = 'user'
				 WHERE id = ?`,
			).bind(ids.posted),
		]);
		await post(item, { amount: -42 });
		expect(await row("posted-1")).toMatchObject({
			category_id: 4,
			note: "From posted",
			excluded: 0,
			flag_income: 0,
			credit_reviewed: 0,
		});
		expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);
	});

	it("moves a bill payment onto it", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		await addBillLinkedTo(ids.pending);
		await post(item);
		expect(
			(
				await env.DB.prepare(
					"SELECT bill_id, period, transaction_id, matched_by, status FROM bill_payments",
				).all()
			).results,
		).toEqual([
			{
				bill_id: 700,
				period: "2026-09",
				transaction_id: ids.posted,
				matched_by: "user",
				status: "linked",
			},
		]);
	});

	it("counts a card payment Plaid excluded in Spent once the pending one's bill link moves onto it", async () => {
		const item = await addItem();
		const loan = { personal_finance_category: { primary: "LOAN_PAYMENTS" } };
		const ids = await bothStored(item, loan);
		await addBillLinkedTo(ids.pending);
		const spent = async () =>
			summarizeMonth({
				month: "2026-09",
				...(await loadMonth(env.DB, "2026-09")),
				unpaidDueBillsCents: 0,
			}).totalSpentCents;
		await post(item, loan);

		// The bill is paid by the posted row, which Plaid excluded as a card payment; the link counts it,
		// so the bill's payment is in Spent once, and the exclusion is as Plaid made it.
		expect(await row("posted-1")).toMatchObject({
			id: ids.posted,
			excluded: 1,
			excluded_source: "plaid",
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT transaction_id, status FROM bill_payments",
				).all()
			).results,
		).toEqual([{ transaction_id: ids.posted, status: "linked" }]);
		expect(await spent()).toBe(1234);
	});

	it("leaves a bill payment the posted one already has, and drops the pending one's", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		await addBillLinkedTo(ids.pending);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (701, 'Water', 1234, 28, 'monthly', 'Not a match either')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (701, '2026-09', ?, 'auto', 'linked')",
			).bind(ids.posted),
		]);
		await post(item);
		expect(
			(
				await env.DB.prepare(
					"SELECT bill_id, transaction_id FROM bill_payments ORDER BY bill_id",
				).all()
			).results,
		).toEqual([{ bill_id: 701, transaction_id: ids.posted }]);
	});

	it("moves refund links both ways", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		const refund = await addRefund(ids.pending);
		await syncItem(
			opts,
			item,
			onePage({
				added: [
					postedTx({
						transaction_id: "purchase",
						pending_transaction_id: null,
						amount: 50,
					}),
				],
			}),
		);
		const purchase = (await row("purchase"))?.id as number;
		await env.DB.prepare(
			"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
		)
			.bind(purchase, ids.pending)
			.run();

		await post(item);

		// The refund of the pending purchase now refunds the posted one.
		expect(await refundOf(refund)).toBe(ids.posted);
		// The pending credit's own link is now the posted credit's.
		expect(await refundOf(ids.posted)).toBe(purchase);
		expect(await row("pending-1")).toBeNull();
	});

	it("keeps a refund link the posted one already has", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		await syncItem(
			opts,
			item,
			onePage({
				added: [
					postedTx({
						transaction_id: "purchase-a",
						pending_transaction_id: null,
						amount: 50,
					}),
					postedTx({
						transaction_id: "purchase-b",
						pending_transaction_id: null,
						amount: 60,
					}),
				],
			}),
		);
		const a = (await row("purchase-a"))?.id as number;
		const b = (await row("purchase-b"))?.id as number;
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			).bind(a, ids.pending),
			env.DB.prepare(
				"UPDATE transactions SET refund_of_id = ? WHERE id = ?",
			).bind(b, ids.posted),
		]);
		await post(item);
		expect(await refundOf(ids.posted)).toBe(b);
	});

	it("moves a split when the amount is unchanged, with its parts following the posted date", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		const parts = await splitInto(ids.pending, 600, 634);
		await post(item);
		expect(await row("posted-1")).toMatchObject({
			id: ids.posted,
			is_split: 1,
			split_removed_from_cents: null,
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT id, parent_id, amount_cents, date FROM transactions WHERE parent_id IS NOT NULL ORDER BY id",
				).all()
			).results,
		).toEqual([
			{
				id: parts[0],
				parent_id: ids.posted,
				amount_cents: 600,
				date: "2026-09-28",
			},
			{
				id: parts[1],
				parent_id: ids.posted,
				amount_cents: 634,
				date: "2026-09-28",
			},
		]);
	});

	it("removes the split when the amount changed, with a note, and unlinks a refund of a part (decision 62)", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		const parts = await splitInto(ids.pending, 600, 634);
		const refundOfPart = await addRefund(parts[0] as number, -100);

		await post(item, { amount: 15 });

		expect(await row("posted-1")).toMatchObject({
			id: ids.posted,
			amount_cents: 1500,
			is_split: 0,
			split_removed_from_cents: 1234,
		});
		expect(
			await count(
				"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NOT NULL",
			),
		).toBe(0);
		expect(await refundOf(refundOfPart)).toBeNull();
	});

	describe("a moved split's parts follow the posted row, except for a choice made on the part", () => {
		/** September's counted spending, which counts a split through its parts and skips the parent. */
		const spent = async () =>
			summarizeMonth({
				month: "2026-09",
				...(await loadMonth(env.DB, "2026-09")),
				unpaidDueBillsCents: 0,
			}).totalSpentCents;

		/** A split pending purchase a person excluded: the parts carry the exclusion, as saving an edit does. */
		async function excludedPendingSplit(item: number) {
			const ids = await bothStored(item);
			const parts = await splitInto(ids.pending, 600, 634);
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ? OR parent_id = ?",
				).bind(ids.pending, ids.pending),
			]);
			return { ...ids, parts };
		}

		it("counts the charge when a person included the posted row after excluding the pending one", async () => {
			const item = await addItem();
			const ids = await excludedPendingSplit(item);
			await env.DB.prepare(
				"UPDATE transactions SET excluded = 0, excluded_source = 'user' WHERE id = ?",
			)
				.bind(ids.posted)
				.run();
			expect(await spent()).toBe(1234);

			await post(item);

			const { results } = await env.DB.prepare(
				"SELECT id, parent_id, excluded, excluded_source FROM transactions WHERE parent_id IS NOT NULL ORDER BY id",
			).all();
			expect(results).toEqual(
				ids.parts.map((id) => ({
					id,
					parent_id: ids.posted,
					excluded: 0,
					excluded_source: "user",
				})),
			);
			expect(await row("posted-1")).toMatchObject({ excluded: 0, is_split: 1 });
			// The charge still counts, once, through its parts.
			expect(await spent()).toBe(1234);
		});

		it("leaves the whole charge out when the person's exclusion moves onto the posted row", async () => {
			const item = await addItem();
			const ids = await excludedPendingSplit(item);
			await post(item);
			expect(await row("posted-1")).toMatchObject({
				excluded: 1,
				excluded_source: "user",
			});
			expect(
				await count(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id IS NOT NULL AND excluded = 1 AND excluded_source = 'user'",
				),
			).toBe(2);
			expect(await spent()).toBe(0);
			expect(ids.parts).toHaveLength(2);
		});

		const partState = async (id: number) =>
			env.DB.prepare(
				"SELECT excluded, excluded_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first();

		it("keeps a part's own exclusion, while the parts that only inherited one follow the posted row", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			const parts = await splitInto(ids.pending, 600, 634);
			// The parts inherited the pending purchase's exclusion state (included); a person then
			// excluded the second part on its own. The person also included the posted row.
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET excluded = 0, excluded_source = NULL WHERE id = ? OR parent_id = ?",
				).bind(ids.pending, ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
				).bind(parts[1]),
				env.DB.prepare(
					"UPDATE transactions SET excluded = 0, excluded_source = 'user' WHERE id = ?",
				).bind(ids.posted),
			]);

			await post(item);

			expect(await partState(parts[0] as number)).toMatchObject({
				excluded: 0,
				excluded_source: "user",
			});
			expect(await partState(parts[1] as number)).toMatchObject({
				excluded: 1,
				excluded_source: "user",
			});
			// Only the first part still counts.
			expect(await spent()).toBe(600);
		});

		it("keeps a part a person reviewed as a refund, while the other part follows the posted row", async () => {
			const item = await addItem();
			const ids = await bothStored(item, { amount: -42 });
			const parts = await splitInto(ids.pending, -2000, -2200);
			// Both parts inherited the pending credit's state (not reviewed); a person then reviewed the
			// first on its own. The posted row is not reviewed.
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ? OR parent_id = ?",
				).bind(ids.pending, ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
				).bind(parts[0]),
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
				).bind(ids.posted),
			]);
			expect(await spent()).toBe(-2000);

			await post(item, { amount: -42 });

			expect(await partState(parts[0] as number)).toMatchObject({
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
			expect(await partState(parts[1] as number)).toMatchObject({
				credit_reviewed: 0,
				credit_reviewed_by: null,
			});
			// The reviewed part still counts; the other credit stays held out until someone reviews it.
			expect(await spent()).toBe(-2000);
		});

		it("follows the posted row when the credit was reviewed after it was split, which leaves the parts as they were", async () => {
			const item = await addItem();
			const ids = await bothStored(item, { amount: -42 });
			const parts = await splitInto(ids.pending, -2000, -2200);
			// Saving the edit panel on a split credit reviews the parent and not its parts, so the parts
			// still hold what they inherited when they were made (not reviewed, nobody's choice).
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 0, credit_reviewed_by = NULL WHERE parent_id = ?",
				).bind(ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
				).bind(ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET credit_reviewed = 0, credit_reviewed_by = NULL WHERE id = ?",
				).bind(ids.posted),
			]);

			await post(item, { amount: -42 });

			// The review moved onto the posted row, and the parts follow it, so both count.
			expect(await row("posted-1")).toMatchObject({
				credit_reviewed: 1,
				credit_reviewed_by: "user",
			});
			for (const id of parts) {
				expect(await partState(id)).toMatchObject({
					credit_reviewed: 1,
					credit_reviewed_by: "user",
				});
			}
			expect(await spent()).toBe(-4200);
		});

		it("follows the posted row for a difference nobody chose on the part", async () => {
			const item = await addItem();
			const ids = await bothStored(item);
			const parts = await splitInto(ids.pending, 600, 634);
			// A part that differs from the pending purchase only by a machine's flag isn't a person's choice.
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE transactions SET excluded = 0, excluded_source = NULL WHERE id = ? OR parent_id = ?",
				).bind(ids.pending, ids.pending),
				env.DB.prepare(
					"UPDATE transactions SET excluded = 1, excluded_source = 'jev' WHERE id = ?",
				).bind(parts[0]),
				env.DB.prepare(
					"UPDATE transactions SET excluded = 0, excluded_source = 'user' WHERE id = ?",
				).bind(ids.posted),
			]);

			await post(item);

			expect(await partState(parts[0] as number)).toMatchObject({
				excluded: 0,
				excluded_source: "user",
			});
			expect(await spent()).toBe(1234);
		});
	});

	it("keeps a split the posted transaction already has, and drops the pending one's", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		const own = await splitInto(ids.posted, 700, 534);
		await splitInto(ids.pending, 600, 634);
		await post(item);
		expect(
			(
				await env.DB.prepare(
					"SELECT id, parent_id FROM transactions WHERE parent_id IS NOT NULL ORDER BY id",
				).all()
			).results,
		).toEqual(own.map((id) => ({ id, parent_id: ids.posted })));
		expect(await row("posted-1")).toMatchObject({ is_split: 1 });
	});

	it("does the same when the drop came on an earlier page than the link", async () => {
		const item = await addItem();
		const ids = await bothStored(item);
		await env.DB.prepare(
			"UPDATE transactions SET category_id = 3, category_source = 'user', note = 'Kept' WHERE id = ?",
		)
			.bind(ids.pending)
			.run();
		await addBillLinkedTo(ids.pending);

		await syncItem(
			opts,
			item,
			plaidFetch((body) =>
				body.cursor === "page-1"
					? response(page({ added: [postedTx()], next_cursor: "page-2" }))
					: response(
							page({
								removed: [{ transaction_id: "pending-1" }],
								next_cursor: "page-1",
								has_more: true,
							}),
						),
			),
		);

		expect(await row("pending-1")).toBeNull();
		expect(await row("posted-1")).toMatchObject({
			id: ids.posted,
			category_id: 3,
			note: "Kept",
		});
		expect(
			(await env.DB.prepare("SELECT transaction_id FROM bill_payments").first())
				?.transaction_id,
		).toBe(ids.posted);
	});
});

// Spec §8.5: Plaid's transfer categories exclude a transaction at sync, and a pending transaction's
// attachments move onto its posted twin. The two must not undo each other in either order the bank can
// send them: the link with the posted row, or the posted row first and the link after.
describe("Plaid's transfer exclusion and a pending transaction's posting", () => {
	const TRANSFER = { personal_finance_category: { primary: "TRANSFER_OUT" } };
	const TRANSFER_IN = { personal_finance_category: { primary: "TRANSFER_IN" } };
	const SHOP = {
		personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
	};

	const spent = async () =>
		summarizeMonth({
			month: "2026-09",
			...(await loadMonth(env.DB, "2026-09")),
			unpaidDueBillsCents: 0,
		}).totalSpentCents;

	/** The bank sends the posted row first, without its link; the pending row is already stored. */
	async function postedFirst(item: number, pending = SHOP, posted = TRANSFER) {
		const id = await syncPending(item, pending);
		await syncItem(
			opts,
			item,
			onePage({
				added: [postedTx({ pending_transaction_id: null, ...posted })],
			}),
		);
		return id;
	}

	/** Tally's transfer or reimbursement answer, which excluded the pending row (Jev only asks about counted ones). */
	const jevExcluded = (id: number, flag: string) =>
		env.DB.prepare(
			`UPDATE transactions SET ${flag} = 1, excluded = 1, excluded_source = 'jev',
				category_confidence = 0.9, jev_category_id = 4
			 WHERE id = ?`,
		)
			.bind(id)
			.run();

	/** Plaid stops calling the posted row a transfer. */
	const notATransferAnymore = (item: number) =>
		syncItem(
			opts,
			item,
			onePage({
				modified: [postedTx({ pending_transaction_id: null, ...SHOP })],
				next_cursor: "cursor-3",
			}),
		);

	it.each(["flag_transfer", "flag_reimbursement"])(
		"keeps Tally's %s answer from the pending row when Plaid already excluded the posted one",
		async (flag) => {
			const item = await addItem();
			const pending = await postedFirst(item);
			await jevExcluded(pending, flag);
			expect(await row("posted-1")).toMatchObject({
				excluded: 1,
				excluded_source: "plaid",
			});

			await post(item, TRANSFER);

			// Tally's own answer moves with the rest, and keeps the source over Plaid's (§8.5), as it does
			// when the bank sends the link with the posted row.
			expect(await row("posted-1")).toMatchObject({
				excluded: 1,
				excluded_source: "jev",
				[flag]: 1,
			});
			expect(await count("SELECT COUNT(*) AS n FROM transactions")).toBe(1);

			// So when Plaid stops calling it a transfer, Tally's answer still keeps it out of Spent.
			await notATransferAnymore(item);
			expect(await row("posted-1")).toMatchObject({
				excluded: 1,
				excluded_source: "jev",
			});
			expect(await spent()).toBe(0);
		},
	);

	it("gives a split's parts Tally's answer too, when the pending row was split and Plaid excluded the posted one", async () => {
		const item = await addItem();
		const pending = await postedFirst(item);
		await splitInto(pending, 1000, 234);
		await jevExcluded(pending, "flag_transfer");
		await env.DB.prepare(
			"UPDATE transactions SET excluded = 1, excluded_source = 'jev' WHERE parent_id = ?",
		)
			.bind(pending)
			.run();

		await post(item, TRANSFER);

		expect(await row("posted-1")).toMatchObject({
			is_split: 1,
			excluded: 1,
			excluded_source: "jev",
		});
		await notATransferAnymore(item);
		const parts = await env.DB.prepare(
			"SELECT excluded, excluded_source FROM transactions WHERE parent_id IS NOT NULL",
		).all();
		expect(parts.results).toEqual([
			{ excluded: 1, excluded_source: "jev" },
			{ excluded: 1, excluded_source: "jev" },
		]);
		expect(await spent()).toBe(0);
	});

	it("keeps Tally's answer when the link comes with the posted row, which is the same row", async () => {
		const item = await addItem();
		const pending = await syncPending(item, SHOP);
		await jevExcluded(pending, "flag_transfer");

		await post(item, TRANSFER);

		expect(await row("posted-1")).toMatchObject({
			id: pending,
			excluded: 1,
			excluded_source: "jev",
			flag_transfer: 1,
		});
		await notATransferAnymore(item);
		expect(await spent()).toBe(0);
	});

	it("leaves a person's include of the pending transfer in place, in both orders", async () => {
		for (const late of [false, true]) {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM transactions"),
				env.DB.prepare("DELETE FROM accounts"),
				env.DB.prepare("DELETE FROM plaid_items"),
			]);
			const item = await addItem();
			const pending = late
				? await postedFirst(item, TRANSFER, TRANSFER)
				: await syncPending(item, TRANSFER);
			expect(await row("pending-1")).toMatchObject({
				excluded: 1,
				excluded_source: "plaid",
			});
			await env.DB.prepare(
				"UPDATE transactions SET excluded = 0, excluded_source = 'user' WHERE id = ?",
			)
				.bind(pending)
				.run();

			await post(item, TRANSFER);

			expect(await row("posted-1")).toMatchObject({
				excluded: 0,
				excluded_source: "user",
			});
			expect(await spent()).toBe(1234);
		}
	});

	it("keeps a credit a person reviewed counted when the posted row is a transfer stored first (decision 70)", async () => {
		const item = await addItem();
		const credit = { ...TRANSFER_IN, amount: -42 };
		const pending = await postedFirst(item, credit as typeof SHOP, credit);
		expect(await row("posted-1")).toMatchObject({
			excluded: 1,
			excluded_source: "plaid",
		});
		await env.DB.prepare(
			"UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
		)
			.bind(pending)
			.run();

		await post(item, credit);

		expect(await row("posted-1")).toMatchObject({
			excluded: 0,
			excluded_source: null,
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
		expect(await spent()).toBe(-4200);
	});

	it("keeps Plaid's exclusion on a posted transfer stored before its pending row, which the bank then drops", async () => {
		const item = await addItem();
		// The posted row comes first, naming a pending one nothing has stored yet.
		await syncItem(opts, item, onePage({ added: [postedTx(TRANSFER)] }));
		expect(await row("posted-1")).toMatchObject({
			excluded: 1,
			excluded_source: "plaid",
		});
		// The pending row turns up after it, as a row of its own, and is then removed.
		await syncItem(
			opts,
			item,
			onePage({ added: [pendingTx(SHOP)], next_cursor: "cursor-2" }),
		);
		await syncItem(
			opts,
			item,
			onePage({
				removed: [{ transaction_id: "pending-1" }],
				next_cursor: "cursor-3",
			}),
		);

		expect(await row("pending-1")).toBeNull();
		expect(await row("posted-1")).toMatchObject({
			excluded: 1,
			excluded_source: "plaid",
		});
		expect(await spent()).toBe(0);
	});
});
