/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { parseBudgetAmount } from "../src/budgets/amount";
import { BudgetSheet } from "../src/views/budget-sheet";

type Props = Parameters<typeof BudgetSheet>[0];

const base: Props = {
	category: {
		id: 1,
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		archived: false,
		budgetCents: 60000,
	},
	value: "600.00",
	spentCents: 41230,
	lastMonthCents: 57180,
	averageCents: 60245,
	transactionCount: 12,
	month: "2026-10",
	closeHref: "/?focus=1",
	closeAttrs: { "hx-get": "/?focus=1", "hx-push-url": "/" },
};
const render = (props: Partial<Props> = {}) =>
	String(BudgetSheet({ ...base, ...props }));

describe("BudgetSheet", () => {
	it("titles the sheet with the category and says what is spent this month", () => {
		const html = render();
		expect(html).toMatch(
			/<h2 id="budget-sheet-title"[^>]*tabindex="-1"[^>]*>Groceries<\/h2>/,
		);
		expect(html).toContain("$412.30 spent so far in October");
	});

	it("says a net refund in words, as Home's row does", () => {
		expect(render({ spentCents: -1500 })).toContain(
			"$15.00 more refunded than spent in October",
		);
	});

	it("links the counted transactions with their count", () => {
		const html = render({ transactionCount: 12 });
		expect(html).toContain("12 transactions");
		expect(html).toMatch(
			/<a href="\/transactions\?category=1&amp;month=2026-10&amp;show=spending"[^>]*>/,
		);
		expect(render({ transactionCount: 1 })).toContain("1 transaction");
	});

	it("draws the amount field with its label, value and the two chips", () => {
		const html = render();
		expect(html).toMatch(
			/<label for="budget"[^>]*>Budget from October on<\/label>/,
		);
		expect(html).toMatch(/<input[^>]*name="budget"[^>]*value="600.00"/);
		expect(html).toContain("Last month: $571.80");
		expect(html).toContain("3-month average: $602.45");
	});

	it("says a refused amount in role=alert and marks the field", () => {
		const refused = parseBudgetAmount("six hundred");
		expect(refused).toEqual({
			ok: false,
			error: "Enter a dollar amount, like 250 or 250.50.",
		});
		if (refused.ok) throw new Error("expected a refusal");
		const html = render({ value: "six hundred", error: refused.error });
		expect(html).toMatch(
			/<p id="budget-error" role="alert"[^>]*>Enter a dollar amount, like 250 or 250.50.<\/p>/,
		);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain('aria-describedby="budget-error"');
	});

	it("has no alert when the amount is fine", () => {
		const html = render();
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("aria-invalid");
	});

	it("is the contents only: the route's bottom sheet is the dialog", () => {
		expect(render()).not.toContain('role="dialog"');
	});

	it("closes with the links it is given, on Cancel", () => {
		expect(render()).toMatch(/<a[^>]*hx-get="\/\?focus=1"[^>]*>\s*Cancel/);
	});

	it("links Cancel to the sheet's close address, so it works without JavaScript", () => {
		expect(render({ closeHref: "/?focus=2" })).toMatch(
			/<a href="\/\?focus=2"[^>]*>\s*Cancel/,
		);
	});

	it("takes an id prefix, so the catalog can draw three sheets on one page", () => {
		const html = render({ id: "ds-budget-a" });
		expect(html).toContain('id="ds-budget-a-sheet-title"');
		expect(html).toMatch(/<input[^>]*id="ds-budget-a"[^>]*name="budget"/);
		expect(html).toContain('id="ds-budget-a-save"');
		expect(html).not.toContain('id="budget"');
	});
});
