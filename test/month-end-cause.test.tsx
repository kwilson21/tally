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
				/>
				<PastNotBudgeted
					id="sep-cause-not-budgeted"
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
			/>,
		);
		expect(html).not.toContain("Most of it");
		expect(html).not.toContain("Part of it");
		expect(html).not.toContain(">Over<");
	});
});
