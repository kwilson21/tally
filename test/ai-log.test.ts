import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import {
	AI_TALLY_SQL,
	type AiTallyCounts,
	readAiTally,
} from "../src/db/ai-log";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { settleSuggestion } from "../src/db/merchant-names";
import { removeSplit, saveEdit, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { buildSeed } from "../src/demo/seed";
import { app } from "../src/index";
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { tallyExport } from "../src/settings/export";
import { saveOrganizeGroup } from "../src/transactions/organize";
import { AiTally } from "../src/views/ai-tally";
import { WhyLink } from "../src/views/why-link";

// What AI did this month (spec §8.6, decisions 91 and 101): a small log of what Tally's AI applied,
// with no amounts, counted from the day it ships. The tally under the AI suggestions switches, its Off
// lines, its Why? link, its export and the demo's record of the family's work are tested here.

const db = env.DB;
const TODAY = "2026-10-11";
const BASE = "http://tally.test";
const OFF = { names: true, categories: true, income: true };

const reply = (categoryConfidence: number, incomeConfidence: number) =>
	new Response(
		JSON.stringify({
			answers: {
				category: {
					type: "choice",
					choice: "Eating Out",
					confidence: categoryConfidence,
				},
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: incomeConfidence },
			},
		}),
		{ status: 200 },
	);

/** A fake Jev that answers every call the same way and counts the calls it got. */
function fakeJev(answer: () => Response) {
	const calls = { n: 0 };
	return {
		calls,
		fetchImpl: async () => {
			calls.n += 1;
			return answer();
		},
	};
}

const idsWhere = async (where: string) =>
	(
		await db
			.prepare(`SELECT id FROM transactions WHERE ${where} ORDER BY id`)
			.all<{ id: number }>()
	).results.map((row) => row.id);

const someIds = async (count: number) =>
	(
		await db
			.prepare(
				"SELECT id FROM transactions WHERE parent_id IS NULL ORDER BY id LIMIT ?",
			)
			.bind(count)
			.all<{ id: number }>()
	).results.map((row) => row.id);

const logIds = async (kind: string) =>
	(
		await db
			.prepare(
				"SELECT transaction_id AS id FROM ai_log WHERE kind = ? ORDER BY transaction_id",
			)
			.bind(kind)
			.all<{ id: number }>()
	).results.map((row) => row.id);

const logCategory = (transactionId: number, day: string) =>
	db
		.prepare(
			"INSERT INTO ai_log (kind, transaction_id, household_day) VALUES ('category', ?, ?)",
		)
		.bind(transactionId, day)
		.run();

const logIncome = (transactionId: number, day: string) =>
	db
		.prepare(
			"INSERT INTO ai_log (kind, transaction_id, household_day) VALUES ('income', ?, ?)",
		)
		.bind(transactionId, day)
		.run();

const logName = (merchant: string, day: string) =>
	db
		.prepare(
			"INSERT INTO ai_log (kind, merchant_raw_name, household_day) VALUES ('name', ?, ?)",
		)
		.bind(merchant, day)
		.run();

const logNames = async () =>
	(
		await db
			.prepare(
				"SELECT merchant_raw_name AS name FROM ai_log WHERE kind = 'name' ORDER BY merchant_raw_name",
			)
			.all<{ name: string }>()
	).results.map((row) => row.name);

/** A purchase with no category yet, for a name to be kept on. */
const chargeAt = async (rawName: string) =>
	(
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, updated_by) VALUES (1, ?, 650, ?, 'test') RETURNING id",
			)
			.bind(TODAY, rawName)
			.first<{ id: number }>()
	)?.id as number;

/** The edit panel's values for a save that changes nothing but what a test names (as categorize-db's). */
const personEdit = {
	categoryId: null,
	alwaysForMerchant: false,
	displayName: null,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	creditReviewedProvided: true,
};

/** The tally's lines as the Settings group draws them, all switches on. */
const linesOf = async (tally: AiTallyCounts, switches = OFF) =>
	(await AiTally({ tally, switches }).toString()).replace(/<[^>]+>/g, "|");

