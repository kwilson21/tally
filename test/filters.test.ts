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
			account: null,
			show: "all",
			uncategorized: false,
			page: 1,
			raw: false,
		});
	});

	it("reads ?raw=1 only where the demo asks for it (the family app ignores it)", () => {
		const raw = new URLSearchParams("raw=1");
		expect(parseFilters(raw, "2026-09", true).raw).toBe(true);
		expect(parseFilters(raw, "2026-09", false).raw).toBe(false);
		expect(parseFilters(raw, "2026-09").raw).toBe(false);
		for (const other of ["raw=0", "raw=", "raw=true", "raw=2"])
			expect(
				parseFilters(new URLSearchParams(other), "2026-09", true).raw,
			).toBe(false);
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

	it("reads the Account choice as an account id", () => {
		expect(parse("account=4").account).toBe(4);
		expect(parse("account=").account).toBeNull();
	});

	it.each(["all", "spending", "income", "refunds", "excluded"] as const)(
		"reads Show %s",
		(show) => {
			expect(parse(`show=${show}`).show).toBe(show);
		},
	);

	it("still reads the old Excluded chip's link as Show Excluded", () => {
		expect(parse("excluded=1").show).toBe("excluded");
		expect(parse("excluded=0").show).toBe("all");
		// A Show choice in the same link wins over the old parameter.
		expect(parse("show=income&excluded=1").show).toBe("income");
		expect(parse("show=all&excluded=1").show).toBe("all");
	});

	it("ignores malformed values instead of failing", () => {
		expect(parse("account=abc").account).toBeNull();
		expect(parse("account=0").account).toBeNull();
		expect(parse("account=-2").account).toBeNull();
		expect(parse("account=1.5").account).toBeNull();
		expect(parse("show=everything").show).toBe("all");
		expect(parse("show=Income").show).toBe("all");
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

	it("carries the Account and Show choices, and leaves out All accounts and Show All", () => {
		const f = parse("account=4&show=refunds&category=2");
		expect(filtersToQuery(f, "2026-09")).toBe(
			"category=2&account=4&show=refunds",
		);
		expect(filtersToQuery(parse("show=all&account="), "2026-09")).toBe("");
	});

	it("carries raw=1 after the other filters, and leaves it out otherwise", () => {
		const f = parseFilters(
			new URLSearchParams("q=bakery&page=2&raw=1"),
			"2026-09",
			true,
		);
		expect(filtersToQuery(f, "2026-09")).toBe("q=bakery&page=2&raw=1");
		expect(
			filtersToQuery(
				parseFilters(new URLSearchParams("raw=1"), "2026-09", true),
				"2026-09",
			),
		).toBe("raw=1");
		expect(
			filtersToQuery(
				parseFilters(new URLSearchParams("raw=1"), "2026-09"),
				"2026-09",
			),
		).toBe("");
	});

	it("writes the old Excluded chip's link as Show Excluded", () => {
		expect(filtersToQuery(parse("excluded=1"), "2026-09")).toBe(
			"show=excluded",
		);
	});
});

describe("likePattern", () => {
	it("wraps in % and escapes LIKE wildcards", () => {
		expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
	});
});
