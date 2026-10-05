/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { MonthPoint } from "../src/trends";
import { MonthBars, TrendRow } from "../src/views/trends";

const months: MonthPoint[] = [
	{
		month: "2026-09",
		cents: 26000,
		partial: false,
		part: { from: "2026-09-12" },
	},
	{ month: "2026-10", cents: 3000, partial: true },
];
const label =
	"All spending by month: September (from Sep 12) $260, October so far $30.";

describe("MonthBars", () => {
	const html = String(<MonthBars id="ds-a" months={months} label={label} />);

	it("stripes the part month, the first month of history, with a diagonal pattern in tokens", () => {
		expect(html).toContain('<pattern id="ds-a-part"');
		expect(html).toContain('patternTransform="rotate(45)"');
		// The pattern's two colours are the paper and the bar's ink.
		const pattern = html.match(/<pattern[\s\S]*?<\/pattern>/)?.[0] ?? "";
		expect(pattern).toContain("fill-paper");
		expect(pattern).toContain("fill-ink");
		// Only that bar uses it.
		expect(html.match(/fill="url\(#ds-a-part\)"/g)).toHaveLength(1);
		const first = html.match(/<rect[^>]*fill="url\(#ds-a-part\)"[^>]*>/)?.[0];
		expect(first).toContain("stroke-ink");
		expect(first).not.toContain("stroke-dasharray");
	});

	it("leaves the month still going a dashed outline and the finished months solid", () => {
		expect(html.match(/stroke-dasharray="3 3"/g)).toHaveLength(1);
		const solid = String(
			<MonthBars
				id="ds-b"
				months={[
					{ month: "2026-08", cents: 100, partial: false },
					{ month: "2026-09", cents: 200, partial: false },
					{ month: "2026-10", cents: 50, partial: true },
				]}
				label="x"
			/>,
		);
		expect(solid).not.toContain("<pattern");
		expect(solid).not.toContain("url(#");
	});

	it("is one image whose text alternative says it's a part month", () => {
		expect(html).toContain('role="img"');
		expect(html).toContain(`aria-label="${label}"`);
	});

	it("uses attributes, never a style attribute (the CSP forbids them)", () => {
		expect(html).not.toMatch(/\sstyle=/);
	});

	it("gives its pattern the id it's given, so two charts on a page don't share one", () => {
		const other = String(<MonthBars id="ds-b" months={months} label={label} />);
		expect(other).toContain('<pattern id="ds-b-part"');
		expect(other).not.toContain("ds-a-part");
	});
});

describe("TrendRow", () => {
	const props = {
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		line: "Up 3 months running",
		months: [{ month: "2026-10", cents: 100, partial: true }],
		label: "Spending by month: October so far $1.",
	};

	it("shows a muted second line under the row's line when it has a note", () => {
		const html = String(<TrendRow {...props} note="Still under budget" />);
		expect(html).toContain(
			'<span class="block leading-6 text-muted">Up 3 months running</span><span class="block leading-6 text-muted">Still under budget</span>',
		);
	});

	it("has no second line without a note", () => {
		const html = String(<TrendRow {...props} note={null} />);
		expect(html).not.toContain("Still under budget");
		expect(html.match(/block leading-6 text-muted/g)).toHaveLength(1);
		expect(String(<TrendRow {...props} />)).toBe(html);
	});
});
