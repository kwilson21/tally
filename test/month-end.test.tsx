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
			<MonthEnd
				chartId="five"
				monthName="September"
				amountCents={0}
				rows={rows(5)}
			/>,
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
		const xs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map((m) =>
			Number(m[1]),
		);
		expect(xs).toEqual([4, 65.5, 127, 188.5, 250]);
		expect(298 - ((xs[xs.length - 1] ?? 0) + 42)).toBeGreaterThanOrEqual(4);
		expect(chart).toContain('<text x="298" y="45"');
	});

	it("centers one to three categories with a step no wider than 66px", () => {
		for (const [count, expected] of [
			[1, [127]],
			[2, [94, 160]],
			[3, [61, 127, 193]],
		] as const) {
			const html = renderToString(
				<MonthEnd
					chartId={`n-${count}`}
					monthName="September"
					amountCents={0}
					rows={rows(count)}
				/>,
			);
			const chart =
				html.match(
					/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
				)?.[0] ?? "";
			const xs = [...chart.matchAll(/<rect x="([\d.]+)"/g)].map((m) =>
				Number(m[1]),
			);
			expect(xs).toEqual(expected);
			expect(xs.slice(1).every((x, i) => x - (xs[i] ?? x) <= 66)).toBe(true);
		}
	});

	it("scrolls twelve categories in one row without widening the page", () => {
		const html = renderToString(
			<MonthEnd
				chartId="twelve"
				monthName="September"
				amountCents={0}
				rows={rows(12)}
			/>,
		);
		const chart = html.match(
			/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
		)?.[0];
		expect(html).toContain('role="region" tabindex="0"');
		expect(html).toContain(
			'aria-label="12 categories; scroll sideways to see them all"',
		);
		expect(html).toContain('href="#twelve-chart-end"');
		expect(html).toContain('aria-label="Show the rest of the categories"');
		expect(html).toContain(
			'class="month-end-chart-more inline-flex min-h-11 min-w-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"',
		);
		expect(html).toContain(
			"month-end-chart-more-icon month-end-swipe-arrow inline-flex size-[34px] items-center justify-center rounded-full bg-ink text-lg text-paper shadow-swipe-cue",
		);
		expect(html).toContain('id="twelve-chart-end"');
		expect(html).toContain('class="month-end-chart-fade"');
		expect(html).toContain("swipe sideways for the rest");
		expect(html).toContain(
			'class="month-end-chart-more-icon month-end-swipe-arrow',
		);
		expect(html).toContain(
			'class="month-end-swipe-arrow month-end-swipe-arrow-left text-accent"',
		);
		expect(html).toContain('class="month-end-swipe-arrow text-accent"');
		const luminance = (hex: string) => {
			const rgb = hex
				.match(/[\da-f]{2}/gi)
				?.map((value) => Number.parseInt(value, 16) / 255);
			if (rgb?.length !== 3) throw new Error(`Invalid color: ${hex}`);
			const channels = rgb.map((value) =>
				value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
			);
			return (
				0.2126 * (channels[0] ?? 0) +
				0.7152 * (channels[1] ?? 0) +
				0.0722 * (channels[2] ?? 0)
			);
		};
		const contrast = (a: string, b: string) => {
			const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
		};
		expect(contrast("#fbf8f2", "#0e0e0e")).toBeGreaterThanOrEqual(3);
		expect(contrast("#ae5534", "#0e0e0e")).toBeGreaterThanOrEqual(3);
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

	it("gives each chart its own deterministic scroll target", () => {
		const html = renderToString(
			<>
				<MonthEnd
					chartId="a"
					monthName="September"
					amountCents={0}
					rows={rows(6)}
				/>
				<MonthEnd
					chartId="b"
					monthName="October"
					amountCents={0}
					rows={rows(6)}
				/>
			</>,
		);
		const ids = [...html.matchAll(/id="([^"]*-chart-end)"/g)].map((m) => m[1]);
		const hrefs = [...html.matchAll(/href="#([^"]*-chart-end)"/g)].map(
			(m) => m[1],
		);
		expect(new Set(ids).size).toBe(2);
		expect(hrefs).toEqual(ids);
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
