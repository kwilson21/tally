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
