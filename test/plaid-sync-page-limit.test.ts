import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSplit } from "../src/db/transactions";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Issue #418: what one Plaid sync page writes, and how many D1 statements its batch holds. Sources, read 2026-10-13:
// Plaid's /transactions/sync `count` is "The number of transaction updates to fetch" (default 100, max 500;
// plaid.com/docs/api/products/transactions), and sync.ts pins it at 100. D1 allows 100 bound parameters per query, so
// a page's lookups read one JSON array through json_each, never one `?` per row. A batch is one request, and the
// 30-second duration limit "also applies to the entire batch call" (developers.cloudflare.com/d1/platform/limits,
// last updated Apr 21, 2026). The D1 page does not say whether a batch's statements count one by one toward its
// 1,000 queries per Worker invocation (Workers Paid), so this file counts a page's batch statement by statement, the
// conservative reading. Read that way, a 100-row page of pending merges is about 4,100 statements in one batch, over
// 1,000. Whether such a batch finishes within 30 seconds is not measured here; it is the follow-up on the deployed demo.
// The local test database enforces neither limit. The counting proxy below enforces the bound values, and a passing
// run is not evidence that production accepts a page.

const ROWS = 100;
const KEY = btoa("01234567890123456789012345678901");
/** D1 binds at most this many values to one statement (developers.cloudflare.com/d1/platform/limits, read 2026-10-13). */
const D1_BOUND_VALUES = 100;
/**
 * The statements a page's batch holds beyond its rows: the lock renewal, the cursor, and the merchant names and
 * suggestions. Measured at 4 to 6 on this branch, so 10 leaves room without letting a new per-row statement through.
 */
const PAGE_STATEMENTS = 10;

const ACCOUNT = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 10 },
};

const transaction = (overrides: Record<string, unknown> = {}) => ({
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name: "SHOP",
	merchant_name: null,
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
	...overrides,
});

const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
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

/**
 * The database, and the statements of each batch the sync sent. A statement that binds more than D1_BOUND_VALUES
 * values throws, as D1 does.
 */
function counting(db: D1Database) {
	const batches: number[] = [];
	const counted = new Proxy(db, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					const bind = statement.bind.bind(statement);
					Object.defineProperty(statement, "bind", {
						value: (...values: unknown[]) => {
							if (values.length > D1_BOUND_VALUES) {
								throw new Error("too many SQL variables");
							}
							return bind(...values);
						},
					});
					return statement;
				};
			}
			if (property === "batch") {
				return (list: D1PreparedStatement[]) => {
					batches.push(list.length);
					return target.batch(list);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: counted as D1Database, batches: () => batches };
}

type Page = {
	added?: unknown[];
	modified?: unknown[];
	removed?: string[];
	hasMore?: boolean;
};

/** Plaid as the pages describe it, in order, on the one account. */
function plaid(pages: Page[]) {
	let served = 0;
	return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
		if (String(url).endsWith("/accounts/get")) {
			return response({ accounts: [ACCOUNT] });
		}
		const page = pages[served++] ?? {};
		return response({
			added: page.added ?? [],
			modified: page.modified ?? [],
			removed: (page.removed ?? []).map((transaction_id) => ({
				transaction_id,
			})),
			next_cursor: crypto.randomUUID(),
			has_more: page.hasMore ?? false,
		});
	});
}

/** A sync over these pages, in order, on the one account. Returns what the sync returned. */
async function syncPages(
	id: number,
	pages: Page[],
	db: D1Database = env.DB,
	options: { runAfterSync?: boolean } = {},
) {
	return syncItem(
		{ ...env, DB: db, TOKEN_ENCRYPTION_KEY: KEY },
		id,
		plaid(pages),
		options,
	);
}

async function resetTables() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM ai_log"),
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare("DELETE FROM bills"),
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
}

const plain = (i: number) =>
	transaction({ transaction_id: `a${i}`, name: `SHOP ${i}` });

/** A posted charge that replaces the pending charge `p${i}`, as the bank posts it. */
const posted = (i: number) =>
	transaction({
		transaction_id: `q${i}`,
		name: `SHOP ${i}`,
		pending_transaction_id: `p${i}`,
	});

/** Seeds the pending charges `p0` to `p${rows - 1}`, as a sync stored them before the bank posted them. */
async function seedPending(rows: number) {
	await env.DB.batch(
		Array.from({ length: rows }, (_, i) =>
			env.DB.prepare(
				"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, pending) SELECT ?, id, '2026-09-26', 650, ?, 1 FROM accounts WHERE plaid_account_id = 'account-1'",
			).bind(`p${i}`, `SHOP ${i}`),
		),
	);
}

/** Seeds the posted charge `q${i}` that a pending charge `p${i}` was never linked to, as a late link leaves it. */
async function seedPosted(rows: number) {
	await env.DB.batch(
		Array.from({ length: rows }, (_, i) =>
			env.DB.prepare(
				"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, pending) SELECT ?, id, '2026-09-27', 650, ?, 0 FROM accounts WHERE plaid_account_id = 'account-1'",
			).bind(`q${i}`, `SHOP ${i}`),
		),
	);
}

/**
 * Seeds a $6.50 charge split by a person into a $4.00 part that paid a bill and a $2.50 part, with a $2.00 refund
 * of the paid part, the way a bank change finds a split purchase. `pending` makes it a pending charge.
 */
