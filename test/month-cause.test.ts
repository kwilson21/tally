import { describe, expect, it } from "vitest";
import { monthCause, monthCauses } from "../src/budgets/month-cause";

const budgeted = (name: string, budgetCents: number, spentCents: number) => ({
	name,
	budgetCents,
	spentCents,
});
const unbudgeted = (name: string, spentCents: number) => ({ name, spentCents });

describe("monthCauses", () => {
	it("takes the categories over budget by how far over, then the unbudgeted spending, each above $0", () => {
		const causes = monthCauses(
			[
				budgeted("Groceries", 70000, 67200),
				budgeted("Eating Out", 25000, 43000),
				budgeted("Kids", 30000, 32000),
			],
			[unbudgeted("Childcare", 96000), unbudgeted("Refunds", -5000)],
			0,
		);
		expect(causes).toEqual([
			{ name: "Eating Out", cents: 18000, kind: "over" },
			{ name: "Kids", cents: 2000, kind: "over" },
			{ name: "Childcare", cents: 96000, kind: "unbudgeted" },
		]);
	});

	it("adds Needs a category last only when the month's uncategorized money is above $0", () => {
		const rows = [budgeted("Eating Out", 25000, 43000)];
		expect(monthCauses(rows, [], 0)).toEqual([
			{ name: "Eating Out", cents: 18000, kind: "over" },
		]);
		expect(monthCauses(rows, [], -5000)).toEqual([
			{ name: "Eating Out", cents: 18000, kind: "over" },
		]);
		expect(monthCauses(rows, [], 27700)).toEqual([
			{ name: "Eating Out", cents: 18000, kind: "over" },
			{ name: "Needs a category", cents: 27700, kind: "uncategorized" },
		]);
	});

	it("ranks Needs a category by amount like any other cause, and a tie keeps Needs a category last", () => {
		expect(
			monthCause(
				monthCauses(
					[budgeted("Eating Out", 25000, 43000)],
					[unbudgeted("Childcare", 96000)],
					120000,
				),
				234000,
			)?.text,
		).toBe(
			"Most of it had no budget: Childcare $960 and Needs a category $1,200.",
		);
		expect(
			monthCause(monthCauses([], [unbudgeted("Rent", 120000)], 120000), 240000)
				?.text,
		).toBe(
			"Most of it had no budget: Rent $1,200 and Needs a category $1,200.",
		);
	});
});

