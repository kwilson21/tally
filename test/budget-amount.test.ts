import { describe, expect, it } from "vitest";
import { parseBudgetAmount } from "../src/budgets/amount";

describe("parseBudgetAmount (the Home budget sheet's one field)", () => {
	it.each([
		["650", 65000],
		["612.40", 61240],
		["$1,250.5", 125050],
		["0", 0],
		["1000000", 100_000_000],
	])("reads %j as %i cents", (text, cents) => {
		expect(parseBudgetAmount(text)).toEqual({ ok: true, cents });
	});

	it("needs an amount: a budget can't be removed yet", () => {
		expect(parseBudgetAmount("  ")).toEqual({
			ok: false,
			error: "Enter a dollar amount, like 250 or 250.50.",
		});
	});

	it("refuses anything that isn't dollars and cents", () => {
		for (const text of ["abc", "-5", "12.345", "1,00"]) {
			expect(parseBudgetAmount(text)).toEqual({
				ok: false,
				error: "Enter a dollar amount, like 250 or 250.50.",
			});
		}
	});

	it("caps a budget at $1,000,000 a month, so cents stay exact", () => {
		expect(parseBudgetAmount("1000000.01")).toEqual({
			ok: false,
			error: "Keep the budget to $1,000,000 a month or less.",
		});
	});
});
