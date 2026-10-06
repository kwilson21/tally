import { describe, expect, it } from "vitest";
import type { Filters } from "../src/transactions/filters";
import { resultCount } from "../src/transactions/result-count";

const TODAY = "2026-09-22";
const base: Filters = {
	q: "",
	month: "2026-09",
	category: null,
	account: null,
	show: "all",
	uncategorized: false,
	page: 1,
};
const CARD = "Chase Card ••9921";
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

	it("names the Needs category filter", () => {
		expect(
			resultCount(one, { ...base, uncategorized: true }, null, TODAY),
		).toBe("12 transactions needing a category in September");
	});

	it("names the Excluded filter", () => {
		expect(
			resultCount(
				{ total: 2, first: 1, shown: 2, pages: 1 },
				{ ...base, show: "excluded" },
				null,
				TODAY,
			),
		).toBe("2 excluded transactions in September");
	});

	it("names the account, with and without a category (#210)", () => {
		const f = { ...base, account: 3 };
		expect(resultCount(one, f, null, TODAY, CARD)).toBe(
			"12 transactions in Chase Card ••9921, September",
		);
		expect(resultCount(one, { ...f, category: 1 }, "Groceries", TODAY, CARD)).toBe(
			"12 transactions in Groceries, Chase Card ••9921, September",
		);
		expect(resultCount(one, { ...f, month: "all" }, null, TODAY, CARD)).toBe(
			"12 transactions in Chase Card ••9921, across all months",
		);
		expect(
			resultCount(
				one,
				{ ...f, category: 1, month: "all" },
				"Groceries",
				TODAY,
				CARD,
			),
		).toBe(
			"12 transactions in Groceries, Chase Card ••9921, across all months",
		);
	});

	it("names the Cash account", () => {
		expect(resultCount(one, { ...base, account: 4 }, null, TODAY, "Cash")).toBe(
			"12 transactions in Cash, September",
		);
	});

	it("names the type: income, spending and refunds (#210)", () => {
		const two = { total: 2, first: 1, shown: 2, pages: 1 };
		expect(resultCount(two, { ...base, show: "income" }, null, TODAY)).toBe(
			"2 income transactions in September",
		);
		expect(resultCount(one, { ...base, show: "spending" }, null, TODAY)).toBe(
			"12 spending transactions in September",
		);
		expect(resultCount(two, { ...base, show: "refunds" }, null, TODAY)).toBe(
			"2 refund transactions in September",
		);
		expect(
			resultCount(
				{ total: 1, first: 1, shown: 1, pages: 1 },
				{ ...base, show: "refunds" },
				null,
				TODAY,
			),
		).toBe("1 refund transaction in September");
	});

	it("names the type, the account and the other filters together", () => {
		expect(
			resultCount(
				{ total: 40, first: 26, shown: 14, pages: 2 },
				{ ...base, show: "spending", account: 3, q: "shell", category: 4 },
				"Gas",
				TODAY,
				CARD,
			),
		).toBe(
			'Showing 26–39 of 40 spending transactions matching "shell" in Gas, Chase Card ••9921, September',
		);
	});

	it("reads differently for every type and account with the same count, so the change is announced", () => {
		const texts = [
			resultCount(one, base, null, TODAY),
			resultCount(one, { ...base, show: "spending" }, null, TODAY),
			resultCount(one, { ...base, show: "income" }, null, TODAY),
			resultCount(one, { ...base, show: "refunds" }, null, TODAY),
			resultCount(one, { ...base, show: "excluded" }, null, TODAY),
			resultCount(one, { ...base, account: 3 }, null, TODAY, CARD),
			resultCount(one, { ...base, account: 4 }, null, TODAY, "Cash"),
		];
		expect(new Set(texts).size).toBe(texts.length);
	});

	it("names the search", () => {
		expect(
			resultCount(
				{ total: 3, first: 1, shown: 3, pages: 1 },
				{ ...base, q: "coffee", uncategorized: true },
				null,
				TODAY,
			),
		).toBe('3 transactions needing a category matching "coffee" in September');
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
