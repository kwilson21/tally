import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { monthsBefore } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { loadTrends, TREND_SPEND_SQL } from "../src/db/trends";
import { resetDemo } from "../src/demo/reset";
import { buildTrends, TREND_MONTHS } from "../src/trends";

const db = env.DB;
const TODAY = "2026-10-05";
const MONTHS = Array.from({ length: TREND_MONTHS }, (_, i) =>
	monthsBefore("2026-10", TREND_MONTHS - 1 - i),
);
const GROCERIES = 1;
const EATING_OUT = 2;
const GAS = 3;
const KIDS = 4;
const HOUSEHOLD = 5;

type Spend = { month: string; categoryId: number | null; cents: number };
const key = (r: { month: string; categoryId: number | null }) =>
	`${r.month}|${r.categoryId ?? "none"}`;
const byKey = (rows: Spend[]) =>
	Object.fromEntries(rows.map((r) => [key(r), r.cents]));

/** Home's spending per category and month: loadMonth's rows, income left out (home.tsx's `spent`). */
async function homeSpending(): Promise<Record<string, number>> {
	const spent: Record<string, number> = {};
	for (const month of MONTHS) {
		const { transactions } = await loadMonth(db, month);
		for (const t of transactions) {
			if (t.income) continue;
			const k = key({ month, categoryId: t.categoryId });
			spent[k] = (spent[k] ?? 0) + t.amountCents;
		}
	}
	return spent;
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("loadTrends counts spending as Home does", () => {
	it("agrees with Home for every month and category in the demo (split, refund, transfer, income, uncategorized)", async () => {
		const { spend } = await loadTrends(db, TODAY);
		expect(byKey(spend)).toEqual(await homeSpending());
	});

	// Every kind of row that makes a counted amount differ from its bank amount, in one household.
	describe("with every awkward row", () => {
		beforeEach(async () => {
			await db.batch([
				db.prepare("DELETE FROM bill_payments"),
				db.prepare("DELETE FROM transactions"),
				db.prepare(
					"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (94, 'Late', 1234, 30, 'monthly', 'LATE BILL')",
				),
				db.prepare(`INSERT INTO transactions
					(id, account_id, date, amount_cents, raw_name, category_id, category_source, excluded, is_split, parent_id, flag_income, credit_reviewed, refund_of_id, pending) VALUES
					(100, 1, '2026-04-10', 9999, 'BEFORE THE WINDOW', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(101, 1, '2026-08-10', 10000, 'A', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(102, 1, '2026-08-20', 5000, 'KIDS PURCHASE', ${KIDS}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(103, 1, '2026-09-03', 1000, 'B', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(104, 1, '2026-09-05', 500, 'C', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(105, 1, '2026-09-06', 700, 'D', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(106, 1, '2026-09-20', 2000, 'E', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(107, 1, '2026-09-04', 3000, 'EXCLUDED', ${EATING_OUT}, 'user', 1, 0, NULL, 0, NULL, NULL, 0),
					(108, 1, '2026-09-04', 4000, 'SPLIT PARENT', NULL, NULL, 0, 1, NULL, 0, NULL, NULL, 0),
					(109, 1, '2026-09-04', 1500, 'SPLIT PART', ${EATING_OUT}, 'user', 0, 0, 108, 0, NULL, NULL, 0),
					(110, 1, '2026-09-04', 2500, 'SPLIT PART', ${HOUSEHOLD}, 'user', 0, 0, 108, 0, NULL, NULL, 0),
					(111, 1, '2026-09-04', -2000, 'PAYCHECK', NULL, NULL, 0, 0, NULL, 1, NULL, NULL, 0),
					(112, 1, '2026-09-04', -3000, 'UNREVIEWED CREDIT', ${EATING_OUT}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(113, 1, '2026-09-04', -800, 'REVIEWED CREDIT', ${EATING_OUT}, 'user', 0, 0, NULL, 0, 1, NULL, 0),
					(114, 1, '2026-09-12', -2000, 'KIDS REFUND', ${GROCERIES}, 'user', 0, 0, NULL, 0, 1, 102, 0),
					(115, 1, '2026-10-02', 1234, 'LATE BILL', ${GAS}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(116, 1, '2026-10-01', 4500, 'F', ${GROCERIES}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(117, 1, '2026-10-03', 800, 'PENDING', NULL, NULL, 0, 0, NULL, 0, NULL, NULL, 1),
					(118, 1, '2026-10-04', 6000, 'G', ${EATING_OUT}, 'user', 0, 0, NULL, 0, NULL, NULL, 0),
					(119, 1, '2026-10-04', 1200, 'H', ${HOUSEHOLD}, 'user', 0, 0, NULL, 0, NULL, NULL, 0)`),
				// October's late payment pays September's bill, so it counts in September.
				db.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (94, '2026-09', 115, 'user', 'linked')",
				),
			]);
		});

		it("agrees with Home for every month and category", async () => {
			const { spend } = await loadTrends(db, TODAY);
			expect(byKey(spend)).toEqual(await homeSpending());
		});

		it("totals counted spending by the month it counts in and its category", async () => {
			const { spend } = await loadTrends(db, TODAY);
			expect(byKey(spend)).toEqual({
				// A linked refund counts in its purchase's month and category: $50 less $20.
				[`2026-08|${KIDS}`]: 3000,
				[`2026-08|${GROCERIES}`]: 10000,
				// Excluded, split parent, income and the unreviewed credit are out; the split's
				// parts, the reviewed credit and the late bill's payment (counted here, not October) are in.
				[`2026-09|${GROCERIES}`]: 4200,
				[`2026-09|${EATING_OUT}`]: 700,
				[`2026-09|${HOUSEHOLD}`]: 2500,
				[`2026-09|${GAS}`]: 1234,
				[`2026-10|${GROCERIES}`]: 4500,
				[`2026-10|${EATING_OUT}`]: 6000,
				[`2026-10|${HOUSEHOLD}`]: 1200,
				// A pending transaction counts like any other, here with no category.
				"2026-10|none": 800,
			});
		});

		it("leaves out months before the six it draws", async () => {
			const { spend } = await loadTrends(db, TODAY);
			expect(spend.some((r) => r.month < "2026-05")).toBe(false);
		});

		it("counts last month's days 1 to today's, by the date a transaction is dated", async () => {
			const { sameDays } = await loadTrends(db, TODAY);
			const byCategory = Object.fromEntries(
				sameDays.map((r) => [String(r.categoryId), r.cents]),
			);
			// Sep 3 ($10) and Sep 5 ($5) in Groceries, not Sep 6 or Sep 20; the split's parts and the
			// reviewed credit (Sep 4); not the late bill, dated Oct 2 though counted in September; not
			// the refund, which counts in August.
			expect(byCategory).toEqual({
				[String(GROCERIES)]: 1500,
				[String(EATING_OUT)]: 700,
				[String(HOUSEHOLD)]: 2500,
			});
		});

		it("clamps to a shorter month: on Mar 31, all of February", async () => {
			await db.batch([
				db.prepare("DELETE FROM bill_payments"),
				db.prepare("DELETE FROM transactions"),
				db.prepare(`INSERT INTO transactions
					(id, account_id, date, amount_cents, raw_name, category_id, category_source) VALUES
					(200, 1, '2026-02-01', 100, 'X', ${GROCERIES}, 'user'),
					(201, 1, '2026-02-28', 200, 'Y', ${GROCERIES}, 'user'),
					(202, 1, '2026-03-05', 400, 'Z', ${GROCERIES}, 'user')`),
			]);
			const { sameDays, spend } = await loadTrends(db, "2026-03-31");
			expect(sameDays).toEqual([{ categoryId: GROCERIES, cents: 300 }]);
			expect(spend.find((r) => r.month === "2026-03")?.cents).toBe(400);
		});

		it("gives the earliest date of any transaction", async () => {
			expect((await loadTrends(db, TODAY)).firstDate).toBe("2026-04-10");
		});
	});
});

