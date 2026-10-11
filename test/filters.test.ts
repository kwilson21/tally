import { describe, expect, it } from "vitest";
import {
	filtersToQuery,
	likePattern,
	monthFor,
	monthParam,
	pageBefore,
	parseFilters,
	searchAmount,
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

describe("searchAmount (#211)", () => {
	it("reads a number with cents as exactly that amount, in cents", () => {
		expect(searchAmount("42.17")).toEqual({
			low: 4217,
			high: 4217,
			exact: true,
			plain: false,
		});
		expect(searchAmount("$42.17")).toEqual({
			low: 4217,
			high: 4217,
			exact: true,
			plain: false,
		});
		// Any decimal point makes it exact: "42.1" is $42.10.
		expect(searchAmount("42.1")?.low).toBe(4210);
		expect(searchAmount("42.1")?.exact).toBe(true);
	});

	it("reads a whole number as every amount in that dollar", () => {
		expect(searchAmount("42")).toEqual({
			low: 4200,
			high: 4299,
			exact: false,
			plain: true,
		});
		expect(searchAmount("$42")).toEqual({
			low: 4200,
			high: 4299,
			exact: false,
			plain: false,
		});
		expect(searchAmount("$1,284")).toEqual({
			low: 128400,
			high: 128499,
			exact: false,
			plain: false,
		});
		expect(searchAmount(" 42 ")?.plain).toBe(true);
	});

	it("reads any other text as no amount", () => {
		for (const text of [
			"costco",
			"42.",
			"$",
			"-42",
			"4 2",
			"1,00",
			"3.141",
			"groceries 42",
			"",
		])
			expect(searchAmount(text)).toBeNull();
	});
});

describe("monthFor (#211)", () => {
	const THIS = "2026-10";
	const f = (qs: string) => parseFilters(new URLSearchParams(qs), THIS);
	/** A page that showed this search, and named this month in its address or not. */
	const page = (search: string, namedMonth = false) => ({ search, namedMonth });

	it("looks in every month when a search is typed into an empty box on this month", () => {
		expect(monthFor(f("q=costco"), page(""), THIS)).toBe("all");
		expect(monthFor(f("q=42.17&month=2026-10"), page(""), THIS)).toBe("all");
	});

	it("keeps the month a search names: one picked before typing, or one picked during it", () => {
		expect(monthFor(f("q=costco&month=2026-09"), page("", true), THIS)).toBe(
			"2026-09",
		);
		expect(
			monthFor(f("q=costc&month=2026-09"), page("costco", true), THIS),
		).toBe("2026-09");
		// "Only October" and picking October both narrow, and stay while typing.
		expect(
			monthFor(f("q=costco&month=2026-10"), page("costc", true), THIS),
		).toBe("2026-10");
		expect(
			monthFor(f("q=costco&month=2026-10"), page("costco", true), THIS),
		).toBe("2026-10");
	});

	it("keeps this month picked before typing, even though it is the default (#211)", () => {
		// Picked September, then October (this month), then typing from an empty box: October stays.
		expect(monthFor(f("q=c&month=2026-10"), page("", true), THIS)).toBe(
			"2026-10",
		);
		expect(monthFor(f("q=costco&month=2026-10"), page("", true), THIS)).toBe(
			"2026-10",
		);
		// Without a picked month the same typing looks in every month.
		expect(monthFor(f("q=c&month=2026-10"), page(""), THIS)).toBe("all");
	});

	it("keeps All months while a search runs", () => {
		expect(monthFor(f("q=costc&month=all"), page("costco", true), THIS)).toBe(
			"all",
		);
	});

	it("goes back to this month when the search box is emptied, even from a picked month", () => {
		expect(monthFor(f("month=all"), page("costco", true), THIS)).toBe(
			"2026-10",
		);
		expect(monthFor(f("month=2026-09"), page("costco", true), THIS)).toBe(
			"2026-10",
		);
		expect(monthFor(f("month=2026-10"), page("costco", true), THIS)).toBe(
			"2026-10",
		);
	});

	it("keeps All months when no search was typed before (a category, say)", () => {
		expect(monthFor(f("month=all&category=1"), page(""), THIS)).toBe("all");
		expect(monthFor(f("month=all"), page(""), THIS)).toBe("all");
	});

	it("uses the month as sent when the request names no page (reload, link, no JavaScript)", () => {
		expect(monthFor(f("q=costco"), null, THIS)).toBe("2026-10");
		expect(monthFor(f("q=costco&month=2026-09"), null, THIS)).toBe("2026-09");
	});
});

describe("monthParam (#211)", () => {
	const THIS = "2026-10";
	const f = (qs: string) => parseFilters(new URLSearchParams(qs), THIS);
	const page = (search: string, namedMonth = false) => ({ search, namedMonth });

	it("names a month other than this one always", () => {
		expect(monthParam(f("month=all"), null, "all", THIS)).toBe("all");
		expect(monthParam(f("month=2026-09"), page(""), "2026-09", THIS)).toBe(
			"2026-09",
		);
	});

	it("leaves this month out unless a month the address named stays", () => {
		expect(monthParam(f("q=costco"), page(""), THIS, THIS)).toBeNull();
		expect(monthParam(f("q=costco"), null, THIS, THIS)).toBeNull();
		expect(
			monthParam(f("q=costco&month=2026-10"), page("", true), THIS, THIS),
		).toBe(THIS);
		// Emptying the box lets this month go, as it goes back to being the default.
		expect(
			monthParam(f("month=2026-10"), page("costco", true), THIS, THIS),
		).toBeNull();
	});
});

describe("pageBefore (#211)", () => {
	it("reads the search the transactions page showed, and whether its address named a month", () => {
		expect(
			pageBefore("http://tally.test/transactions?q=%20costco%20&month=all"),
		).toEqual({ search: "costco", namedMonth: true });
		expect(pageBefore("http://tally.test/transactions?month=all")).toEqual({
			search: "",
			namedMonth: true,
		});
		expect(pageBefore("http://tally.test/transactions?q=costco")).toEqual({
			search: "costco",
			namedMonth: false,
		});
	});

	it("names no earlier page without an address, for another page, or for a bad address", () => {
		expect(pageBefore(undefined)).toBeNull();
		expect(pageBefore("http://tally.test/home?q=costco")).toBeNull();
		expect(pageBefore("not a url")).toBeNull();
	});
});