describe("monthCause", () => {
	const sept = [
		{ name: "Childcare", cents: 96000, kind: "unbudgeted" as const },
		{ name: "Rent", cents: 120000, kind: "unbudgeted" as const },
	];

	it("says Most of it had no budget when the two largest are no-budget causes over half the overspend", () => {
		expect(monthCause(sept, 213447)).toEqual({
			text: "Most of it had no budget: Childcare $960 and Rent $1,200.",
			lead: "Most of it had no budget: ",
			named: [
				{ words: "Childcare $960", kind: "unbudgeted" },
				{ words: "Rent $1,200", kind: "unbudgeted" },
			],
		});
	});

	it("says Most of it was over budget when both causes are budgeted", () => {
		const causes = [
			{ name: "Eating Out", cents: 18000, kind: "over" as const },
			{ name: "Kids", cents: 4000, kind: "over" as const },
		];
		expect(monthCause(causes, 22000)).toEqual({
			text: "Most of it was over budget: Eating Out $180 and Kids $40.",
			lead: "Most of it was over budget: ",
			named: [
				{ words: "Eating Out $180", kind: "over" },
				{ words: "Kids $40", kind: "over" },
			],
		});
	});

	it("names each kind of cause in a mixed month, in the order the causes come", () => {
		const causes = [
			{ name: "Eating Out", cents: 18000, kind: "over" as const },
			{ name: "Rent", cents: 120000, kind: "unbudgeted" as const },
		];
		expect(monthCause(causes, 150000)).toEqual({
			text: "Most of it: Eating Out $180 over and Rent $1,200 with no budget.",
			lead: "Most of it: ",
			named: [
				{ words: "Eating Out $180 over", kind: "over" },
				{ words: "Rent $1,200 with no budget", kind: "unbudgeted" },
			],
		});
	});

	it("words a Needs a category cause as no budget, with its name, in both sentence shapes", () => {
		expect(
			monthCause(monthCauses([], [unbudgeted("Rent", 120000)], 27700), 147700)
				?.text,
		).toBe("Most of it had no budget: Rent $1,200 and Needs a category $277.");
		expect(
			monthCause(
				monthCauses([budgeted("Eating Out", 25000, 43000)], [], 27700),
				45700,
			)?.text,
		).toBe(
			"Most of it: Eating Out $180 over and Needs a category $277 with no budget.",
		);
	});

	it("says Most of it still needs a category when Needs a category is the only cause and over half the overspend", () => {
		expect(monthCause(monthCauses([], [], 27700), 27700)).toEqual({
			text: "Most of it still needs a category: $277.",
			lead: "Most of it still needs a category: ",
			named: [{ words: "$277", kind: "uncategorized" }],
		});
	});

	it("says Part of it still needs a category when Needs a category is under half the overspend", () => {
		expect(monthCause(monthCauses([], [], 27700), 60000)?.text).toBe(
			"Part of it still needs a category: $277.",
		);
	});

	it("counts exactly half of the overspend as under half for Needs a category alone", () => {
		expect(monthCause(monthCauses([], [], 27700), 55400)?.text).toBe(
			"Part of it still needs a category: $277.",
		);
	});

	it("keeps cents under $1 when Needs a category is the only cause", () => {
		expect(monthCause(monthCauses([], [], 40), 40)?.text).toBe(
			"Most of it still needs a category: $0.40.",
		);
	});

	it("names no cause for a refund under Needs a category", () => {
		expect(
			monthCause(
				[{ name: "Needs a category", cents: -5000, kind: "uncategorized" }],
				1000,
			),
		).toBeNull();
	});

	it("names one cause alone", () => {
		expect(
			monthCause(
				[{ name: "Rent", cents: 120000, kind: "unbudgeted" as const }],
				130000,
			),
		).toEqual({
			text: "Most of it had no budget: Rent $1,200.",
			lead: "Most of it had no budget: ",
			named: [{ words: "Rent $1,200", kind: "unbudgeted" }],
		});
	});

	it("drops Most of it when the two largest are not over half the overspend", () => {
		expect(monthCause(sept, 1000000)?.text).toBe(
			"Part of it had no budget: Childcare $960 and Rent $1,200.",
		);
	});

	it("counts exactly half as under half", () => {
		expect(monthCause(sept, 432000)?.text).toBe(
			"Part of it had no budget: Childcare $960 and Rent $1,200.",
		);
	});

	it("names only the two largest causes", () => {
		const causes = [
			{ name: "Eating Out", cents: 18000, kind: "over" as const },
			...sept,
		];
		expect(monthCause(causes, 213447)?.text).toBe(
			"Most of it had no budget: Childcare $960 and Rent $1,200.",
		);
	});

	it("gives no line for a month that ended under budget", () => {
		expect(monthCause(sept, 0)).toBeNull();
		expect(monthCause(sept, -100)).toBeNull();
	});

	it("gives no line when no cause can be named", () => {
		expect(monthCause([], 50000)).toBeNull();
	});

	it("keeps cents under $1, as MonthEnd does", () => {
		expect(
			monthCause(
				[{ name: "Snacks", cents: 40, kind: "unbudgeted" as const }],
				40,
			),
		).toEqual({
			text: "Most of it had no budget: Snacks $0.40.",
			lead: "Most of it had no budget: ",
			named: [{ words: "Snacks $0.40", kind: "unbudgeted" }],
		});
	});
});
