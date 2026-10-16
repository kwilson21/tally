/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import type { CategorySummary } from "../src/budget";
import appCss from "../src/styles/app.css?raw";
import { categoryRowAmount } from "../src/views/category-amount";
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
	it("keeps cents in the chart accessible name for tiny amounts", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="tiny"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={[
					{
						id: 1,
						name: "Dining",
						budgetCents: 0,
						spentCents: -30,
						leftCents: 30,
						over: false,
					},
				]}
			/>,
		);
		expect(html).toContain(
			'aria-label="Spent against each budget: Dining -$0.30 of $0"',
		);
	});

	it("keeps five categories in one row without the scrolling cue", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="five"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={rows(5)}
			/>,
		);
		expect(html).not.toContain('role="region"');
		expect(html).not.toContain("swipe sideways for the rest");
		expect(html).not.toContain("Show the rest of the categories");
		const chart = html.match(
			/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
		)?.[0];
		expect(chart).toContain(">budget</text>");
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
					needsCategoryCents={0}
					chartId={`n-${count}`}
					monthName="September"
					amountCents={0}
					unbudgeted={[]}
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
					needsCategoryCents={0}
					chartId={count === 12 ? "twelve" : `n-${count}`}
					monthName="September"
					amountCents={0}
					unbudgeted={[]}
					rows={rows(count)}
				/>,
			);
			const wideCueHidden = count <= 10;
			const chart =
				html.match(
					/<svg[^>]*aria-label="Spent against each budget:[\s\S]*?<\/svg>/,
				)?.[0] ?? "";
			if ([7, 12].includes(count)) expect(chart).toContain(">budget</text>");
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
			expect(chart).toContain('viewBox="0 0 843 142"');
			expect(chart).toContain('width="42"');
			expect(chart).toContain('<line x1="31" x2="843" y1="40" y2="40"');
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
			expect(chart).toContain('viewBox="0 0 843 142"');
			expect(chart).toContain('width="843"');
			const rectXs = [...(chart ?? "").matchAll(/<rect x="([\d.]+)"/g)].map(
				(match) => Number(match[1]),
			);
			const lastBarEnd = Math.max(...rectXs) + 42;
			expect(843 - lastBarEnd).toBe(44);
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

	it("labels every dashed budget line at five, seven, and twelve categories", () => {
		for (const count of [5, 7, 12]) {
			const html = renderToString(
				<MonthEnd
					needsCategoryCents={0}
					chartId={`budget-${count}`}
					monthName="September"
					amountCents={0}
					unbudgeted={[]}
					rows={rows(count)}
				/>,
			);
			const chart = html.match(/<svg[^>]*>[\s\S]*?<\/svg>/)?.[0] ?? "";
			expect(chart).toContain('stroke-dasharray="4 4"');
			expect(chart).toContain(">budget</text>");
		}
	});

	it.each([
		[-30, "+$0.30"],
		[-2000, "+$20"],
		[-2050, "+$20.50"],
		[30, "$0.30"],
		[0, "$0"],
	])("formats category row amount %i cents as %s", (cents, expected) => {
		expect(categoryRowAmount(cents).text).toBe(expected);
	});

	it.each([-2000, 0, 30])(
		"sets category row amount %i cents in tabular figures (decision 128)",
		(cents) => {
			expect(categoryRowAmount(cents).className.split(" ")).toContain(
				"tabular-nums",
			);
		},
	);

	it.each([
		[2553, "$26", 1240, "+$12"],
		[10, "$0.10", 40, "+$0.40"],
		[99, "$0.99", 99, "+$0.99"],
		[100, "$1", 100, "+$1"],
		[0, "$0", 100, "+$1"],
		[34040, "$340", 34040, "+$340"],
	])(
		"uses whole dollars except tiny amounts for headlines and overages (%i cents)",
		(cents, expected, overageCents, overage) => {
			const html = renderToString(
				<MonthEnd
					needsCategoryCents={0}
					chartId="money"
					monthName="September"
					amountCents={cents}
					unbudgeted={[]}
					rows={[
						{
							id: 1,
							name: "Category 1",
							spentCents: 10000 + overageCents,
							budgetCents: 10000,
							leftCents: -overageCents,
							over: true,
						},
					]}
				/>,
			);
			expect(html).toContain(`>${expected}</p>`);
			expect(html).toContain(`<title>${overage}</title>${overage}`);
			expect(html).toContain(`aria-label="Over budget by ${overage.slice(1)}"`);
		},
	);

	// Issue #519: a finished month with no budgeted category has no budget result to stamp, so it gets
	// neither Over nor Under; a month with a budget still stamps.
	it("is not stamped Over or Under when no category had a budget", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="no-budgets"
				monthName="September"
				amountCents={-5700}
				unbudgeted={[]}
				rows={[]}
			/>,
		);
		expect(html).toContain(">−$57</p>");
		expect(html).not.toContain(">$57</p>");
		expect(html).not.toMatch(/>(?:Over|Under)<span class="sr-only"> budget/);
		expect(html).not.toMatch(/text-6xl[^"]*text-over/);
	});

	it("still stamps Over when a budgeted category is overspent", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="budgeted-over"
				monthName="September"
				amountCents={-5700}
				unbudgeted={[]}
				rows={rows(1)}
			/>,
		);
		expect(html).toMatch(/>Over<span class="sr-only"> budget<\/span>/);
		expect(html).toContain(">$57</p>");
		expect(html).toMatch(/text-6xl[^"]*text-over/);
	});

	it("still stamps Under with the unsigned amount when a budgeted category is under", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="budgeted-under"
				monthName="September"
				amountCents={5700}
				unbudgeted={[]}
				rows={rows(1)}
			/>,
		);
		expect(html).toMatch(/>Under<span class="sr-only"> budget<\/span>/);
		expect(html).toContain(">$57</p>");
	});

	it("sizes a negative result with its minus sign counted, as #514 does (#519)", () => {
		const nine = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="nine"
				monthName="September"
				amountCents={-99999900}
				unbudgeted={[]}
				rows={[]}
			/>,
		);
		expect(nine).toContain(">−$999,999</p>");
		expect(nine).toContain("max-sm:text-5xl");
		const eight = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="eight"
				monthName="September"
				amountCents={-9999900}
				unbudgeted={[]}
				rows={[]}
			/>,
		);
		expect(eight).toContain(">−$99,999</p>");
		expect(eight).not.toContain("max-sm:text-5xl");
	});

	it("never shows negative zero", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="zero"
				monthName="September"
				amountCents={-1}
				unbudgeted={[]}
				rows={[]}
			/>,
		);
		expect(html).toContain(">−$0.01</p>");
		expect(html).not.toContain("-$0");
	});

	it("keeps short category labels at their natural width", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="short"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
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
					needsCategoryCents={0}
					chartId="a"
					monthName="September"
					amountCents={0}
					unbudgeted={[]}
					rows={rows(6)}
				/>
				<MonthEnd
					needsCategoryCents={0}
					chartId="b"
					monthName="October"
					amountCents={0}
					unbudgeted={[]}
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
				needsCategoryCents={0}
				chartId="long"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
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
		expect(html).toContain('class="text-right text-lg tabular-nums text-ok"');
		expect(html).toContain(
			'+$20<span class="sr-only"> back: refunds outweigh spending</span>',
		);
	});

	// #300: the wide copy of a chart with ten categories doesn't reserve the phone cue's 44px.
	it("gives a ten-category chart its phone width with the cue, and 667px in the wide copy without it (#300)", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="ten-wide"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={rows(10)}
			/>,
		);
		const svgs = [
			...html.matchAll(/<svg viewBox="0 0 (\d+) 142"(?: width="(\d+)")?/g),
		].map((match) => [match[1], match[2]]);
		expect(svgs).toEqual([
			["711", "711"],
			["667", "667"],
		]);
		const split = html.indexOf('class="mt-4 hidden lg:block"');
		const wide = html.slice(split);
		expect(wide).toContain('<line x1="31" x2="613" y1="40" y2="40"');
		expect(wide).toContain('<rect x="571"');
		expect(wide).toContain(
			'<text x="619" y="45" class="fill-muted text-sm">budget</text>',
		);
		expect(html.slice(0, split)).toContain(
			'<text x="707" y="45" text-anchor="end"',
		);
	});

	// #300: six to ten categories at lg. The wide copy stops at its last bar and keeps only the budget word's room.
	it.each([
		[6, 457, 66],
		[7, 523, 66],
		[8, 589, 66],
		[9, 655, 66],
		[10, 667, 60],
	])(
		"fits the wide copy of %i categories in %i units, with the budget word clear of the last bar (#300)",
		(count, width, step) => {
			const html = renderToString(
				<MonthEnd
					needsCategoryCents={0}
					chartId={`wide-${count}`}
					monthName="September"
					amountCents={0}
					unbudgeted={[]}
					rows={rows(count)}
				/>,
			);
			const wide = html.slice(html.indexOf('class="mt-4 hidden lg:block"'));
			const svg = wide.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? "";
			const rectXs = [...svg.matchAll(/<rect x="([\d.]+)"/g)].map((match) =>
				Number(match[1]),
			);
			const lastBarEnd = (rectXs[rectXs.length - 1] ?? 0) + 42;
			const wordX = Number(
				svg.match(/<text x="([\d.]+)" y="45"[^>]*>budget<\/text>/)?.[1],
			);
			expect(svg).toContain(`viewBox="0 0 ${width} 142"`);
			expect(width).toBeLessThanOrEqual(667);
			expect(
				rectXs.slice(1).map((x, index) => x - (rectXs[index] ?? x)),
			).toEqual(Array(count - 1).fill(step));
			expect(svg).toContain(`<line x1="31" x2="${lastBarEnd}" y1="40" y2="40"`);
			expect(wordX - lastBarEnd).toBeGreaterThanOrEqual(6);
			expect(wordX + 48).toBeLessThanOrEqual(width);
		},
	);

	it("caps the wide copy's labels at 56 for ten categories, and the phone copy's at 62 (#300)", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="ten-caps"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={rows(10)}
			/>,
		);
		const split = html.indexOf('class="mt-4 hidden lg:block"');
		const capsOf = (part: string) =>
			[...part.matchAll(/textLength="(\d+)"/g)].map((match) => match[1]);
		// Ten labels and ten overages, each capped.
		const phoneCaps = capsOf(html.slice(0, split));
		expect(phoneCaps).toHaveLength(20);
		expect(new Set(phoneCaps)).toEqual(new Set(["62"]));
		const wideCaps = capsOf(html.slice(split));
		expect(wideCaps).toHaveLength(20);
		expect(new Set(wideCaps)).toEqual(new Set(["56"]));
	});

	it("keeps the cue's 44px in every copy of a chart with eleven categories (#300)", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="eleven-wide"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={rows(11)}
			/>,
		);
		const svgs = [
			...html.matchAll(/<svg viewBox="0 0 (\d+) 142"(?: width="(\d+)")?/g),
		].map((match) => [match[1], match[2]]);
		expect(svgs).toEqual([["777", "777"]]);
	});

	it("leaves a chart of five categories at 350px with no cue width (#300)", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="five-wide"
				monthName="September"
				amountCents={0}
				unbudgeted={[]}
				rows={rows(5)}
			/>,
		);
		const svgs = [...html.matchAll(/<svg viewBox="0 0 (\d+) 142"( width=)?/g)];
		expect(svgs.map((match) => match[1])).toEqual(["350"]);
		expect(svgs[0]?.[2]).toBeUndefined();
	});

	// #311: a large result's stamp wraps under the amount instead of running past the page edge.
	it("lets the amount and its stamp wrap when a large result doesn't fit one line (#311)", () => {
		const html = renderToString(
			<MonthEnd
				needsCategoryCents={0}
				chartId="large"
				monthName="September"
				amountCents={100_000_000}
				unbudgeted={[]}
				rows={[]}
			/>,
		);
		const row = html.match(
			/<div class="([^"]*)"><p class="whitespace-nowrap font-serif text-6xl[^"]*">\$1,000,000<\/p>/,
		)?.[1];
		expect(row).toBeDefined();
		expect(row?.split(" ")).toContain("flex-wrap");
		expect(row).not.toContain("nowrap");
	});
});

