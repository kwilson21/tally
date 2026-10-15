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

// Decision 115: with a Planned box, each box keeps the four-box size, and the row wraps where it doesn't fit.
describe("BudgetDiagram with a Planned box keeps each box at its size (decision 115)", () => {
	const planned = {
		totalBudgetCents: 140000,
		totalSpentCents: 46000,
		plannedCents: 18000,
		safeToSpendCents: 61800,
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

	it("draws today's single scaled picture when there is no Planned box", () => {
		const html = String(
			BudgetDiagram({
				totalBudgetCents: 140000,
				totalSpentCents: 46000,
				safeToSpendCents: 79800,
			}),
		);
		expect(html).toContain('viewBox="0 0 440 68"');
		expect(html).toContain('class="h-auto w-full max-w-md"');
		expect(html.match(/<svg/g)).toHaveLength(1);
		expect(html).not.toContain('aria-hidden="true"');
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
