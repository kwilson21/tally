/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { CategorySummary } from "../src/budget";
import appCss from "../src/styles/app.css?raw";
import { MonthEnd } from "../src/views/month-end";

const rows = (count: number): CategorySummary[] =>
	Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		name: `Category ${index + 1}`,
		budgetCents: 10000,
		spentCents: 1010000,
		leftCents: -1000000,
		over: true,
	}));

describe("MonthEnd budget bars", () => {
	it("keeps five categories in one row without the scrolling cue", () => {
		const html = renderToString(
			<MonthEnd monthName="September" amountCents={0} rows={rows(5)} />,
		);
		expect(html).not.toContain('role="region"');
		expect(html).not.toContain("swipe sideways for the rest");
		expect(html).not.toContain("Show the rest of the categories");
		const chart = html.match(
			/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
		)?.[0];
		expect(chart).toContain('viewBox="0 0 350 142"');
		expect(chart).toContain('width="42"');
		expect([...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)]).toHaveLength(5);
	});

	it("scrolls twelve categories in one row without widening the page", () => {
		const html = renderToString(
			<MonthEnd monthName="September" amountCents={0} rows={rows(12)} />,
		);
		const chart = html.match(
			/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
		)?.[0];
		expect(html).toContain('role="region" tabindex="0"');
		expect(html).toContain(
			'aria-label="12 categories; scroll sideways to see them all"',
		);
		expect(html).toContain('href="#month-end-chart-end"');
		expect(html).toContain('aria-label="Show the rest of the categories"');
		expect(html).toContain('id="month-end-chart-end"');
		expect(html).toContain('class="month-end-chart-fade"');
		expect(html).toContain("swipe sideways for the rest");
		expect(html).toContain('class="month-end-swipe-arrow"');
		expect(html).toContain(
			'class="month-end-swipe-arrow month-end-swipe-arrow-left"',
		);
		expect(chart).toBeDefined();
		expect(chart).toContain('viewBox="0 0 772 142"');
		expect(chart).toContain('width="42"');
		expect(chart).toContain('<line x1="4" x2="772" y1="40" y2="40"');
		expect(chart).toContain('y="132"');
		const xs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map((match) =>
			Number(match[1]),
		);
		const labels = [
			...(chart ?? "").matchAll(/<text x="([\d.]+)" y="132"/g),
		].map((match) => Number(match[1]));
		const overLabels = [
			...(chart ?? "").matchAll(/<text x="([\d.]+)" y="16"/g),
		].map((match) => Number(match[1]));
		expect(xs).toHaveLength(12);
		expect(labels).toHaveLength(12);
		expect(overLabels).toHaveLength(12);
		expect(
			xs.every(
				(value, index) =>
					index === 0 || value - (xs[index - 1] ?? value) === 66,
			),
		).toBe(true);
		expect(
			new Set(
				[...chart.matchAll(/<text x="[\d.]+" y="132"[^>]*>(.*?)<\/text>/g)].map(
					(m) => m[1],
				),
			).size,
		).toBe(12);
		expect(html).toContain("overflow-x-auto");
		expect(html).toContain("max-w-full");
	});

	it("keeps the swipe cue still under reduced motion", () => {
		expect(appCss).toMatch(
			/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.month-end-swipe-arrow\s*\{\s*animation:\s*none;/,
		);
		expect(appCss).toContain(
			"animation: month-end-nudge var(--duration-swipe) var(--ease-swipe) 3;",
		);
	});
});
