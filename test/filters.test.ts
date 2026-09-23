import { describe, expect, it } from "vitest";
import {
	filtersToQuery,
	likePattern,
	parseFilters,
} from "../src/transactions/filters";

const parse = (qs: string) => parseFilters(new URLSearchParams(qs), "2026-09");

describe("parseFilters", () => {
	it("defaults to this month with nothing else set", () => {
		expect(parse("")).toEqual({
			q: "",
			month: "2026-09",
			category: null,
			uncategorized: false,
			excluded: false,
			page: 1,
		});
	});

	it("reads Home's band link", () => {
		expect(parse("uncategorized=1").uncategorized).toBe(true);
	});

	it("accepts all months, a month, a category id, and trims search", () => {
		expect(parse("month=all").month).toBe("all");
		expect(parse("month=2026-07").month).toBe("2026-07");
		expect(parse("category=3").category).toBe(3);
		expect(parse("q=%20bakery%20").q).toBe("bakery");
		expect(parse("page=3").page).toBe(3);
	});

	it("ignores malformed values instead of failing", () => {
		expect(parse("month=nope").month).toBe("2026-09");
		expect(parse("month=2026-13").month).toBe("2026-09");
		expect(parse("month=2026-00").month).toBe("2026-09");
		expect(parse("category=abc").category).toBeNull();
		expect(parse("category=0").category).toBeNull();
		expect(parse("page=0").page).toBe(1);
		expect(parse("page=abc").page).toBe(1);
		expect(parse(`q=${"x".repeat(200)}`).q).toHaveLength(100);
	});
});

describe("filtersToQuery", () => {
	it("round-trips and leaves out defaults", () => {
		const f = parse("q=bakery&uncategorized=1&month=2026-08");
		expect(filtersToQuery(f, "2026-09")).toBe(
			"q=bakery&month=2026-08&uncategorized=1",
		);
		expect(filtersToQuery(parse(""), "2026-09")).toBe("");
		expect(filtersToQuery(parse("page=2"), "2026-09")).toBe("page=2");
	});
});

describe("likePattern", () => {
	it("wraps in % and escapes LIKE wildcards", () => {
		expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
	});
});
