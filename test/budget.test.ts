import { describe, expect, it } from "vitest";
import {
	type BudgetAmount,
	type CountedTransaction,
	budgetForMonth,
	summarizeMonth,
} from "../src/budget";

const CATEGORIES = [
	{ id: 1, name: "Groceries" },
	{ id: 2, name: "Eating Out" },
	{ id: 3, name: "Gas" },
];

const AMOUNTS: BudgetAmount[] = [
	{ categoryId: 1, effectiveMonth: "2026-04", amountCents: 60000 },
	{ categoryId: 2, effectiveMonth: "2026-04", amountCents: 20000 },
	{ categoryId: 2, effectiveMonth: "2026-07", amountCents: 25000 },
	// Gas has no budget until September.
	{ categoryId: 3, effectiveMonth: "2026-09", amountCents: 20000 },
];

describe("budgetForMonth", () => {
	it.each([
		[2, "2026-05", 20000],
		[2, "2026-07", 25000],
		[2, "2026-09", 25000],
		[1, "2026-09", 60000],
		[3, "2026-08", null],
		[3, "2026-09", 20000],
	])("category %i in %s → %s", (categoryId, month, expected) => {
		expect(budgetForMonth(AMOUNTS, categoryId, month)).toBe(expected);
	});
});

const tx = (categoryId: number | null, amountCents: number, income = false): CountedTransaction => ({
	categoryId,
	amountCents,
	income,
});

describe("summarizeMonth", () => {
	const summary = summarizeMonth({
		month: "2026-09",
		categories: CATEGORIES,
		amounts: AMOUNTS,
		transactions: [
			tx(1, 41200),
			tx(2, 30000),
			tx(2, -1400), // refund reduces Eating Out
			tx(3, 13800),
			tx(null, 1200),
			tx(null, 2349),
			tx(null, -245000, true), // paycheck
			tx(null, -245000, true),
		],
		unpaidDueBillsCents: 14200,
	});

	it("computes spent, left, and over per category", () => {
		expect(summary.categories).toEqual([
			{ id: 1, name: "Groceries", budgetCents: 60000, spentCents: 41200, leftCents: 18800, over: false },
			{ id: 2, name: "Eating Out", budgetCents: 25000, spentCents: 28600, leftCents: -3600, over: true },
			{ id: 3, name: "Gas", budgetCents: 20000, spentCents: 13800, leftCents: 6200, over: false },
		]);
	});

	it("keeps uncategorized as its own total and count, excluding income", () => {
		expect(summary.uncategorized).toEqual({ spentCents: 3549, count: 2 });
	});

	it("counts income separately as a positive amount", () => {
		expect(summary.incomeCents).toBe(490000);
	});

	it("safe to spend = total budget − all non-income spending − unpaid due bills", () => {
		// 105000 − (41200 + 28600 + 13800 + 3549) − 14200
		expect(summary.totalBudgetCents).toBe(105000);
		expect(summary.totalSpentCents).toBe(87149);
		expect(summary.safeToSpendCents).toBe(3651);
	});

	it("leaves categories with no budget out of the budget list but keeps their spending", () => {
		const s = summarizeMonth({
			month: "2026-08",
			categories: CATEGORIES,
			amounts: AMOUNTS,
			transactions: [tx(3, 5000)],
			unpaidDueBillsCents: 0,
		});
		expect(s.categories.map((c) => c.name)).toEqual(["Groceries", "Eating Out"]);
		expect(s.totalSpentCents).toBe(5000);
	});
});
