import { describe, expect, it } from "vitest";
import {
	budgetExample,
	categorizationExample,
	exclusionsExample,
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

	it("includes bills set aside, so the sum still adds up once bills exist", () => {
		expect(
			budgetExample({
				totalBudgetCents: 245000,
				totalSpentCents: 116612,
				safeToSpendCents: 114188,
			}),
		).toBe(
			"$2,450.00 budget − $1,166.12 spent − $142.00 for bills due = $1,141.88 safe to spend.",
		);
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
	const none = {
		user: 0,
		merchantRule: 0,
		jev: 0,
		unsure: 0,
		noneFit: 0,
		notYetAsked: 0,
		income: 0,
	};

	it("counts transactions, not categories, and covers every source", () => {
		expect(
			categorizationExample({
				user: 1,
				merchantRule: 2,
				jev: 8,
				unsure: 3,
				noneFit: 1,
				notYetAsked: 4,
				income: 2,
			}),
		).toBe(
			"This month, Jev categorized 8 transactions. It left 3 it wasn't sure about and 1 that fit none of the categories for a person. 4 are waiting for tonight's run. 2 came from merchant rules. 1 was chosen by a person. 2 are income, which needs no category.",
		);
	});

	it("uses the singular for one income transaction", () => {
		expect(categorizationExample({ ...none, jev: 3, income: 1 })).toBe(
			"This month, Jev categorized 3 transactions. 1 is income, which needs no category.",
		);
	});

	it("names only the kinds of leftovers there are", () => {
		expect(categorizationExample({ ...none, jev: 5, noneFit: 2 })).toBe(
			"This month, Jev categorized 5 transactions. It left 2 that fit none of the categories for a person.",
		);
	});

	it("uses the singular for one", () => {
		expect(categorizationExample({ ...none, jev: 1, notYetAsked: 1 })).toBe(
			"This month, Jev categorized 1 transaction. 1 is waiting for tonight's run.",
		);
	});

	it("leaves out Jev when Jev hasn't categorized anything", () => {
		expect(categorizationExample({ ...none, user: 3 })).toBe(
			"This month, 3 were chosen by a person.",
		);
	});

	it("says so when there's nothing to show", () => {
		expect(categorizationExample(none)).toBe(
			"Nothing has been categorized yet this month.",
		);
	});
});

describe("exclusionsExample", () => {
	const none = { transfer: 0, reimbursement: 0, byPerson: 0 };

	it("counts this month's excluded transactions and names each kind", () => {
		expect(
			exclusionsExample({ transfer: 1, reimbursement: 1, byPerson: 1 }),
		).toBe(
			"This month, 3 transactions are excluded (1 transfer, 1 reimbursement and 1 excluded by a person), so they don't count toward spending or safe to spend.",
		);
		expect(exclusionsExample({ ...none, transfer: 2, byPerson: 3 })).toBe(
			"This month, 5 transactions are excluded (2 transfers and 3 excluded by a person), so they don't count toward spending or safe to spend.",
		);
		expect(exclusionsExample({ ...none, reimbursement: 1 })).toBe(
			"This month, 1 transaction is excluded (1 reimbursement), so it doesn't count toward spending or safe to spend.",
		);
		expect(exclusionsExample(none)).toBe("Nothing is excluded this month.");
	});
});
