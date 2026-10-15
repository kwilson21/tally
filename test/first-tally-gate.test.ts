import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { markStroke } from "../src/db/first-tally";
import {
	countWaitingForJev,
	pendingForJev,
	saveJevResult,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { questionsOpen, readQuestionsGate } from "../src/first-tally/gate";

const db = env.DB;
const TODAY = "2026-10-14";

const open = {
	today: TODAY,
	strokeOneDay: "2026-10-13",
	banks: [{ lastSyncedAt: "2026-10-13", historyCompleteAt: "2026-10-13" }],
	waiting: 0,
};

describe("questionsOpen, one condition at a time", () => {
	it("opens when every condition holds", () => {
		expect(questionsOpen(open)).toBe(true);
	});

	it("stays shut on stroke one's own day: the questions open the day after", () => {
		expect(questionsOpen({ ...open, strokeOneDay: TODAY })).toBe(false);
		expect(questionsOpen({ ...open, strokeOneDay: "2026-10-15" })).toBe(false);
	});

	it("stays shut with no stroke one day to measure from", () => {
		expect(questionsOpen({ ...open, strokeOneDay: null })).toBe(false);
	});

	it("stays shut with no connected bank, since every bank being synced is vacuously true", () => {
		expect(questionsOpen({ ...open, banks: [] })).toBe(false);
	});

	it("stays shut while a bank has never finished a sync", () => {
		expect(
			questionsOpen({
				...open,
				banks: [{ lastSyncedAt: null, historyCompleteAt: "2026-10-13" }],
			}),
		).toBe(false);
	});

	it("stays shut while a bank's 90-day history isn't in yet, even after its first sync", () => {
		expect(
			questionsOpen({
				...open,
				banks: [{ lastSyncedAt: "2026-10-13", historyCompleteAt: null }],
			}),
		).toBe(false);
	});

	it("needs every connected bank, not just one", () => {
		expect(
			questionsOpen({
				...open,
				banks: [
					{ lastSyncedAt: "2026-10-13", historyCompleteAt: "2026-10-13" },
					{ lastSyncedAt: "2026-10-13", historyCompleteAt: null },
				],
			}),
		).toBe(false);
	});

	it("stays shut while an imported transaction still waits for Jev", () => {
		expect(questionsOpen({ ...open, waiting: 1 })).toBe(false);
	});
});

describe("countWaitingForJev", () => {
	let n = 0;
	/** Inserts one imported row on the test account, with `over` for the columns that differ. */
	async function txn(over: Record<string, unknown> = {}) {
		n += 1;
		const row: Record<string, unknown> = {
			account_id: 1,
			plaid_transaction_id: `gate-${n}`,
			date: "2026-10-02",
			amount_cents: 1200,
			raw_name: `SHOP ${n}`,
			...over,
		};
		const columns = Object.keys(row);
		const inserted = await db
			.prepare(
				`INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			)
			.bind(...Object.values(row))
			.run();
		return inserted.meta.last_row_id;
	}
	const count = (categories: boolean, income: boolean) =>
		countWaitingForJev(db, { categories, income });
	/** The stored income answer and its flag, for a row. */
	const incomeOf = (id: number) =>
		db
			.prepare(
				"SELECT income_confidence, flag_income FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{ income_confidence: number | null; flag_income: number }>();
	/** Jev's unsure category answer on a credit: the category is unsure, so the row still waits for income. */
	const unsureCategory = {
		categoryId: null,
		suggestedCategoryId: null,
		confidence: 0.4,
		flags: { transfer: false, reimbursement: false, income: false },
	};

	beforeEach(async () => {
		await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM accounts"),
			db.prepare("DELETE FROM plaid_items"),
			db.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
			db.prepare(
				"INSERT INTO accounts (id, plaid_item_id, plaid_account_id, name, type, subtype, is_liability, balance_cents) VALUES (1, NULL, 'gate-acct', 'Checking', 'depository', 'checking', 0, 0)",
			),
		]);
		n = 0;
	});

	it("counts an uncategorized purchase nobody has answered, while categories are on", async () => {
		await txn();
		expect(await count(true, true)).toBe(1);
		expect(await count(true, false)).toBe(1);
	});

	it("ignores category work entirely while categories are off", async () => {
		await txn();
		expect(await count(false, true)).toBe(0);
		expect(await count(false, false)).toBe(0);
	});

	it("counts an unanswered credit for income while income is on, even with categories off", async () => {
		await txn({ amount_cents: -5000 });
		expect(await count(false, true)).toBe(1);
		expect(await count(false, false)).toBe(0);
	});

	it("counts an unanswered credit for its category while categories are on, with income off", async () => {
		await txn({ amount_cents: -5000 });
		expect(await count(true, false)).toBe(1);
	});

	it("is zero with both switches off", async () => {
		await txn();
		await txn({ amount_cents: -5000 });
		expect(await count(false, false)).toBe(0);
	});

	it("treats a below-threshold category answer as sorted", async () => {
		await txn({ category_confidence: 0.4, jev_category_id: 1 });
		expect(await count(true, true)).toBe(0);
	});

	it("treats a below-threshold income answer as sorted", async () => {
		await txn({
			amount_cents: -5000,
			category_confidence: 0.9,
			income_confidence: 0.4,
		});
		expect(await count(false, true)).toBe(0);
	});

	it("asks a credit for its income once income is back on, when its category was answered with income off", async () => {
		await saveAiSwitches(db, { categories: true, income: false });
		const id = await txn({ amount_cents: -5000 });
		expect(
			await saveJevResult(db, id, unsureCategory, {
				switches: { income: false, categories: true },
			}),
		).toBe(true);
		expect(await pendingForJev(db, 100, { income: false })).toEqual([]);
		expect(await count(true, false)).toBe(0);

		await saveAiSwitches(db, { income: true });
		expect((await pendingForJev(db, 100)).map((p) => p.id)).toEqual([id]);
		expect(await count(true, true)).toBe(1);
		expect(await count(false, true)).toBe(1);

		// Jev's income answer is unsure too: it is stored, so the row leaves the queue and the gate.
		expect(
			await saveJevResult(
				db,
				id,
				{
					...unsureCategory,
					flagConfidence: { transfer: 0, reimbursement: 0, income: 0.3 },
				},
				{ switches: { income: true, categories: true } },
			),
		).toBe(true);
		expect(await incomeOf(id)).toEqual({
			income_confidence: 0.3,
			flag_income: 0,
		});
		expect(await pendingForJev(db, 100)).toEqual([]);
		expect(await count(true, true)).toBe(0);
	});

	it("takes a credit out of the gate once Jev's income answer is a sure yes, which flags it", async () => {
		await saveAiSwitches(db, { categories: true, income: false });
		const id = await txn({ amount_cents: -5000 });
		await saveJevResult(db, id, unsureCategory, {
			switches: { income: false, categories: true },
		});
		await saveAiSwitches(db, { income: true });
		expect(
			await saveJevResult(
				db,
				id,
				{
					...unsureCategory,
					flags: { transfer: false, reimbursement: false, income: true },
					flagConfidence: { transfer: 0, reimbursement: 0, income: 0.95 },
				},
				{ switches: { income: true, categories: true } },
			),
		).toBe(true);
		expect(await incomeOf(id)).toEqual({
			income_confidence: null,
			flag_income: 1,
		});
		expect(await pendingForJev(db, 100)).toEqual([]);
		expect(await count(true, true)).toBe(0);
		expect(await count(false, true)).toBe(0);
	});

	it("treats a row Jev failed on as sorted, so it never holds the gate", async () => {
		await txn({ jev_failed_at: "2026-10-12" });
		await txn({ amount_cents: -5000, jev_failed_at: "2026-10-12" });
		expect(await count(true, true)).toBe(0);
	});

	it("leaves out a categorized purchase, a manual cash entry and a flagged income", async () => {
		await txn({ category_id: 1, category_source: "user" });
		await txn({ plaid_transaction_id: null });
		await txn({ amount_cents: -5000, flag_income: 1 });
		expect(await count(true, true)).toBe(0);
	});

	it("leaves out a refund that follows its purchase, which has no question of its own", async () => {
		await txn({ category_id: 1, category_source: "user", amount_cents: 4000 });
		const purchase = (
			await db
				.prepare(
					"SELECT id FROM transactions WHERE plaid_transaction_id = 'gate-1'",
				)
				.first<{ id: number }>()
		)?.id;
		await txn({
			amount_cents: -4000,
			credit_reviewed: 1,
			credit_reviewed_by: "user",
			refund_of_id: purchase,
		});
		expect(await count(true, true)).toBe(0);
	});

	it("leaves out an excluded transfer and a row that only needs details", async () => {
		await txn({ excluded: 1, excluded_source: "plaid" });
		await txn({ category_id: 1, category_source: "user", note: "" });
		expect(await count(true, true)).toBe(0);
	});

	describe("agrees with the queue the gate counts for", () => {
		/**
		 * One row for each way a question can wait: an unasked purchase, an unasked credit, a credit Jev answered unsure
		 * with income off (its category is unsure, so its income is still unasked), a credit Jev failed on, and a row that
		 * only needs details. Returns the failed row's id.
		 */
		async function seedQueue() {
			await txn();
			await txn({ amount_cents: -5000 });
			await txn({
				amount_cents: -5000,
				category_confidence: 0.4,
				jev_category_id: 1,
			});
			const failed = await txn({
				amount_cents: -5000,
				jev_failed_at: "2026-10-12",
			});
			await txn({ category_id: 1, category_source: "user", note: "" });
			return failed;
		}

		it.each([
			[true, true, 3],
			[true, false, 2],
			[false, false, 0],
		])(
			"with categories %s and income %s, counts the rows the queue asks about that Jev did not fail on",
			async (categories, income, expected) => {
				const failed = await seedQueue();
				const asked = (
					await pendingForJev(db, 100, { categories, income })
				).filter((pending) => pending.id !== failed);
				expect(asked).toHaveLength(expected);
				expect(await count(categories, income)).toBe(expected);
			},
		);

		it("with categories off and income on, counts only the credits: the queue also asks a purchase, the gate does not (spec §8.8)", async () => {
			await seedQueue();
			expect(await count(false, true)).toBe(2);
		});
	});
});

describe("readQuestionsGate", () => {
	beforeEach(async () => {
		await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
		await db.batch([
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM accounts"),
			db.prepare("DELETE FROM plaid_items"),
			db.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
			db.prepare(
				"INSERT INTO accounts (id, plaid_item_id, plaid_account_id, name, type, subtype, is_liability, balance_cents) VALUES (1, NULL, 'gate-acct', 'Checking', 'depository', 'checking', 0, 0)",
			),
		]);
		await saveAiSwitches(db, {});
	});

	const addBank = (
		id: string,
		{
			synced = "2026-10-13",
			history = "2026-10-13",
			disconnected = null,
		}: {
			synced?: string | null;
			history?: string | null;
			disconnected?: string | null;
		} = {},
	) =>
		db
			.prepare(
				"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by, last_synced_at, history_complete_at, disconnected_at) VALUES (?, ?, 'Bank', 'person', ?, ?, ?)",
			)
			.bind(id, new Uint8Array(1), synced, history, disconnected)
			.run();

	it("is shut with no bank", async () => {
		await markStroke(db, "bank", "2026-10-13");
		expect(await readQuestionsGate(db, TODAY)).toBe(false);
	});

	it("opens once stroke one's day is past and the bank's history is in", async () => {
		await markStroke(db, "bank", "2026-10-13");
		await addBank("gate-bank-1");
		expect(await readQuestionsGate(db, TODAY)).toBe(true);
	});

	it("is shut on stroke one's own day", async () => {
		await markStroke(db, "bank", TODAY);
		await addBank("gate-bank-1");
		expect(await readQuestionsGate(db, TODAY)).toBe(false);
	});

	it("ignores a disconnected bank that never finished", async () => {
		await markStroke(db, "bank", "2026-10-13");
		await addBank("gate-bank-1");
		await addBank("gate-bank-2", {
			synced: null,
			history: null,
			disconnected: "2026-10-13",
		});
		expect(await readQuestionsGate(db, TODAY)).toBe(true);
	});

	it("is shut while an imported transaction waits for Jev, and open once Jev is off", async () => {
		await markStroke(db, "bank", "2026-10-13");
		await addBank("gate-bank-1");
		await db
			.prepare(
				"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) VALUES (1, 'gate-open', '2026-10-02', 1200, 'SHOP')",
			)
			.run();
		expect(await readQuestionsGate(db, TODAY)).toBe(false);
		await saveAiSwitches(db, { categories: false, income: false });
		expect(await readQuestionsGate(db, TODAY)).toBe(true);
	});
});
