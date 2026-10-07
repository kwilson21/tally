/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { CategorySummary } from "../src/budget";
import appCss from "../src/styles/app.css?raw";
import { MonthEnd, PastNotBudgeted } from "../src/views/month-end";

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

	it.each([6, 9, 12])(
		"keeps the phone cue and only scrolls at lg when needed (%i)",
		(count) => {
			const html = renderToString(
				<MonthEnd
					chartId={count === 12 ? "twelve" : `n-${count}`}
					monthName="September"
					amountCents={0}
					rows={rows(count)}
				/>,
			);
			const wideCueHidden = count <= 10;
			const chart =
				html.match(
					/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
				)?.[0] ?? "";
			expect(html).toMatch(
				new RegExp(
					`role="region" tabindex="0" aria-label="${count} categories; scroll sideways to see them all" class="[^"]*overflow-x-auto[^"]*${wideCueHidden ? "lg:hidden" : ""}"`,
				),
			);
			expect(html).toContain(
				`aria-label="${count} categories; scroll sideways to see them all"`,
			);
			expect(html).toContain(
				`href="#${count === 12 ? "twelve" : `n-${count}`}-chart-end"`,
			);
			expect(html).toContain(
				`class="month-end-chart-fade${wideCueHidden ? " lg:hidden" : ""}"`,
			);
			expect(html).toContain(
				`class="month-end-chart-more inline-flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent${wideCueHidden ? " lg:hidden" : ""}"`,
			);
			expect(html).toMatch(
				new RegExp(
					`<p class="mt-1 flex items-center justify-center gap-2 text-sm text-muted${wideCueHidden ? " lg:hidden" : ""}">`,
				),
			);
			expect(html).toContain(`swipe sideways for the rest`);
			expect(html).toContain(
				`class="month-end-swipe-arrow month-end-swipe-arrow-left text-accent${wideCueHidden ? " lg:hidden" : ""}"`,
			);
			if (wideCueHidden) {
				expect(html).toContain('class="mt-4 hidden lg:block"');
				expect(html.match(/role="region"/g)).toHaveLength(1);
				expect(html).toContain(
					`class="month-end-swipe-arrow text-accent lg:hidden"`,
				);
			} else {
				expect(html).not.toContain("lg:hidden");
				expect(html).not.toContain('class="mt-4 hidden lg:block"');
			}
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
			if (count !== 12) return;
			expect(contrast("#fbf8f2", "#0e0e0e")).toBeGreaterThanOrEqual(3);
			expect(contrast("#ae5534", "#0e0e0e")).toBeGreaterThanOrEqual(3);
			expect(chart).toBeDefined();
			expect(chart).toContain('viewBox="0 0 799 142"');
			expect(chart).toContain('width="42"');
			expect(chart).toContain('<line x1="31" x2="799" y1="40" y2="40"');
			expect(chart).toContain('y="132"');
			const xs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map(
				(match) => Number(match[1]),
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
					[
						...chart.matchAll(/<text x="[\d.]+" y="132"[^>]*>(.*?)<\/text>/g),
					].map((m) => m[1]),
				).size,
			).toBe(12);
			expect(html).toContain("overflow-x-auto");
			expect(html).toContain("max-w-full");
			expect(chart).toContain('viewBox="0 0 799 142"');
			expect(chart).toContain('width="799"');
			const rectXs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map(
				(match) => Number(match[1]),
			);
			const lastBarEnd = Math.max(...rectXs) + 42;
			expect(799 - lastBarEnd).toBe(0);
			expect(html).toContain('id="twelve-chart-end"');
			expect(html.indexOf('id="twelve-chart-end"')).toBeGreaterThan(
				html.indexOf("</svg>"),
			);
			expect(html.indexOf('id="twelve-chart-end"')).toBeGreaterThan(
				html.indexOf('class="month-end-chart-tail"'),
			);
			expect(appCss).toContain("--month-end-chart-tail-width: calc(");
			expect(appCss).toMatch(
				/var\(--month-end-chart-fade-width\)\s*\+\s*var\(--month-end-chart-cue-size\)/,
			);
		},
	);

	it.each([
		[10, "$0.10"],
		[99, "$0.99"],
		[100, "$1"],
		[3650, "$36.50"],
	])(
		"keeps cents in a nonzero finished amount and bar overage (%i cents)",
		(cents, expected) => {
			const html = renderToString(
				<MonthEnd
					chartId="money"
					monthName="September"
					amountCents={-cents}
					rows={[
						{
							id: 1,
							name: "Category 1",
							spentCents: 10000 + cents,
							budgetCents: 10000,
							leftCents: -cents,
							over: true,
						},
					]}
				/>,
			);
			expect(html).toContain(`>${expected}</p>`);
			expect(html).toContain(`<title>+${expected}</title>`);
		},
	);

	it("keeps short category labels at their natural width", () => {
		const html = renderToString(
			<MonthEnd
				chartId="short"
				monthName="September"
				amountCents={0}
				rows={[
					{
						id: 1,
						name: "Short",
						budgetCents: 100,
						spentCents: 50,
						leftCents: 50,
						over: false,
					},
				]}
			/>,
		);
		const svg = html.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
		const category =
			svg.match(/<text[^>]*y="132"[^>]*>[\s\S]*?<\/text>/)?.[0] ?? "";
		expect(category).not.toContain("textLength=");
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

	it("caps long category and overage labels while preserving full accessible names", () => {
		const html = renderToString(
			<MonthEnd
				chartId="long"
				monthName="September"
				amountCents={0}
				rows={[
					{
						id: 1,
						name: "Supercalifragilisticexpialidocious",
						budgetCents: 100,
						spentCents: 1000100,
						leftCents: -1000000,
						over: true,
					},
					{
						id: 2,
						name: "Supercalifragilisticexpialidocious",
						budgetCents: 100,
						spentCents: 10000000,
						leftCents: -9999900,
						over: true,
					},
				]}
			/>,
		);
		const svg = html.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
		expect(svg).toContain('textLength="62" lengthAdjust="spacingAndGlyphs"');
		expect(svg).toContain("Supercalifragilisticexpialidocious");
		expect(svg).toContain("+$10,000");
		expect(svg).toContain("+$99,999");
		expect(svg).toContain("<title>Supercalifragilisticexpialidocious</title>");
		expect(svg).toContain("<title>+$99,999</title>");
		expect(svg).not.toContain(">Short</text>");
	});

	it("shows net refunds as positive in Not budgeted", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[
					{ name: "Café", icon: "list", color: "cat-blue", spentCents: -2000 },
				]}
			/>,
		);
		expect(html).toContain('class="text-right text-lg text-ok"');
		expect(html).toContain("+$20");
	});
});
