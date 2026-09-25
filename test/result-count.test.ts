import { describe, expect, it } from "vitest";
import type { Filters } from "../src/transactions/filters";
import { resultCount } from "../src/transactions/result-count";

const TODAY = "2026-09-22";
const base: Filters = {
	q: "",
	month: "2026-09",
	category: null,
	uncategorized: false,
	excluded: false,
	page: 1,
};
const one = { total: 12, first: 1, shown: 12, pages: 1 };

describe("resultCount", () => {
	it("names the month", () => {
		expect(resultCount(one, base, null, TODAY)).toBe(
			"12 transactions in September",
		);
	});

	it("uses the singular for one", () => {
		expect(
			resultCount(
				{ total: 1, first: 1, shown: 1, pages: 1 },
				base,
				null,
				TODAY,
			),
		).toBe("1 transaction in September");
	});

	it("adds the year for another year, and says so for all months", () => {
		expect(resultCount(one, { ...base, month: "2025-12" }, null, TODAY)).toBe(
			"12 transactions in December 2025",
		);
		expect(resultCount(one, { ...base, month: "all" }, null, TODAY)).toBe(
			"12 transactions across all months",
		);
	});

	it("names the category", () => {
		const f = { ...base, category: 1 };
		expect(resultCount(one, f, "Groceries", TODAY)).toBe(
			"12 transactions in Groceries, September",
		);
		expect(resultCount(one, { ...f, month: "all" }, "Groceries", TODAY)).toBe(
			"12 transactions in Groceries, across all months",
		);
	});

	it("names every other filter", () => {
		expect(
			resultCount(
				one,
				{ ...base, q: "coffee", uncategorized: true, excluded: true },
				null,
				TODAY,
			),
		).toBe(
			'12 excluded transactions needing a category matching "coffee" in September',
		);
	});

	it("says which part of the list a page shows", () => {
		expect(
			resultCount(
				{ total: 35, first: 26, shown: 10, pages: 2 },
				base,
				null,
				TODAY,
			),
		).toBe("Showing 26–35 of 35 transactions in September");
	});

	it("reads differently for two filters with the same count, so the change is announced", () => {
		const a = resultCount(one, { ...base, category: 1 }, "Groceries", TODAY);
		const b = resultCount(one, { ...base, category: 2 }, "Gas", TODAY);
		expect(a).not.toBe(b);
	});
});
