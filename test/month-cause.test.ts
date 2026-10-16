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
		);
		expect(causes).toEqual([
			{ name: "Eating Out", cents: 18000, budgeted: true },
			{ name: "Kids", cents: 2000, budgeted: true },
			{ name: "Childcare", cents: 96000, budgeted: false },
		]);
	});
});

describe("monthCause", () => {
	const sept = [
		{ name: "Childcare", cents: 96000, budgeted: false },
		{ name: "Rent", cents: 120000, budgeted: false },
	];

	it("says Most of it had no budget when the two largest are no-budget causes over half the overspend", () => {
		expect(monthCause(sept, 213447)).toEqual({
			text: "Most of it had no budget: Childcare $960 and Rent $1,200.",
			toNotBudgeted: true,
		});
	});

	it("says Most of it was over budget when both causes are budgeted", () => {
		const causes = [
			{ name: "Eating Out", cents: 18000, budgeted: true },
			{ name: "Kids", cents: 4000, budgeted: true },
		];
		expect(monthCause(causes, 22000)).toEqual({
			text: "Most of it was over budget: Eating Out $180 and Kids $40.",
			toNotBudgeted: false,
		});
	});

	it("names each kind of cause in a mixed month, in the order the causes come", () => {
		const causes = [
			{ name: "Eating Out", cents: 18000, budgeted: true },
			{ name: "Rent", cents: 120000, budgeted: false },
		];
		expect(monthCause(causes, 150000)).toEqual({
			text: "Most of it: Eating Out $180 over and Rent $1,200 with no budget.",
			toNotBudgeted: true,
		});
	});

	it("names one cause alone", () => {
		expect(
			monthCause([{ name: "Rent", cents: 120000, budgeted: false }], 130000),
		).toEqual({
			text: "Most of it had no budget: Rent $1,200.",
			toNotBudgeted: true,
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
			{ name: "Eating Out", cents: 18000, budgeted: true },
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
			monthCause([{ name: "Snacks", cents: 40, budgeted: false }], 40),
		).toEqual({
			text: "Most of it had no budget: Snacks $0.40.",
			toNotBudgeted: true,
		});
	});
});