describe("the six-month window's edge", () => {
	// Today is Oct 5, so the window is May to October. Every row here is dated at or after the
	// window's first day (the bound that lets the date index seek), or counts in an earlier month.
	beforeEach(async () => {
		await db.batch([
			db.prepare("DELETE FROM bill_payments"),
			db.prepare("DELETE FROM transactions"),
			db.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (94, 'Edge A', 3000, 30, 'monthly', 'EDGE A'), (95, 'Edge B', 4000, 30, 'monthly', 'EDGE B')",
			),
			db.prepare(`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, category_id, category_source, credit_reviewed, refund_of_id) VALUES
				(300, 1, '2026-04-30', 1111, 'THE DAY BEFORE', ${GROCERIES}, 'user', NULL, NULL),
				(301, 1, '2026-05-01', 2000, 'THE FIRST DAY', ${GROCERIES}, 'user', NULL, NULL),
				(302, 1, '2026-06-02', 3000, 'EDGE A', ${GAS}, 'user', NULL, NULL),
				(303, 1, '2026-06-02', 4000, 'EDGE B', ${GAS}, 'user', NULL, NULL),
				(304, 1, '2026-05-02', 5000, 'KIDS PURCHASE', ${KIDS}, 'user', NULL, NULL),
				(305, 1, '2026-06-10', -1500, 'KIDS REFUND', ${GROCERIES}, 'user', 1, 304),
				(306, 1, '2026-04-28', 6000, 'OLD KIDS PURCHASE', ${KIDS}, 'user', NULL, NULL),
				(307, 1, '2026-05-20', -2000, 'OLD KIDS REFUND', ${GROCERIES}, 'user', 1, 306),
				(308, 1, '2026-09-01', 5000, 'HOUSEHOLD PURCHASE', ${HOUSEHOLD}, 'user', NULL, NULL),
				(309, 1, '2026-09-20', -5000, 'HOUSEHOLD REFUND', ${GROCERIES}, 'user', 1, 308),
				(310, 1, '2026-05-01', 7000, 'CORRECTED PURCHASE', ${KIDS}, 'user', NULL, NULL),
				(311, 1, '2026-04-30', -2500, 'CORRECTED REFUND', ${GROCERIES}, 'user', 1, 310)`),
			// June's payment of May's bill counts in May, inside the window; June's payment of
			// April's bill counts in April, outside it, though it's dated inside.
			db.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (94, '2026-05', 302, 'user', 'linked'), (95, '2026-04', 303, 'user', 'linked')",
			),
			db.prepare("UPDATE categories SET archived = 1 WHERE id = 5"),
		]);
	});

	it("counts a late payment dated after the edge that counts in the window's first month, and nothing that counts before it", async () => {
		const { spend } = await loadTrends(db, TODAY);
		expect(byKey(spend)).toEqual({
			// May 1 itself; the day before (April) and a refund of an April purchase are out.
			[`2026-05|${GROCERIES}`]: 2000,
			// The bill paid in June for May counts in May; the one paid for April doesn't count.
			[`2026-05|${GAS}`]: 3000,
			// A May purchase refunded in June: $50 less $15, counting in May. A purchase the bank
			// corrected to May 1 whose refund is still dated Apr 30 (before the window): $70 less $25
			// counts in May too, as Home counts it, though the refund's own date is outside the window.
			[`2026-05|${KIDS}`]: 3500 + 4500,
			// A purchase and its refund net to nothing for September.
			[`2026-09|${HOUSEHOLD}`]: 0,
		});
		expect(byKey(spend)).toEqual(await homeSpending());
	});

	it("keeps an archived category in the changes when what it spent by Sep 5 netted out by Sep 20", async () => {
		const data = await loadTrends(db, TODAY);
		expect(data.sameDays).toEqual([{ categoryId: HOUSEHOLD, cents: 5000 }]);
		const page = buildTrends(data);
		if (page.kind !== "full")
			throw new Error(`expected full, got ${page.kind}`);
		expect(page.changes.find((c) => c.name === "Household")).toMatchObject({
			nowCents: 0,
			thenCents: 5000,
			words: "Down $50",
		});
		expect(page.changes.reduce((sum, c) => sum + c.thenCents, 0)).toBe(
			page.sameDaysCents.last,
		);
	});

	it("counts a refund dated before the window whose purchase counts in it, as Home does", async () => {
		const { spend } = await loadTrends(db, TODAY);
		const may = spend.find(
			(r) => r.month === "2026-05" && r.categoryId === KIDS,
		);
		expect(may?.cents).toBe(8000);
		// Moving the refund's date further back changes nothing: it follows its purchase.
		await db
			.prepare("UPDATE transactions SET date = '2025-01-15' WHERE id = 311")
			.run();
		const again = await loadTrends(db, TODAY);
		expect(byKey(again.spend)).toEqual(byKey(spend));
		expect(byKey(again.spend)).toEqual(await homeSpending());
	});

	it("reads old transactions through indexes, not a scan: the date index, and the refund link", async () => {
		const { results } = await db
			.prepare(`EXPLAIN QUERY PLAN ${TREND_SPEND_SQL}`)
			.bind("2026-05", "2026-10", "2026-05-01")
			.all<{ detail: string }>();
		const plan = results.map((r) => r.detail).join("\n");
		expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX transactions_date/);
		expect(plan).toMatch(
			/SEARCH t USING (COVERING )?INDEX transactions_refund_of_id_idx/,
		);
		expect(plan).not.toMatch(/SCAN t(?! USING)/);
	});
});

