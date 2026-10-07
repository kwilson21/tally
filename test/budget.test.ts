import { describe, expect, it } from "vitest";
import {
	type BudgetAmount,
	budgetForMonth,
	type CountedTransaction,
	statusSentence,
	summarizeMonth,
} from "../src/budget";
import { endBarRatio } from "../src/views/bar";

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

const tx = (
	categoryId: number | null,
	amountCents: number,
	income = false,
): CountedTransaction => ({
	categoryId,
	amountCents,
	income,
});

describe("summarizeMonth with a linked refund", () => {
	it("counts its money as uncategorized but leaves the row count to its purchase", () => {
		const summary = summarizeMonth({
			month: "2026-09",
			categories: CATEGORIES,
			amounts: AMOUNTS,
			transactions: [
				tx(null, 8499),
				{ categoryId: null, amountCents: -2499, income: false, linked: true },
			],
			unpaidDueBillsCents: 0,
		});
		expect(summary.uncategorized).toEqual({ spentCents: 6000, count: 1 });
	});
});

describe("summarizeMonth", () => {
	it("computes a finished month's amount from its full budgets and all counted spending", () => {
		const finished = (extra: number) =>
			summarizeMonth({
				month: "2026-09",
				categories: [
					{ id: 1, name: "Groceries" },
					{ id: 2, name: "Eating Out" },
				],
				amounts: [
					{ categoryId: 1, effectiveMonth: "2026-09", amountCents: 100000 },
					{ categoryId: 2, effectiveMonth: "2026-09", amountCents: 85000 },
					{ categoryId: 2, effectiveMonth: "2026-10", amountCents: 99000 },
				],
				transactions: [
					tx(1, 100000),
					tx(2, 73400),
					tx(null, 3000),
					tx(null, extra),
				],
				unpaidDueBillsCents: 50000,
			});
		expect(finished(0).totalBudgetCents - finished(0).totalSpentCents).toBe(
			8600,
		);
		expect(
			finished(12800).totalBudgetCents - finished(12800).totalSpentCents,
		).toBe(-4200);
		expect(
			finished(0).categories.map(({ name, over }) => [name, over]),
		).toEqual([
			["Groceries", false],
			["Eating Out", false],
		]);
	});

	it("keeps payroll out of spending while purchases and refunds affect remaining budget", () => {
		const summarize = (income: boolean) =>
			summarizeMonth({
				month: "2026-09",
				categories: [{ id: 1, name: "Household" }],
				amounts: [
					{ categoryId: 1, effectiveMonth: "2026-09", amountCents: 100000 },
				],
				transactions: [tx(1, 20000), tx(1, -5000), tx(null, -300000, income)],
				unpaidDueBillsCents: 0,
			});
		const flagged = summarize(true);
		expect(flagged.totalSpentCents).toBe(15000);
		expect(flagged.incomeCents).toBe(300000);
		expect(flagged.safeToSpendCents).toBe(85000);
		const unflagged = summarize(false);
		expect(unflagged.totalSpentCents).toBe(-285000);
		expect(unflagged.safeToSpendCents).toBe(385000);
	});

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
			{
				id: 1,
				name: "Groceries",
				budgetCents: 60000,
				spentCents: 41200,
				leftCents: 18800,
				over: false,
			},
			{
				id: 2,
				name: "Eating Out",
				budgetCents: 25000,
				spentCents: 28600,
				leftCents: -3600,
				over: true,
			},
			{
				id: 3,
				name: "Gas",
				budgetCents: 20000,
				spentCents: 13800,
				leftCents: 6200,
				over: false,
			},
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
		expect(s.categories.map((c) => c.name)).toEqual([
			"Groceries",
			"Eating Out",
		]);
		expect(s.totalSpentCents).toBe(5000);
	});
});

describe("finished month bars", () => {
	it.each([
		[5000, 10000, { ratio: 0.5, capped: false }],
		[12000, 10000, { ratio: 1.2, capped: false }],
		[20000, 10000, { ratio: 1.25, capped: true }],
		[3000, 0, { ratio: 1.25, capped: true }],
		[0, 0, { ratio: 0, capped: false }],
		[-1000, 10000, { ratio: 0, capped: false }],
	])("draws %i cents against a %i-cent budget", (spent, budget, expected) => {
		expect(endBarRatio(spent, budget)).toEqual(expected);
	});
});

const cat = (name: string, leftCents: number) => ({
	id: 0,
	name,
	budgetCents: 10000,
	spentCents: 10000 - leftCents,
	leftCents,
	over: leftCents < 0,
});

describe("statusSentence", () => {
	it.each([
		[[cat("Groceries", 100), cat("Gas", 50)], "Everything is on track."],
		[
			[cat("Eating Out", -3600), cat("Gas", 50)],
			"Eating Out is $36 over. Everything else is on track.",
		],
		[
			[cat("Eating Out", -3650), cat("Gas", 50)],
			"Eating Out is $36.50 over. Everything else is on track.",
		],
		[
			[cat("Eating Out", -100), cat("Gas", -200), cat("Kids", 5)],
			"Eating Out and Gas are over. Everything else is on track.",
		],
		[
			[cat("Eating Out", -100), cat("Gas", -200), cat("Kids", -5)],
			"Eating Out, Gas, and Kids are over.",
		],
		[[], "No budgets set yet."],
	])("%#", (categories, sentence) => {
		expect(statusSentence(categories)).toBe(sentence);
	});
});
