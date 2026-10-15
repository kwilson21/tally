/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { BudgetDiagram } from "../src/views/how-diagrams";

// The worked example on How Tally works (decision 82, #202): $1,400 budget − $460 spent − $142 bills due − $180 planned
// = $618 safe to spend. Bills due is what's left after the plan is taken out, not the plan itself.
describe("BudgetDiagram with a planned expense", () => {
	it("takes the plan out of Bills due and draws it as its own box", () => {
		const html = String(
			BudgetDiagram({
				totalBudgetCents: 140000,
				totalSpentCents: 46000,
				safeToSpendCents: 61800,
				plannedCents: 18000,
			}),
		);
		expect(html).toContain("minus $142.00 for bills due");
		expect(html).toContain("minus $180.00 for planned expenses");
		expect(html).toContain(">Bills due<");
		expect(html).toContain(">Planned<");
		expect(html).toContain("$142.00");
		expect(html).toContain("$180.00");
	});

	it("draws no Planned box or phrase when no plan is set aside", () => {
		const html = String(
			BudgetDiagram({
				totalBudgetCents: 140000,
				totalSpentCents: 46000,
				safeToSpendCents: 79800,
			}),
		);
		expect(html).toContain("minus $142.00 for bills due");
		expect(html).not.toContain("planned expenses");
		expect(html).not.toContain(">Planned<");
	});
});

/** The widths of the units on each line when a row wraps in a column this wide, as flex-wrap lays them out. */
const wrapLines = (widths: number[], column: number) =>
	widths.reduce<number[][]>((lines, width) => {
		const last = lines.at(-1);
		const used = last?.reduce((sum, w) => sum + w, 0) ?? 0;
		if (last && used + width <= column) last.push(width);
		else lines.push([width]);
		return lines;
	}, []);

