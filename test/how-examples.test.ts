import { describe, expect, it } from "vitest";
import {
	budgetExample,
	categorizationExample,
	transactionsExample,
} from "../src/how-it-works/examples";

describe("budgetExample", () => {
	it("shows budget − spent = safe to spend in exact cents, so the sum always adds up", () => {
		expect(
			budgetExample({
				totalBudgetCents: 245000,
				totalSpentCents: 116612,
				safeToSpendCents: 128388,
			}),
		).toBe("$2,450.00 budget − $1,166.12 spent = $1,283.88 safe to spend.");
	});

	it("shows a negative result plainly when spending is over the budget", () => {
		expect(
			budgetExample({
				totalBudgetCents: 100000,
				totalSpentCents: 125000,
				safeToSpendCents: -25000,
			}),
		).toBe("$1,000.00 budget − $1,250.00 spent = -$250.00 safe to spend.");
	});
});

describe("transactionsExample", () => {
	it("counts this month's transactions and the ones needing a category", () => {
		expect(transactionsExample({ counted: 125, needsCategory: 12 })).toBe(
			"This month has 125 counted transactions, and 12 need a category.",
		);
	});

	it("uses the singular for one", () => {
		expect(transactionsExample({ counted: 1, needsCategory: 1 })).toBe(
			"This month has 1 counted transaction, and 1 needs a category.",
		);
	});

	it("says when nothing needs a category", () => {
		expect(transactionsExample({ counted: 40, needsCategory: 0 })).toBe(
			"This month has 40 counted transactions, and every one has a category.",
		);
	});
});

describe("categorizationExample", () => {
	it("names each source with a nonzero count", () => {
		expect(
			categorizationExample({ user: 1, merchantRule: 2, jev: 8, unsure: 4 }),
		).toBe(
			"This month, Jev picked 8 categories on its own and left 4 it wasn't sure about for a person. 2 came from merchant rules. 1 was chosen by a person.",
		);
	});

	it("leaves out Jev when Jev hasn't picked anything", () => {
		expect(
			categorizationExample({ user: 3, merchantRule: 0, jev: 0, unsure: 0 }),
		).toBe("This month, 3 were chosen by a person.");
	});

	it("says so when there's nothing to show", () => {
		expect(
			categorizationExample({ user: 0, merchantRule: 0, jev: 0, unsure: 0 }),
		).toBe("Nothing has been categorized yet this month.");
	});
});
