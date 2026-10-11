/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { monthsBefore } from "../src/dates";
import { MonthNavigation } from "../src/views/month-navigation";

describe("MonthNavigation for a year before 1000", () => {
	it("writes the year with four digits in the strip and the arrows", () => {
		const html = renderToString(
			<MonthNavigation
				month="0100-02"
				firstMonth="0100-01"
				currentMonth="2026-10"
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