// Decision 115, extended by #600: every Budget box keeps its size, with or without a Planned box or a savings goal, and the row
// wraps where it doesn't fit: one row at 1280 (a 768 px column), and at 390 (a 350 px column) a line after Bills due.
describe("BudgetDiagram keeps each box at its size and wraps on every screen (decision 115, extended by #600)", () => {
	const planned = {
		totalBudgetCents: 140000,
		totalSpentCents: 46000,
		plannedCents: 18000,
		safeToSpendCents: 61800,
	};
	const plain = {
		totalBudgetCents: 140000,
		totalSpentCents: 46000,
		safeToSpendCents: 79800,
	};
	const savings = {
		totalBudgetCents: 140000,
		totalSpentCents: 46000,
		savingsGoalCents: 50000,
		safeToSpendCents: 29800,
	};
	/** Each box's own drawing, in order: an SVG that is aria-hidden, because the wrapper is the one labelled picture. */
	const unitSvgs = (html: string) =>
		[...html.matchAll(/<svg aria-hidden="true"[\s\S]*?<\/svg>/g)].map(
			(found) => found[0],
		);
	const openTag = (svg: string) => svg.match(/^<svg[^>]*>/)?.[0] ?? "";
	const widthOf = (svg: string) =>
		Number(openTag(svg).match(/ width="(\d+)"/)?.[1]);
	const text = (html: string) =>
		html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	const desc = (html: string) =>
		html.match(/<span id="[^"]*-desc"[^>]*>([^<]+)</)?.[1] ?? "";

	it("draws the five boxes as units of their own, 93 wide for Budget and 115 with their operators, 68 tall", () => {
		const svgs = unitSvgs(String(BudgetDiagram(planned)));
		expect(svgs.map(widthOf)).toEqual([93, 115, 115, 115, 115]);
		for (const svg of svgs) {
			expect(openTag(svg)).toContain('height="68"');
			expect(openTag(svg)).toContain('class="shrink-0"');
			expect(svg).toMatch(/<rect x="\d+" y="4" width="93" height="60"/);
			expect(svg).toContain('font-size="13"');
		}
	});

	it("draws six units with a savings goal, in one labelled picture with a wrapping row", () => {
		const html = String(
			BudgetDiagram({
				...planned,
				savingsGoalCents: 5000,
				safeToSpendCents: 56800,
			}),
		);
		expect(unitSvgs(html).map(widthOf)).toEqual([93, 115, 115, 115, 115, 115]);
		expect(html.match(/role="img"/g)).toHaveLength(1);
		const wrapper = html.match(/<div role="img"[^>]*>/)?.[0] ?? "";
		expect(wrapper).toMatch(/class="[^"]*\bflex-wrap\b/);
		expect(wrapper).toContain('aria-labelledby="budget-diagram-title"');
		expect(wrapper).toContain('aria-describedby="budget-diagram-desc"');
		expect(html).toContain(">How safe to spend is worked out<");
	});

	it("keeps the description sentence and the amounts in words", () => {
		const html = String(BudgetDiagram(planned));
		expect(desc(html)).toBe(
			"The $1,400.00 budget minus $460.00 spent minus $142.00 for bills due minus $180.00 for planned expenses leaves $618.00 safe to spend.",
		);
		expect(text(html)).toContain(
			"Budget $1,400.00 − Spent $460.00 − Bills due $142.00 − Planned $180.00 = Safe to spend $618.00",
		);
	});

	it("draws the safe-to-spend unit in red when it is negative", () => {
		const html = String(
			BudgetDiagram({
				...planned,
				totalSpentCents: 170000,
				safeToSpendCents: -5000,
			}),
		);
		expect(html).toContain("stroke-over");
		expect(html).not.toContain("stroke-ok");
	});

	it("draws the four boxes as units too, with no Planned box, in one labelled picture", () => {
		const html = String(BudgetDiagram(plain));
		expect(unitSvgs(html).map(widthOf)).toEqual([93, 115, 115, 115]);
		// Four drawings of their own and no single picture scaled to a width: nothing is shrunk to fit.
		expect(html.match(/<svg/g)).toHaveLength(4);
		expect(html).not.toContain("max-w-md");
		expect(html.match(/role="img"/g)).toHaveLength(1);
		expect(html.match(/<div role="img"[^>]*>/)?.[0]).toMatch(
			/class="[^"]*\bflex-wrap\b/,
		);
		expect(text(html)).toContain(
			"Budget $1,400.00 − Spent $460.00 − Bills due $142.00 = Safe to spend $798.00",
		);
		expect(desc(html)).toBe(
			"The $1,400.00 budget minus $460.00 spent minus $142.00 for bills due leaves $798.00 safe to spend.",
		);
	});

	it("draws the savings-only diagram as five units, with the same description as before", () => {
		const html = String(BudgetDiagram(savings));
		expect(unitSvgs(html).map(widthOf)).toEqual([93, 115, 115, 115, 115]);
		expect(html.match(/role="img"/g)).toHaveLength(1);
		expect(desc(html)).toBe(
			"The $1,400.00 budget minus $460.00 spent minus $142.00 for bills due minus $500.00 for the savings goal leaves $298.00 safe to spend.",
		);
	});

	it("puts each of the four, five and six boxes on one row at 1280 (a 768 px column) and wraps them at 390 (350 px)", () => {
		const cases: [string, string, number[]][] = [
			["four", String(BudgetDiagram(plain)), [93, 115, 115, 115]],
			[
				"five with a savings goal",
				String(BudgetDiagram(savings)),
				[93, 115, 115, 115, 115],
			],
			[
				"five with a planned expense",
				String(BudgetDiagram(planned)),
				[93, 115, 115, 115, 115],
			],
			[
				"six with both",
				String(
					BudgetDiagram({
						...planned,
						savingsGoalCents: 5000,
						safeToSpendCents: 56800,
					}),
				),
				[93, 115, 115, 115, 115, 115],
			],
		];
		for (const [name, html, widths] of cases) {
			expect(unitSvgs(html).map(widthOf), name).toEqual(widths);
			expect(wrapLines(widths, 768).length, name).toBe(1);
			expect(wrapLines(widths, 350).length, name).toBeGreaterThan(1);
		}
		// Four boxes at 390 put "= Safe to spend" alone on line 2; six put Planned, Savings goal and Safe to spend there.
		expect(wrapLines([93, 115, 115, 115], 350)).toEqual([
			[93, 115, 115],
			[115],
		]);
		expect(wrapLines([93, 115, 115, 115, 115, 115], 350)).toEqual([
			[93, 115, 115],
			[115, 115, 115],
		]);
	});

	it("keeps every box inside the narrowest column, 280 px at 320, so nothing scrolls sideways", () => {
		for (const html of [
			String(BudgetDiagram(plain)),
			String(BudgetDiagram(planned)),
		]) {
			for (const svg of unitSvgs(html))
				expect(widthOf(svg)).toBeLessThanOrEqual(280);
		}
	});

	it("gives two diagrams with different ids no duplicate id attribute", () => {
		const first = String(BudgetDiagram({ ...planned, id: "budget-a" }));
		const second = String(
			BudgetDiagram({
				totalBudgetCents: 140000,
				totalSpentCents: 46000,
				safeToSpendCents: 79800,
				id: "budget-b",
			}),
		);
		const ids = [...`${first}${second}`.matchAll(/ id="([^"]+)"/g)].map(
			(found) => found[1],
		);
		expect(ids).toEqual([
			"budget-a-title",
			"budget-a-desc",
			"budget-b-title",
			"budget-b-desc",
		]);
	});
});