// #310: a finished month's uncategorized spending is named once, at the end of Not budgeted.
describe("PastNotBudgeted's Needs a category row", () => {
	// The Needs a category row is the list's last item.
	const needsRow = (html: string) => {
		const start = html.lastIndexOf("<li ");
		return html.slice(start, html.indexOf("</li>", start) + "</li>".length);
	};

	it("ends the Not budgeted list with the uncategorized amount, drawn like the rows above", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[
					{ name: "Kids", icon: "kids", color: "cat-ochre", spentCents: 3000 },
				]}
				needsCategory={{ spentCents: 5000, count: 1 }}
			/>,
		);
		const row = needsRow(html);
		expect(row).toContain('<span class="shrink-0 text-muted">');
		expect(row).toContain(
			'<span class="min-w-0 flex-1 truncate text-lg">Needs a category</span>',
		);
		expect(row).toContain(
			'<span class="text-right text-lg tabular-nums">$50</span>',
		);
		expect(row).not.toContain("<a");
		expect(row).not.toContain("href");
		expect(html.indexOf("Needs a category")).toBeGreaterThan(
			html.indexOf(">Kids<"),
		);
	});

	it("reads net refunds as +$ in green, as the rows above do", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[]}
				needsCategory={{ spentCents: -1400, count: 1 }}
			/>,
		);
		expect(html).toContain(
			'<span class="text-right text-lg tabular-nums text-ok">+$14<span class="sr-only"> back: refunds outweigh spending</span></span>',
		);
	});

	it("says refunds in words only for a refund, not for spending or the $0 row", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[
					{ name: "Kids", icon: "kids", color: "cat-ochre", spentCents: 3000 },
				]}
				needsCategory={{ spentCents: 5000, count: 1 }}
			/>,
		);
		expect(needsRow(html)).not.toContain("refunds outweigh");
		expect(html).not.toContain("refunds outweigh");
		expect(
			renderToString(
				<PastNotBudgeted
					items={[]}
					needsCategory={{ spentCents: 0, count: 2 }}
				/>,
			),
		).not.toContain("refunds outweigh");
	});

	it("shows the Not budgeted heading with just this row when no category is Not budgeted", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[]}
				needsCategory={{ spentCents: 5000, count: 2 }}
			/>,
		);
		expect(html).toContain(
			'<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>',
		);
		expect(html.match(/<li /g)).toHaveLength(1);
		expect(html).toContain("Needs a category");
	});

	it("shows nothing when the month has no uncategorized money", () => {
		expect(
			renderToString(
				<PastNotBudgeted
					items={[]}
					needsCategory={{ spentCents: 0, count: 0 }}
				/>,
			),
		).toBe("");
		expect(renderToString(<PastNotBudgeted items={[]} />)).toBe("");
	});

	it("keeps a $0 row when uncategorized transactions net to $0, so they stay named", () => {
		const html = renderToString(
			<PastNotBudgeted
				items={[]}
				needsCategory={{ spentCents: 0, count: 2 }}
			/>,
		);
		expect(html).toContain(
			'<span class="text-right text-lg tabular-nums">$0</span>',
		);
	});
});
