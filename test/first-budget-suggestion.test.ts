import { describe, expect, it } from "vitest";
import { MAX_BUDGET_CENTS } from "../src/budgets/amount";
import {
	firstBudgetSuggestion,
	fullMonths,
	monthlyMeanCents,
} from "../src/budgets/first-suggestion";

const month = (ym: string, spentCents: number) => ({ month: ym, spentCents });

describe("fullMonths", () => {
	it("has no full month with no history", () => {
		expect(fullMonths(null, "2026-10-14")).toEqual([]);
	});

	it("never counts the first counted month, which is a part month", () => {
		// History starts in August (a part month): only September counts before October.
		expect(fullMonths("2026-08", "2026-10-14")).toEqual(["2026-09"]);
	});

	it("has no full month when history starts in the month before this one", () => {
		expect(fullMonths("2026-09", "2026-10-14")).toEqual([]);
	});

	it("never counts the current month, even on its first day", () => {
		expect(fullMonths("2026-01", "2026-10-01")).toEqual([
			"2026-07",
			"2026-08",
			"2026-09",
		]);
	});

	it("takes the last three full months, oldest first", () => {
		expect(fullMonths("2026-01", "2026-10-14")).toEqual([
			"2026-07",
			"2026-08",
			"2026-09",
		]);
	});

	it("crosses a year", () => {
		expect(fullMonths("2025-06", "2026-02-03")).toEqual([
			"2025-11",
			"2025-12",
			"2026-01",
		]);
	});
});

describe("firstBudgetSuggestion", () => {
	it("has no suggestion with no full month", () => {
		expect(firstBudgetSuggestion([])).toBeNull();
	});

	it("suggests one full month's spending rounded up to the next $10", () => {
		expect(firstBudgetSuggestion([month("2026-09", 61001)])).toEqual({
			amountCents: 62000,
			months: [month("2026-09", 61001)],
		});
	});

	it("keeps an exact $10 multiple as it is", () => {
		expect(firstBudgetSuggestion([month("2026-09", 61000)])).toEqual({
			amountCents: 61000,
			months: [month("2026-09", 61000)],
		});
	});

	it("means the months given, then rounds up: Aug $610 and Sep $674 mean $642", () => {
		const months = [month("2026-08", 61000), month("2026-09", 67400)];
		expect(firstBudgetSuggestion(months)).toEqual({
			amountCents: 65000,
			months,
		});
	});

	it("rounds up exactly on the $10 boundary of a mean across three months", () => {
		// The mean is exactly $600: 180000 cents over three months, so no round up.
		const months = [
			month("2026-07", 60000),
			month("2026-08", 60000),
			month("2026-09", 60000),
		];
		expect(firstBudgetSuggestion(months)?.amountCents).toBe(60000);
		// One cent over the boundary (a mean of $600.01) rounds up to the next $10.
		months[2] = month("2026-09", 60003);
		expect(firstBudgetSuggestion(months)?.amountCents).toBe(61000);
	});

	it("has no suggestion when the mean is $0", () => {
		expect(
			firstBudgetSuggestion([month("2026-08", 5000), month("2026-09", -5000)]),
		).toBeNull();
	});

	it("has no suggestion when refunds outweigh spending (a negative mean)", () => {
		expect(firstBudgetSuggestion([month("2026-09", -2000)])).toBeNull();
	});

	it("counts a month with no spending as $0 in the mean", () => {
		expect(
			firstBudgetSuggestion([month("2026-08", 0), month("2026-09", 1500)]),
		).toEqual({
			amountCents: 1000,
			months: [month("2026-08", 0), month("2026-09", 1500)],
		});
	});

	it("keeps a suggestion equal to the largest budget, and drops one over it", () => {
		expect(
			firstBudgetSuggestion([month("2026-09", MAX_BUDGET_CENTS)])?.amountCents,
		).toBe(MAX_BUDGET_CENTS);
		expect(
			firstBudgetSuggestion([month("2026-09", MAX_BUDGET_CENTS + 1)]),
		).toBeNull();
	});
});

describe("monthlyMeanCents", () => {
	it("has no figure with no full month", () => {
		expect(monthlyMeanCents([])).toBeNull();
	});

	it("is the mean over the months given, rounded down to whole cents", () => {
		expect(
			monthlyMeanCents([month("2026-08", 10000), month("2026-09", 32001)]),
		).toBe(21000);
	});

	it("rounds a negative mean down, so it never reads as less spending than it was", () => {
		expect(monthlyMeanCents([month("2026-09", -1)])).toBe(-1);
		expect(monthlyMeanCents([month("2026-08", -1), month("2026-09", 0)])).toBe(
			-1,
		);
	});
});
