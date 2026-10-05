import { describe, expect, it } from "vitest";
import {
	budgetExample,
	categorizationExample,
	exclusionsExample,
	transactionsExample,
	trendsExample,
} from "../src/how-it-works/examples";
import type { MonthPoint, TrendRowData, TrendsPage } from "../src/trends";

describe("trendsExample", () => {
	const months = (cents: number[]): MonthPoint[] =>
		cents.map((c, i) => ({
			month: `2026-${String(5 + i).padStart(2, "0")}`,
			cents: c,
			partial: i === cents.length - 1,
		}));
	const row = (name: string, run: number, cents: number[]): TrendRowData => ({
		id: 1,
		name,
		icon: "list",
		color: "cat-blue",
		line: "",
		run,
		months: months(cents),
		label: "",
	});
	const full = (over: Partial<Extract<TrendsPage, { kind: "full" }>>) =>
		({
			kind: "full",
			monthName: "October",
			lastMonthName: "September",
			soFarCents: 124000,
			sentence: "",
			caption: "Oct 1–5 against Sep 1–5",
			sameDaysCents: { now: 124000, last: 133000 },
			changes: [],
			goingWell: [],
			worthALook: [],
			others: [],
			rangeLabel: "May to October",
			...over,
		}) satisfies TrendsPage;

	it("names the months a going-well category stayed under budget", () => {
		expect(
			trendsExample(
				full({
					goingWell: [row("Groceries", 3, [1, 1, 1, 1, 1, 1])],
				}),
			),
		).toBe(
			"Groceries stayed under its budget in July, August and September, so it's going well.",
		);
	});

	it("names the months a worth-a-look category rose through", () => {
		expect(
			trendsExample(
				full({
					worthALook: [row("Eating Out", 3, [1, 2, 3, 4, 5, 6])],
				}),
			),
		).toBe(
			"Eating Out spent more each month from June to September, so it's worth a look.",
		);
	});

	it("prefers the good news when there is some", () => {
		expect(
			trendsExample(
				full({
					goingWell: [row("Gas", 3, [1, 1, 1, 1, 1, 1])],
					worthALook: [row("Eating Out", 3, [1, 2, 3, 4, 5, 6])],
				}),
			),
		).toMatch(/^Gas stayed under/);
	});

	it("compares the two ranges when no category has a run", () => {
		expect(trendsExample(full({}))).toBe(
			"Oct 1–5: $1,240 spent, against $1,330 for Sep 1–5.",
		);
	});

	it("has none before there's a month to compare", () => {
		expect(trendsExample({ kind: "empty" })).toBeNull();
		expect(
			trendsExample({
				kind: "early",
				startMonthName: "September",
				months: [],
				label: "",
			}),
		).toBeNull();
	});
});

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
	it("says so plainly when nothing counts this month", () => {
		expect(transactionsExample({ counted: 0, needsCategory: 0 })).toBe(
			"No transaction counts this month yet.",
		);
	});

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
			categorizationExample(
				{
					user: 1,
					merchantRule: 2,
					jev: 8,
					unsure: 3,
					noneFit: 1,
					notYetAsked: 4,
					income: 2,
				},
				"Jev",
			),
		).toBe(
			"This month, Jev categorized 8 transactions. It left 3 it wasn't sure about and 1 that fit none of the categories for a person. 4 are waiting for tonight's run. 2 came from merchant rules. 1 was chosen by a person. 2 are income, which needs no category.",
		);
	});

	it("uses the singular for one income transaction", () => {
		expect(categorizationExample({ ...none, jev: 3, income: 1 }, "Jev")).toBe(
			"This month, Jev categorized 3 transactions. 1 is income, which needs no category.",
		);
	});

	it("names only the kinds of leftovers there are", () => {
		expect(categorizationExample({ ...none, jev: 5, noneFit: 2 }, "Jev")).toBe(
			"This month, Jev categorized 5 transactions. It left 2 that fit none of the categories for a person.",
		);
	});

	it("uses the singular for one", () => {
		expect(
			categorizationExample({ ...none, jev: 1, notYetAsked: 1 }, "Jev"),
		).toBe(
			"This month, Jev categorized 1 transaction. 1 is waiting for tonight's run.",
		);
	});

	it("leaves out Jev when Jev hasn't categorized anything", () => {
		expect(categorizationExample({ ...none, user: 3 })).toBe(
			"This month, 3 were chosen by a person.",
		);
	});

	it("says Tally instead of Jev when asked to", () => {
		expect(categorizationExample({ ...none, jev: 2, unsure: 1 }, "Tally")).toBe(
			"This month, Tally categorized 2 transactions. It left 1 it wasn't sure about for a person.",
		);
		expect(categorizationExample({ ...none, unsure: 1 }, "Tally")).toBe(
			"This month, Tally left 1 it wasn't sure about for a person.",
		);
	});

	it("says so when there's nothing to show", () => {
		expect(categorizationExample(none)).toBe(
			"Nothing has been categorized yet this month.",
		);
	});

	it("explains that held-for-review credits are omitted from spending", () => {
		expect(categorizationExample({ ...none, heldForReview: 1 })).toBe(
			"This month, 1 credit is held for review and doesn't count toward spending yet.",
		);
		expect(categorizationExample({ ...none, heldForReview: 2 })).toBe(
			"This month, 2 credits are held for review and don't count toward spending yet.",
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
