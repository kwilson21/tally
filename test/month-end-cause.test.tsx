/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import { MonthEnd, PastNotBudgeted } from "../src/views/month-end";

const row = (name: string, budgetCents: number, spentCents: number) => ({
	id: name.length,
	name,
	budgetCents,
	spentCents,
	leftCents: budgetCents - spentCents,
	over: spentCents > budgetCents,
});

describe("MonthEnd cause line", () => {
	it("names the no-budget causes under the stamp, linked to the Not budgeted list", () => {
		const html = renderToString(
			<>
				<MonthEnd
					chartId="sep-cause"
					monthName="September"
					amountCents={-231200}
					rows={[
						row("Groceries", 70000, 67200),
						row("Eating Out", 25000, 43000),
					]}
					unbudgeted={[
						{ name: "Childcare", spentCents: 96000 },
						{ name: "Rent", spentCents: 120000 },
					]}
					needsCategoryCents={0}
				/>
				<PastNotBudgeted
					chartId="sep-cause"
					items={[
						{
							name: "Childcare",
							icon: "kids",
							color: "cat-blue",
							spentCents: 96000,
						},
						{
							name: "Rent",
							icon: "rent",
							color: "cat-slate",
							spentCents: 120000,
						},
					]}
				/>
			</>,
		);
		expect(html).toMatch(
			/<a href="#sep-cause-not-budgeted"[^>]*>Most of it had no budget: Childcare \$960 and Rent \$1,200\.<\/a>/,
		);
		expect(html).toContain('<h3 id="sep-cause-not-budgeted"');
		expect(html.indexOf("Most of it")).toBeLessThan(html.indexOf("<svg"));
	});

	it("links an over-budget-only cause to the bars", () => {
		const html = renderToString(
			<MonthEnd
				chartId="sep-bars"
				monthName="September"
				amountCents={-22000}
				rows={[row("Eating Out", 25000, 43000), row("Kids", 30000, 34000)]}
				unbudgeted={[]}
				needsCategoryCents={0}
			/>,
		);
		expect(html).toMatch(
			/<a href="#sep-bars-bars"[^>]*>Most of it was over budget: Eating Out \$180 and Kids \$40\.<\/a>/,
		);
		expect(html).toContain('<div id="sep-bars-bars"');
	});

	it("gives a month that ended under budget no cause line", () => {
		const html = renderToString(
			<MonthEnd
				chartId="may"
				monthName="May"
				amountCents={31000}
				rows={[row("Eating Out", 25000, 26000)]}
				unbudgeted={[{ name: "Rent", spentCents: 120000 }]}
				needsCategoryCents={0}
			/>,
		);
		expect(html).not.toContain("Most of it");
		expect(html).not.toContain("Part of it");
		expect(html).not.toContain('href="#may-');
	});

	it("gives no cause line and no stamp for a month with no budget", () => {
		const html = renderToString(
			<MonthEnd
				chartId="april"
				monthName="April"
				amountCents={-120000}
				rows={[]}
				unbudgeted={[{ name: "Rent", spentCents: 120000 }]}
				needsCategoryCents={0}
			/>,
		);
		expect(html).not.toContain("Most of it");
		expect(html).not.toContain("Part of it");
		expect(html).not.toContain(">Over<");
	});

	it("links each named cause to its own place when the kinds differ: the bars for over, the Not budgeted heading for no budget", () => {
		const html = renderToString(
			<MonthEnd
				chartId="X"
				monthName="September"
				amountCents={-138000}
				rows={[row("Eating Out", 25000, 43000)]}
				unbudgeted={[{ name: "Rent", spentCents: 120000 }]}
				needsCategoryCents={0}
			/>,
		);
		expect(html).toMatch(
			/<p class="mt-2 text-muted">Most of it: <a href="#X-bars"[^>]*>Eating Out \$180 over<\/a> and <a href="#X-not-budgeted"[^>]*>Rent \$1,200 with no budget<\/a>\.<\/p>/,
		);
	});

	it("links Rent and Needs a category to two places, the Not budgeted heading and the Needs a category row", () => {
		const html = renderToString(
			<MonthEnd
				chartId="X"
				monthName="September"
				amountCents={-144900}
				rows={[row("Groceries", 70000, 67200)]}
				unbudgeted={[{ name: "Rent", spentCents: 120000 }]}
				needsCategoryCents={27700}
			/>,
		);
		expect(html).toMatch(
			/<p class="mt-2 text-muted">Most of it had no budget: <a href="#X-not-budgeted"[^>]*>Rent \$1,200<\/a> and <a href="#X-needs-category"[^>]*>Needs a category \$277<\/a>\.<\/p>/,
		);
	});

	it("keeps one whole-line link for a sentence whose causes are all over budget", () => {
		const html = renderToString(
			<MonthEnd
				chartId="X"
				monthName="September"
				amountCents={-22000}
				rows={[row("Eating Out", 25000, 43000), row("Kids", 30000, 34000)]}
				unbudgeted={[]}
				needsCategoryCents={0}
			/>,
		);
		expect(
			html.match(/<p class="mt-2 text-muted"><a href="#X-bars"/g),
		).toHaveLength(1);
	});
});

describe("PastNotBudgeted with a chart id", () => {
	it("gives the Not budgeted heading and the Needs a category row their ids", () => {
		const html = renderToString(
			<PastNotBudgeted
				chartId="X"
				items={[]}
				needsCategory={{ spentCents: 27700, count: 1 }}
			/>,
		);
		expect(html).toContain('<h3 id="X-not-budgeted"');
		expect(html).toMatch(/<li id="X-needs-category" class="[^"]*">/);
	});
});