async function seedSplit(plaidId: string, pending: boolean) {
	const parent = await env.DB.prepare(
		"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, pending) SELECT ?, id, '2026-09-26', 650, ?, ? FROM accounts WHERE plaid_account_id = 'account-1' RETURNING id",
	)
		.bind(plaidId, `SHOP ${plaidId}`, pending ? 1 : 0)
		.first<{ id: number }>();
	const parentId = parent?.id as number;
	await saveSplit(
		env.DB,
		parentId,
		[
			{ categoryId: 4, amountCents: 400 },
			{ categoryId: 1, amountCents: 250 },
		],
		"person@example.com",
	);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (?, 'Membership', 400, 15, 'yearly', 9, NULL, ?, 1)",
		).bind(parentId, `SHOP ${plaidId}`),
		env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT ?, '2026', id, 'auto', 'linked' FROM transactions WHERE parent_id = ? AND amount_cents = 400",
		).bind(parentId, parentId),
		env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, refund_of_id, credit_reviewed) SELECT account_id, '2026-09-27', -200, 'Refund', id, 1 FROM transactions WHERE parent_id = ? AND amount_cents = 400",
		).bind(parentId),
	]);
}

async function pendingCount() {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM transactions WHERE pending = 1",
	).first<{ n: number }>();
	return row?.n;
}

describe("a page with more rows than D1 binds values to one statement (issue #418)", () => {
	beforeEach(resetTables);

	it("saves a page of 150 added rows, with no statement binding more than 100 values", async () => {
		const id = await addItem();
		await syncPages(id, [{}]);
		const counted = counting(env.DB);
		await syncPages(
			id,
			[{ added: Array.from({ length: 150 }, (_, i) => plain(i)) }],
			counted.db,
		);
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions",
		).first<{ n: number }>();
		expect(row?.n).toBe(150);
	});

	it("waits for and then deletes 150 pending rows the bank dropped on a page that has more to come", async () => {
		const id = await addItem();
		await syncPages(id, [{}]);
		await seedPending(150);
		const dropped = Array.from({ length: 150 }, (_, i) => `p${i}`);
		const counted = counting(env.DB);
		await syncPages(id, [{ removed: dropped, hasMore: true }, {}], counted.db);
		expect(await pendingCount()).toBe(0);
	});

	it("asks Plaid for 100 updates a page, so a page is one D1 batch", async () => {
		const id = await addItem();
		const fetchImpl = plaid([{}]);
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
		const sync = fetchImpl.mock.calls.find(([url]) =>
			String(url).endsWith("/transactions/sync"),
		);
		expect(JSON.parse(String(sync?.[1]?.body)).count).toBe(100);
	});
});

describe("the statements of one 100-row page's batch, by shape (issue #418)", () => {
	beforeEach(resetTables);

	const plainRows = () => Array.from({ length: ROWS }, (_, i) => plain(i));
	const postedRows = () => Array.from({ length: ROWS }, (_, i) => posted(i));
	const modifiedRows = () =>
		Array.from({ length: ROWS }, (_, i) =>
			transaction({ transaction_id: `a${i}`, name: `SHOP ${i}`, amount: 7 }),
		);
	const removedRows = () => Array.from({ length: ROWS }, (_, i) => `a${i}`);

	// Measured on this branch with runAfterSync off, so the batch is the page's own: per row, 9 for an added row,
	// 9 modified, 1 removed (a removed split costs the same as a removed row), 10 pending rekey, 42 pending merge,
	// 9 split removal, 42 merge onto a split. A ceiling is its per-row cost times 100 plus PAGE_STATEMENTS. The 42nd
	// statement of a merge is the planned expense that follows its payment to the posted row (#202, spec §5).

	it.each([
		{
			shape: "added",
			perRow: 9,
			seed: async () => {},
			page: (): Page => ({ added: plainRows() }),
		},
		{
			shape: "modified",
			perRow: 9,
			seed: async (id: number) => {
				await syncPages(id, [{ added: plainRows() }]);
			},
			page: (): Page => ({ modified: modifiedRows() }),
		},
		{
			shape: "removed",
			perRow: 1,
			seed: async (id: number) => {
				await syncPages(id, [{ added: plainRows() }]);
			},
			page: (): Page => ({ removed: removedRows() }),
		},
		{
			shape: "removed split",
			perRow: 1,
			seed: async () => {
				for (let i = 0; i < ROWS; i++) await seedSplit(`a${i}`, false);
			},
			page: (): Page => ({ removed: removedRows() }),
		},
		{
			shape: "pending rekey",
			perRow: 10,
			seed: async () => seedPending(ROWS),
			page: (): Page => ({ added: postedRows() }),
		},
		{
			shape: "pending merge",
			perRow: 42,
			seed: async () => {
				await seedPending(ROWS);
				await seedPosted(ROWS);
			},
			page: (): Page => ({ added: postedRows() }),
		},
		{
			shape: "split removal",
			perRow: 9,
			seed: async () => {
				for (let i = 0; i < ROWS; i++) await seedSplit(`a${i}`, false);
			},
			page: (): Page => ({ modified: modifiedRows() }),
		},
		{
			shape: "merge onto split",
			perRow: 42,
			seed: async () => {
				for (let i = 0; i < ROWS; i++) await seedSplit(`p${i}`, true);
				await seedPosted(ROWS);
			},
			page: (): Page => ({ added: postedRows() }),
		},
	])(
		"a page of $shape rows is one batch of at most $perRow statements a row, plus the page's own",
		async ({ perRow, seed, page }) => {
			const id = await addItem();
			await syncPages(id, [{}]);
			await seed(id);
			const counted = counting(env.DB);
			await syncPages(id, [page()], counted.db, { runAfterSync: false });
			expect(counted.batches()).toHaveLength(1);
			expect(counted.batches()[0]).toBeLessThanOrEqual(
				perRow * ROWS + PAGE_STATEMENTS,
			);
		},
	);
});