describe("loadTrends's other rows", () => {
	it("is TrendsInput: today, categories in Home's order, and every budget amount", async () => {
		const data = await loadTrends(db, TODAY);
		expect(data.today).toBe(TODAY);
		expect(data.categories.map((c) => c.name)).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Kids",
			"Household",
		]);
		expect(data.categories[0]).toEqual({
			id: GROCERIES,
			name: "Groceries",
			icon: "groceries",
			color: "cat-blue",
			archived: false,
		});
		// Eating Out's budget changed two months ago, so it has two amounts.
		expect(
			data.amounts.filter((a) => a.categoryId === EATING_OUT),
		).toHaveLength(2);
	});

	it("marks an archived category archived", async () => {
		await db.prepare("UPDATE categories SET archived = 1 WHERE id = 5").run();
		const data = await loadTrends(db, TODAY);
		expect(data.categories.find((c) => c.id === HOUSEHOLD)?.archived).toBe(
			true,
		);
	});

	it("has no first date when there are no transactions", async () => {
		await db.batch([
			db.prepare("DELETE FROM bill_payments"),
			db.prepare("DELETE FROM transactions"),
		]);
		const data = await loadTrends(db, TODAY);
		expect(data.firstDate).toBeNull();
		expect(data.spend).toEqual([]);
		expect(data.sameDays).toEqual([]);
	});
});