beforeEach(async () => {
	await resetDemo(db, TODAY);
	// The demo's reset records its own example work; each test starts from an empty log.
	await db.prepare("DELETE FROM ai_log").run();
	await saveAiSwitches(db, AI_SWITCHES_ALL_ON);
	// The demo's reset keeps the day's Jev count, so each test starts a day of its own.
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the migration", () => {
	it("creates ai_log with what happened and no amounts, and only the three kinds", async () => {
		const { results } = await db
			.prepare("PRAGMA table_info(ai_log)")
			.all<{ name: string }>();
		expect(results.map((column) => column.name)).toEqual([
			"id",
			"kind",
			"transaction_id",
			"merchant_raw_name",
			"household_day",
			"created_at",
		]);
		await expect(
			db
				.prepare(
					"INSERT INTO ai_log (kind, transaction_id, household_day) VALUES ('sorted', 1, ?)",
				)
				.bind(TODAY)
				.run(),
		).rejects.toThrow();
	});
});

describe("the tally's counts", () => {
	it("counts a month from that month's own stored rows only", async () => {
		const [a, b, c, d, e, f] = await someIds(6);
		await logCategory(a as number, "2026-10-02");
		await logCategory(b as number, "2026-10-09");
		await logCategory(c as number, "2026-09-28");
		await logIncome(d as number, "2026-10-03");
		await logName("SQ *BLUE BOTTLE", "2026-09-15");
		// Just outside both months: not counted in either.
		await logCategory(e as number, "2026-08-31");
		await logCategory(f as number, "2026-11-01");
		expect(await readAiTally(db, TODAY)).toEqual({
			month: "2026-10",
			sorted: 2,
			changed: 0,
			named: 0,
			paychecks: 1,
		});
	});

	it("falls back to September from its first day, and not August's last", async () => {
		const [a, b] = await someIds(2);
		await logCategory(a as number, "2026-09-01");
		await logCategory(b as number, "2026-08-31");
		expect(await readAiTally(db, "2026-10-02")).toEqual({
			month: "2026-09",
			sorted: 1,
			changed: 0,
			named: 0,
			paychecks: 0,
		});
	});

	it("reads its two months through the household_day index", async () => {
		const { results } = await db
			.prepare(`EXPLAIN QUERY PLAN ${AI_TALLY_SQL}`)
			.bind("2026-09-01", "2026-11-01")
			.all<{ detail: string }>();
		const plan = results.map((row) => row.detail).join("\n");
		expect(plan).toMatch(/USING (COVERING )?INDEX ai_log_household_day/);
	});

	it("builds the tally without calling Jev or Workers AI", async () => {
		const [a] = await someIds(1);
		await logCategory(a as number, TODAY);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		// The tests' env has no AI binding (wrangler.jsonc), so the page gets a stub that records any ask.
		const ai = { run: vi.fn(async () => ({ response: "Some Place" })) };
		const page = await app.request(
			`${BASE}/settings`,
			{},
			{ ...env, AI: ai as unknown as Ai },
		);
		expect(page.status).toBe(200);
		expect(await readAiTally(db, TODAY)).toMatchObject({ sorted: 1 });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("shows zeros, not an error, for a household with no AI work yet", async () => {
		const tally = await readAiTally(db, TODAY);
		expect(tally).toEqual({
			month: "2026-10",
			sorted: 0,
			changed: 0,
			named: 0,
			paychecks: 0,
		});
		const lines = await linesOf(tally);
		expect(lines).toContain("In October");
		expect(lines).toContain("Sorted 0 transactions · you changed 0");
		expect(lines).toContain("Cleaned 0 merchant names");
		expect(lines).toContain("Found 0 paychecks");
	});

	it("early in a month with no AI work yet, shows last month's lines labelled with its name", async () => {
		const [a, b] = await someIds(2);
		await logCategory(a as number, "2026-09-20");
		await logIncome(b as number, "2026-09-25");
		const tally = await readAiTally(db, "2026-10-02");
		expect(tally).toEqual({
			month: "2026-09",
			sorted: 1,
			changed: 0,
			named: 0,
			paychecks: 1,
		});
		expect(await linesOf(tally)).toContain("In September");
	});

	it("counts 'you changed' for a person's pick or an Always rule, not for a bill's category", async () => {
		const [a, b, c, d] = await someIds(4);
		await db
			.prepare(
				"UPDATE transactions SET category_source = CASE id WHEN ? THEN 'user' WHEN ? THEN 'merchant_rule' WHEN ? THEN 'bill' ELSE 'jev' END WHERE id IN (?, ?, ?, ?)",
			)
			.bind(a, b, c, a, b, c, d)
			.run();
		for (const id of [a, b, c, d]) await logCategory(id as number, TODAY);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 4,
			changed: 2,
		});
	});

	/** The two first active categories, to give a sorted transaction and its split parts. */
	const twoCategories = async () =>
		(
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order LIMIT 2",
				)
				.all<{ id: number }>()
		).results.map((row) => row.id);

	/** A transaction Jev sorted into `categoryId`, logged as Tally's pick; returns its id and amount. */
	const sortedByJev = async (categoryId: number) => {
		const [id] = await someIds(1);
		const amount = (
			await db
				.prepare("SELECT amount_cents AS amount FROM transactions WHERE id = ?")
				.bind(id)
				.first<{ amount: number }>()
		)?.amount as number;
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev' WHERE id = ?",
			)
			.bind(categoryId, id)
			.run();
		await logCategory(id as number, TODAY);
		return { id: id as number, amount };
	};

	it("counts a transaction Tally sorted and a person split, with a part in another category, as changed", async () => {
		const [x, y] = await twoCategories();
		const { id, amount } = await sortedByJev(x as number);
		const half = Math.trunc(amount / 2);
		const split = await saveSplit(
			db,
			id,
			[
				{ categoryId: x as number, amountCents: half },
				{ categoryId: y as number, amountCents: amount - half },
			],
			"test",
		);
		expect(split.saved).toBe(true);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 1,
		});
	});

	it("doesn't count a split whose parts all keep Tally's category", async () => {
		const [x] = await twoCategories();
		const { id, amount } = await sortedByJev(x as number);
		const half = Math.trunc(amount / 2);
		const split = await saveSplit(
			db,
			id,
			[
				{ categoryId: x as number, amountCents: half },
				{ categoryId: x as number, amountCents: amount - half },
			],
			"test",
		);
		expect(split.saved).toBe(true);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	it("stops counting it once the split is removed", async () => {
		const [x, y] = await twoCategories();
		const { id, amount } = await sortedByJev(x as number);
		const half = Math.trunc(amount / 2);
		await saveSplit(
			db,
			id,
			[
				{ categoryId: x as number, amountCents: half },
				{ categoryId: y as number, amountCents: amount - half },
			],
			"test",
		);
		expect(await readAiTally(db, TODAY)).toMatchObject({ changed: 1 });
		await removeSplit(db, id, "test");
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	it("follows a logged answer to the posted row when the bank posts a pending one", async () => {
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, category_id, category_source, category_confidence, jev_category_id, updated_by)
				 VALUES (1, ?, 1200, 'CORNER COFFEE', 'pend-1', 1, 1, 'jev', 0.9, 1, 'test')`,
			)
			.bind(TODAY)
			.run();
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
				 VALUES (1, ?, 1200, 'CORNER COFFEE', 'post-1', 0, 'test')`,
			)
			.bind(TODAY)
			.run();
		const [pending] = await db
			.prepare(
				"SELECT id FROM transactions WHERE plaid_transaction_id = 'pend-1'",
			)
			.all<{ id: number }>()
			.then((r) => r.results);
		const [posted] = await db
			.prepare(
				"SELECT id FROM transactions WHERE plaid_transaction_id = 'post-1'",
			)
			.all<{ id: number }>()
			.then((r) => r.results);
		await logCategory(pending?.id as number, TODAY);
		const item = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = 'lock-1' WHERE id = ?")
			.bind(item?.id)
			.run();
		await db.batch(
			mergePendingIntoPosted(db, item?.id as number, "lock-1", "pend-1", {
				id: "post-1",
				cents: 1200,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			}),
		);
		expect(await logIds("category")).toEqual([posted?.id]);
		// The posted row's category is now a person's: the answer is still counted as changed.
		await db
			.prepare("UPDATE transactions SET category_source = 'user' WHERE id = ?")
			.bind(posted?.id)
			.run();
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 1,
		});
	});

	it("counts a purchase once when Tally sorted both its pending row and its posted row", async () => {
		const insert = (plaidId: string, pending: number) =>
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, category_id, category_source, category_confidence, jev_category_id, updated_by)
					 VALUES (1, ?, 1200, 'CORNER COFFEE', ?, ?, 1, 'jev', 0.9, 1, 'test')`,
				)
				.bind(TODAY, plaidId, pending)
				.run();
		await insert("pend-2", 1);
		await insert("post-2", 0);
		const idOf = async (plaidId: string) =>
			(
				await db
					.prepare("SELECT id FROM transactions WHERE plaid_transaction_id = ?")
					.bind(plaidId)
					.first<{ id: number }>()
			)?.id as number;
		const pendingId = await idOf("pend-2");
		const postedId = await idOf("post-2");
		await logCategory(pendingId, TODAY);
		await logCategory(postedId, TODAY);
		const item = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = 'lock-2' WHERE id = ?")
			.bind(item?.id)
			.run();
		await db.batch(
			mergePendingIntoPosted(db, item?.id as number, "lock-2", "pend-2", {
				id: "post-2",
				cents: 1200,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			}),
		);
		expect(await idsWhere("plaid_transaction_id = 'pend-2'")).toEqual([]);
		expect(await logIds("category")).toEqual([postedId]);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	/**
	 * One purchase the bank stored twice: a pending row (at `cents`) and its posted row (at `postedCents`), each
	 * with its own columns set by SQL, and the pending row's log row (category or income) written before the merge
	 * runs as sync runs it. Returns both ids.
	 */
	const mergedPurchase = async ({
		pending,
		posted,
		cents = 1200,
		postedCents = cents,
		logged,
	}: {
		pending: string;
		posted: string;
		cents?: number;
		postedCents?: number;
		logged: "category" | "income";
	}) => {
		const storeRow = async (
			plaidId: string,
			isPending: number,
			amount: number,
			set: string,
		) => {
			const row = await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, updated_by)
					 VALUES (1, ?, ?, 'CORNER COFFEE', ?, ?, 'test') RETURNING id`,
				)
				.bind(TODAY, amount, plaidId, isPending)
				.first<{ id: number }>();
			if (set)
				await db
					.prepare(`UPDATE transactions SET ${set} WHERE id = ?`)
					.bind(row?.id)
					.run();
			return row?.id as number;
		};
		const pendingId = await storeRow("pend-m", 1, cents, pending);
		const postedId = await storeRow("post-m", 0, postedCents, posted);
		if (logged === "category") await logCategory(pendingId, TODAY);
		else await logIncome(pendingId, TODAY);
		const item = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = 'lock-m' WHERE id = ?")
			.bind(item?.id)
			.run();
		await db.batch(
			mergePendingIntoPosted(db, item?.id as number, "lock-m", "pend-m", {
				id: "post-m",
				cents: postedCents,
				date: TODAY,
				name: "CORNER COFFEE",
				merchantName: null,
				plaidCategory: null,
			}),
		);
		return { pendingId, postedId };
	};

	it("doesn't count a Jev pick as changed when a person had already picked on the posted row", async () => {
		await mergedPurchase({
			pending:
				"category_id = 1, category_source = 'jev', category_confidence = 0.9, jev_category_id = 1",
			posted: "category_id = 1, category_source = 'user'",
			logged: "category",
		});
		expect(await idsWhere("plaid_transaction_id = 'pend-m'")).toEqual([]);
		expect(await logIds("category")).toEqual([null]);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	it("keeps a Jev pick out of the count once the bank changed the amount and a person picks later", async () => {
		await mergedPurchase({
			pending:
				"category_id = 1, category_source = 'jev', category_confidence = 0.9, jev_category_id = 1",
			posted: "",
			postedCents: 1500,
			logged: "category",
		});
		await db
			.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'user' WHERE plaid_transaction_id = 'post-m'",
			)
			.run();
		expect(await logIds("category")).toEqual([null]);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	it("moves a person's pick on the pending row with its log row, so the posted row counts as changed", async () => {
		const { postedId } = await mergedPurchase({
			pending:
				"category_id = 1, category_source = 'user', category_confidence = NULL, jev_category_id = 1",
			posted: "",
			logged: "category",
		});
		expect(await logIds("category")).toEqual([postedId]);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 1,
		});
	});

	it("doesn't move a Jev pick onto a posted row a merchant rule already sorted", async () => {
		await mergedPurchase({
			pending:
				"category_id = 1, category_source = 'jev', category_confidence = 0.9, jev_category_id = 1",
			posted: "category_id = 1, category_source = 'merchant_rule'",
			logged: "category",
		});
		expect(await logIds("category")).toEqual([null]);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
	});

	it("still moves a pending row's income log to the posted row", async () => {
		const { postedId } = await mergedPurchase({
			pending: "flag_income = 1, income_source = 'jev'",
			posted: "",
			cents: -1200,
			logged: "income",
		});
		expect(await logIds("income")).toEqual([postedId]);
	});
});

