/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { monthsBefore } from "../src/dates";
import {
	MonthNavigation,
	monthMark,
	monthResultWords,
	stripMonths,
} from "../src/views/month-navigation";

describe("MonthNavigation for a year before 1000", () => {
	it("writes the year with four digits in the strip and the arrows", () => {
		const html = renderToString(
			<MonthNavigation
				month="0100-02"
				firstMonth="0100-01"
				currentMonth="2026-10"
				results={{}}
			/>,
		);
		const nav = html.match(/<ol[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
		const links = [...nav.matchAll(/<a href="\/\?month=([0-9-]+)"/g)].map(
			(match) => match[1],
		);
		expect(links).toHaveLength(36);
		expect(links[0]).toBe("0100-01");
		expect(html).toMatch(
			/<a href="\/\?month=0100-01"[^>]*aria-label="Previous month/,
		);
	});
});

describe("MonthNavigation history window", () => {
	it.each([0, 1, 19, 99])(
		"keeps every dot link in history when viewing month %i",
		(offset) => {
			const firstMonth = "2018-01";
			const currentMonth = monthsBefore(firstMonth, -99);
			const month = monthsBefore(firstMonth, -offset);
			const html = renderToString(
				<MonthNavigation
					month={month}
					firstMonth={firstMonth}
					currentMonth={currentMonth}
					results={{}}
				/>,
			);
			const nav = html.match(/<ol[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
			const links = [...nav.matchAll(/<a href="\/?\?month=([0-9-]+)"/g)].map(
				(match) => match[1],
			);
			expect(links.length).toBeLessThanOrEqual(36);
			expect(links).toContain(month);
			expect(
				links.every(
					(item) => item && item >= firstMonth && item <= currentMonth,
				),
			).toBe(true);
			const firstVisible =
				firstMonth > monthsBefore(month, 35)
					? firstMonth
					: monthsBefore(month, 35);
			expect(links).toEqual(
				Array.from({ length: links.length }, (_, index) =>
					monthsBefore(firstVisible, -index),
				),
			);
		},
	);
});

describe("MonthNavigation month marks", () => {
	const results = {
		"2026-05": 31000,
		"2026-06": -20000,
		"2026-07": 0,
		"2026-08": null,
		"2026-09": -213447,
		"2026-10": 50000,
	};
	// The strip's own link for a month; the arrows beside the title link to the same months.
	const link = (html: string, month: string) => {
		const strip = html.match(/<ol[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
		return (
			strip.match(
				new RegExp(`<a href="/\\?month=${month}"[^>]*>[\\s\\S]*?</a>`),
			)?.[0] ?? ""
		);
	};

	it("marks each finished month with its result, in words as well as shape", () => {
		const page = renderToString(
			<MonthNavigation
				month="2026-06"
				firstMonth="2026-05"
				currentMonth="2026-10"
				results={results}
			/>,
		);
		expect(link(page, "2026-05")).toContain('data-mark="under"');
		expect(link(page, "2026-05")).toContain(
			'<span class="sr-only">May, ended $310 under</span>',
		);
		expect(link(page, "2026-06")).toContain('data-mark="over"');
		expect(link(page, "2026-06")).toContain(
			'<span class="sr-only">June, ended $200 over</span>',
		);
		expect(link(page, "2026-07")).toContain('data-mark="under"');
		expect(link(page, "2026-07")).toContain("July, ended $0 under");
		expect(link(page, "2026-08")).toContain('data-mark="empty"');
		expect(link(page, "2026-08")).toContain("August, no budgets");
		expect(link(page, "2026-09")).toContain("September, ended $2,134 over");
	});

	it("keeps the mark out of the accessible tree and gives the current month a plain dot, not a result mark", () => {
		const page = renderToString(
			<MonthNavigation
				month="2026-06"
				firstMonth="2026-05"
				currentMonth="2026-10"
				results={results}
			/>,
		);
		const current = link(page, "2026-10");
		expect(current).toContain('data-mark="current"');
		expect(current).not.toMatch(/data-mark="(under|over|empty)"/);
		expect(current).toContain("October, so far");
		expect(current).toContain(
			"ring-2 ring-accent ring-offset-2 ring-offset-paper",
		);
		expect(link(page, "2026-06")).toContain(
			'<span aria-hidden="true" data-mark="over"',
		);
		expect(link(page, "2026-06")).toContain(
			'class="flex size-8 rounded-full items-center justify-center border border-rule ring-2 ring-ink ring-offset-2 ring-offset-paper"',
		);
	});

	it("rings the shown month in ink and the current month in accent", () => {
		const page = renderToString(
			<MonthNavigation
				month="2026-09"
				firstMonth="2026-05"
				currentMonth="2026-10"
				results={results}
			/>,
		);
		expect(link(page, "2026-09")).toContain('aria-current="page"');
		expect(link(page, "2026-09")).toContain("ring-ink");
		expect(link(page, "2026-09")).not.toContain("ring-accent");
		expect(link(page, "2026-10")).not.toContain("ring-ink");
	});

	it("tells a month's result in words for any year", () => {
		expect(monthResultWords("September 2025", -213447, false)).toBe(
			"September 2025, ended $2,134 over",
		);
		expect(monthResultWords("May", 31000, false)).toBe("May, ended $310 under");
		expect(monthResultWords("April", null, false)).toBe("April, no budgets");
		expect(monthResultWords("October", 0, true)).toBe("October, so far");
	});

	it("marks under, over, no budget and the current month", () => {
		expect(monthMark(0, false)).toBe("under");
		expect(monthMark(-1, false)).toBe("over");
		expect(monthMark(null, false)).toBe("empty");
		expect(monthMark(5, true)).toBe("current");
	});

	it("lists the same months the strip renders", () => {
		const months = stripMonths("2026-06", "2026-05", "2026-10");
		expect(months).toEqual([
			"2026-05",
			"2026-06",
			"2026-07",
			"2026-08",
			"2026-09",
			"2026-10",
		]);
		const page = renderToString(
			<MonthNavigation
				month="2026-06"
				firstMonth="2026-05"
				currentMonth="2026-10"
				results={{}}
			/>,
		);
		const strip = page.match(/<ol[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
		const links = [...strip.matchAll(/<a href="\/\?month=([0-9-]+)"/g)].map(
			(match) => match[1],
		);
		expect(links).toEqual(months);
	});
});