describe("a deleted transaction's log row", () => {
	/** A purchase inserted last, so it is the newest row: SQLite gives the next insert its id. */
	const insertPurchase = (plaidId: string, accountId: number) =>
		db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, updated_by)
				 VALUES (?, ?, 1200, 'CORNER COFFEE', ?, 'test') RETURNING id`,
			)
			.bind(accountId, TODAY, plaidId)
			.first<{ id: number }>()
			.then((row) => row?.id as number);

	/** A purchase Jev sorts the way a run does: its category is set, then the run logs it. */
	const sortedByJev = async (id: number) => {
		await db
			.prepare(
				"UPDATE transactions SET category_id = 1, category_source = 'jev', category_confidence = 0.9, jev_category_id = 1 WHERE id = ?",
			)
			.bind(id)
			.run();
		await logCategory(id, TODAY);
	};

	it("forgets the id of a pending row the bank drops, so the next purchase that takes it is still logged", async () => {
		const item = await db
			.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
			.first<{ id: number }>();
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = 'lock-drop' WHERE id = ?")
			.bind(item?.id)
			.run();
		const droppedId = await insertPurchase("drop-1", 1);
		await logCategory(droppedId, TODAY);
		// The statement sync.ts runs for a row the bank drops: the delete runs only under the sync's lock.
		await db
			.prepare(
				`DELETE FROM transactions WHERE plaid_transaction_id = ? AND EXISTS (SELECT 1 FROM plaid_items WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL)`,
			)
			.bind("drop-1", item?.id, "lock-drop")
			.run();
		const nextId = await insertPurchase("next-1", 1);
		expect(nextId).toBe(droppedId);
		await sortedByJev(nextId);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 2,
			changed: 0,
		});
		expect(await logIds("category")).toEqual([null, nextId]);
		// A person's change to the new purchase counts; the dropped purchase's row is not read from it.
		await db
			.prepare("UPDATE transactions SET category_source = 'user' WHERE id = ?")
			.bind(nextId)
			.run();
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 2,
			changed: 1,
		});
	});

	it("forgets the ids of a disconnected bank's deleted transactions, so a later purchase is still logged", async () => {
		const itemId = (
			await db
				.prepare(
					"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (X'00', 'Old Bank', 'demo') RETURNING id",
				)
				.first<{ id: number }>()
		)?.id as number;
		const accountId = (
			await db
				.prepare(
					"INSERT INTO accounts (plaid_item_id, name, type) VALUES (?, 'Old checking', 'depository') RETURNING id",
				)
				.bind(itemId)
				.first<{ id: number }>()
		)?.id as number;
		const goneId = await insertPurchase("old-1", accountId);
		await logCategory(goneId, TODAY);
		// The disconnect that also deletes the bank's history (accounts.tsx) deletes its transactions.
		await db
			.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?)",
			)
			.bind(itemId)
			.run();
		// Deleted work still counts, with no transaction behind it.
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 1,
			changed: 0,
		});
		const nextId = await insertPurchase("next-2", 1);
		expect(nextId).toBe(goneId);
		await sortedByJev(nextId);
		expect(await readAiTally(db, TODAY)).toMatchObject({
			sorted: 2,
			changed: 0,
		});
	});

	it("exports a deleted transaction's log row with no transaction id, and still counts it", async () => {
		const droppedId = await insertPurchase("gone-3", 1);
		await logCategory(droppedId, TODAY);
		await db
			.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(droppedId)
			.run();
		const data = (await tallyExport(db)) as unknown as Record<string, unknown>;
		expect(data.ai_log).toEqual([
			expect.objectContaining({ kind: "category", transaction_id: null }),
		]);
		expect(await readAiTally(db, TODAY)).toMatchObject({ sorted: 1 });
	});
});

describe("the tally's lines", () => {
	it("turns the categories line to Transactions · Off, in muted words, without 'you changed'", async () => {
		const html = await AiTally({
			tally: {
				month: "2026-10",
				sorted: 84,
				changed: 5,
				named: 12,
				paychecks: 2,
			},
			switches: { names: true, categories: false, income: true },
		}).toString();
		expect(html).toMatch(/<li[^>]*text-muted[^>]*>Transactions · Off<\/li>/);
		expect(html).not.toContain("you changed");
		expect(html).not.toContain("Sorted");
	});

	it("reads Paychecks · Off in muted words when Spot paychecks is off, and Suggest store names · Off when names are", async () => {
		const html = await AiTally({
			tally: {
				month: "2026-10",
				sorted: 84,
				changed: 5,
				named: 12,
				paychecks: 2,
			},
			switches: { names: false, categories: true, income: false },
		}).toString();
		expect(html).toMatch(/<li[^>]*text-muted[^>]*>Paychecks · Off<\/li>/);
		expect(html).toMatch(
			/<li[^>]*text-muted[^>]*>Suggest store names · Off<\/li>/,
		);
		expect(html).not.toContain("Found");
		expect(html).not.toContain("Cleaned");
	});

	it("draws the picked example: Sorted with you changed, Cleaned and Found", async () => {
		const html = await linesOf({
			month: "2026-10",
			sorted: 84,
			changed: 5,
			named: 12,
			paychecks: 2,
		});
		expect(html).toContain("Sorted 84 transactions · you changed 5");
		expect(html).toContain("Cleaned 12 merchant names");
		expect(html).toContain("Found 2 paychecks");
	});

	it("gives the Why? link its own accessible name, and a section that exists on How Tally works", async () => {
		const link = await WhyLink({
			section: "what-ai-did",
			topic: "what Tally did",
		}).toString();
		expect(link).toContain('aria-label="Why? what Tally did"');
		expect(link).toContain('href="/how-it-works#what-ai-did"');
		const page = await (
			await exports.default.fetch(`${BASE}/how-it-works`)
		).text();
		expect(page).toContain('id="what-ai-did"');
	});

	it("draws the tally inside the AI suggestions group, under its switches", async () => {
		const html = await (await exports.default.fetch(`${BASE}/settings`)).text();
		const group =
			html.split('id="ai-suggestions"')[1]?.split("</section>")[0] ?? "";
		expect(group).toContain("Why? what Tally did");
		expect(group).toMatch(/Sorted \d+ transactions? · you changed \d+/);
	});
});

describe("what the Jev run and the names write", () => {
	it("saves a Jev answer and its log row together, or neither", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		// A credit no one reviewed, so Jev's income answer is applied and logged along with the category.
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, updated_by) VALUES (1, ?, -250000, 'ACME PAYROLL', 'test')",
			)
			.bind(TODAY)
			.run();
		// The answer carries no details questions, so the switch for them is off (as in the categorize tests).
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false });
		const before = {
			category: await idsWhere("category_source = 'jev'"),
			income: await idsWhere("income_source = 'jev'"),
		};
		await db
			.prepare(
				"CREATE TRIGGER ai_log_down BEFORE INSERT ON ai_log BEGIN SELECT RAISE(ABORT, 'log down'); END",
			)
			.run();
		try {
			// A failed save stops the run, as it does today.
			await categorizePending(
				{ DB: db, JEV_API_KEY: "test-key" },
				fakeJev(() => reply(0.99, 0.99)).fetchImpl,
			).catch(() => {});
		} finally {
			await db.prepare("DROP TRIGGER ai_log_down").run();
		}
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM ai_log")
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
		expect(await idsWhere("category_source = 'jev'")).toEqual(before.category);
		expect(await idsWhere("income_source = 'jev'")).toEqual(before.income);

		// With the log writable again, the same transactions are asked about and both rows come back.
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key" },
			fakeJev(() => reply(0.99, 0.99)).fetchImpl,
		);
		const after = {
			category: await idsWhere("category_source = 'jev'"),
			income: await idsWhere("income_source = 'jev'"),
		};
		const newCategory = after.category.filter(
			(id) => !before.category.includes(id),
		);
		const newIncome = after.income.filter((id) => !before.income.includes(id));
		expect(newCategory.length).toBeGreaterThan(0);
		expect(newIncome.length).toBeGreaterThan(0);
		expect(await logIds("category")).toEqual(newCategory);
		expect(await logIds("income")).toEqual(newIncome);
	});

	it("logs each category and income a run applies, once, and nothing it doesn't", async () => {
		// A credit no one reviewed: Jev may mark it as income and give it a category.
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, updated_by) VALUES (1, ?, -250000, 'ACME PAYROLL', 'test')",
			)
			.bind(TODAY)
			.run();
		const before = {
			category: await idsWhere("category_source = 'jev'"),
			income: await idsWhere("income_source = 'jev'"),
		};
		vi.spyOn(console, "log").mockImplementation(() => {});
		// The answer carries no details questions, so the switch for them is off (as in the categorize tests).
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, details: false });
		const jev = fakeJev(() => reply(0.99, 0.99));
		await categorizePending({ DB: db, JEV_API_KEY: "test-key" }, jev.fetchImpl);
		const after = {
			category: await idsWhere("category_source = 'jev'"),
			income: await idsWhere("income_source = 'jev'"),
		};
		const newCategory = after.category.filter(
			(id) => !before.category.includes(id),
		);
		const newIncome = after.income.filter((id) => !before.income.includes(id));
		expect(newIncome.length).toBeGreaterThan(0);
		expect(await logIds("category")).toEqual(newCategory);
		expect(await logIds("income")).toEqual(newIncome);

		// A second run asks about what is left and writes no row twice.
		await categorizePending({ DB: db, JEV_API_KEY: "test-key" }, jev.fetchImpl);
		const again = await idsWhere("category_source = 'jev'");
		const allNew = again.filter((id) => !before.category.includes(id));
		expect(await logIds("category")).toEqual(allNew);
		const dupes = await db
			.prepare(
				"SELECT COUNT(*) - COUNT(DISTINCT transaction_id) AS n FROM ai_log WHERE kind = 'category'",
			)
			.first<{ n: number }>();
		expect(dupes?.n).toBe(0);
	});

	it("logs a name a person keeps when Tally guessed it, and not a bank name or a rejected one", async () => {
		await db
			.prepare(
				`INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES
				 ('ACME*X', 'Acme Shop', 'pending'), ('BANKCO', 'BANKCO', 'pending'), ('OTHER', 'Other Co', 'pending')`,
			)
			.run();
		await settleSuggestion(db, "BANKCO", { kind: "name", name: "BANKCO" });
		await settleSuggestion(db, "OTHER", {
			kind: "name",
			name: "Something else",
		});
		const none = await db
			.prepare("SELECT COUNT(*) AS n FROM ai_log WHERE kind = 'name'")
			.first<{ n: number }>();
		expect(none?.n).toBe(0);

		await settleSuggestion(db, "ACME*X", { kind: "name", name: "Acme Shop" });
		await settleSuggestion(db, "ACME*X", { kind: "name", name: "Acme Shop" });
		const names = await db
			.prepare(
				"SELECT merchant_raw_name AS name FROM ai_log WHERE kind = 'name'",
			)
			.all<{ name: string }>();
		expect(names.results.map((row) => row.name)).toEqual(["ACME*X"]);
		expect((await readAiTally(db, TODAY)).named).toBe(1);
	});

	it("logs a guessed name kept in the edit panel, and not the bank's name or one typed in", async () => {
		await db
			.prepare(
				`INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES
				 ('EDIT*SHOP', 'Edit Shop', 'pending'), ('EDIT*BANK', 'EDIT*BANK', 'pending'), ('EDIT*TYPED', 'Typed Co', 'pending')`,
			)
			.run();
		const shop = await chargeAt("EDIT*SHOP");
		const bank = await chargeAt("EDIT*BANK");
		const typed = await chargeAt("EDIT*TYPED");
		await saveEdit(
			db,
			bank,
			{ ...personEdit, displayName: "EDIT*BANK" },
			"test",
		);
		await saveEdit(
			db,
			typed,
			{ ...personEdit, displayName: "Own Name" },
			"test",
		);
		expect(await logNames()).toEqual([]);

		await saveEdit(
			db,
			shop,
			{ ...personEdit, displayName: "Edit Shop" },
			"test",
		);
		expect(await logNames()).toEqual(["EDIT*SHOP"]);
		expect((await readAiTally(db, TODAY)).named).toBe(1);
	});

	it("logs a guessed name kept for an Organize group, and not the bank's name", async () => {
		await db
			.prepare(
				`INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES
				 ('ORG*SHOP', 'Org Shop', 'pending'), ('ORG*BANK', 'ORG*BANK', 'pending')`,
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, updated_by) VALUES (1, ?, 650, 'ORG*SHOP', 'test'), (1, ?, 700, 'ORG*BANK', 'test')",
			)
			.bind(TODAY, TODAY)
			.run();
		const category = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		const groupId = category?.id as number;
		expect(
			await saveOrganizeGroup(db, ["ORG*BANK"], groupId, "ORG*BANK", "test"),
		).toBe(1);
		expect(await logNames()).toEqual([]);

		expect(
			await saveOrganizeGroup(db, ["ORG*SHOP"], groupId, "Org Shop", "test"),
		).toBe(1);
		expect(await logNames()).toEqual(["ORG*SHOP"]);
	});

	it("logs no kept name for a merchant in the group that another save filed first", async () => {
		await db
			.prepare(
				`INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES
				 ('ORG*FIRST', 'Org Pick', 'pending'), ('ORG*SECOND', 'Org Pick', 'pending')`,
			)
			.run();
		await chargeAt("ORG*FIRST");
		await chargeAt("ORG*SECOND");
		const category = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
			)
			.first<{ id: number }>();
		const groupId = category?.id as number;
		// A first save files ORG*FIRST with no name, so its suggestion stays pending.
		expect(
			await saveOrganizeGroup(db, ["ORG*FIRST"], groupId, null, "test"),
		).toBe(1);

		// ORG*FIRST's charge is filed already, so only ORG*SECOND's is changed and only it is named and logged.
		expect(
			await saveOrganizeGroup(
				db,
				["ORG*FIRST", "ORG*SECOND"],
				groupId,
				"Org Pick",
				"test",
			),
		).toBe(1);
		expect(await logNames()).toEqual(["ORG*SECOND"]);
		expect(
			await db
				.prepare(
					"SELECT display_name FROM merchants WHERE raw_name = 'ORG*FIRST'",
				)
				.first<{ display_name: string | null }>(),
		).toEqual({ display_name: null });
	});
});

describe("the export and the demo", () => {
	it("includes the log in Download everything, with no amounts", async () => {
		const [a] = await someIds(1);
		await logCategory(a as number, TODAY);
		// Each table is spread in by name, so its type isn't in the export's own type.
		const data = (await tallyExport(db)) as unknown as Record<string, unknown>;
		const rows = data.ai_log as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
			"created_at",
			"household_day",
			"id",
			"kind",
			"merchant_raw_name",
			"transaction_id",
		]);
	});

	it("records the demo's example work at its reset, dated by each transaction", async () => {
		await resetDemo(db, TODAY);
		// The seed's Jev categories and income, as the reset wrote them. Bill matching may later give some
		// of those categories to a bill; what Tally did is still logged, so the counts are the seed's.
		const seed = buildSeed(TODAY);
		expect((await logIds("category")).length).toBe(
			seed.transactions.filter((t) => t.categorySource === "jev").length,
		);
		expect((await logIds("income")).length).toBe(
			seed.transactions.filter((t) => t.flagIncome).length,
		);
		const dated = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM ai_log l JOIN transactions t ON t.id = l.transaction_id WHERE l.household_day = t.date",
			)
			.first<{ n: number }>();
		const total = await db
			.prepare("SELECT COUNT(*) AS n FROM ai_log")
			.first<{ n: number }>();
		expect(dated?.n).toBe(total?.n);
		expect((await readAiTally(db, TODAY)).sorted).toBeGreaterThan(0);
	});
});
