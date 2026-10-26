import { describe, expect, it } from "vitest";
import {
	skippedBills,
	skippedBudgets,
	skippedPay,
} from "../src/first-tally/skipped";

// A setup step with nothing to ask says so on the next screen (P142 A, #773): a skipped note names the step, says why in
// today's words, and counts what waits in Possible bills.

describe("skippedPay", () => {
	it("says Tally didn't spot a paycheck, with nothing waiting", () => {
		expect(skippedPay()).toEqual({
			step: "Your pay",
			text: "Tally didn't spot a paycheck. You can mark one from any transaction later.",
			waiting: 0,
		});
	});
});

describe("skippedBills", () => {
	it("says there is nothing to keep in one tap, and counts what waits", () => {
		expect(skippedBills(2)).toEqual({
			step: "Your bills",
			text: "Nothing here to keep in one tap.",
			waiting: 2,
		});
	});

	it("waits for nothing when no charge waits either", () => {
		expect(skippedBills(0).waiting).toBe(0);
	});
});

describe("skippedBudgets", () => {
	it("says why the budgets step asked nothing, from the reason", () => {
		expect(skippedBudgets("every-category-budgeted")).toEqual({
			step: "Your budgets",
			text: "Every category already has a budget.",
			waiting: 0,
		});
		expect(skippedBudgets("no-categories")).toEqual({
			step: "Your budgets",
			text: "No categories to budget yet.",
			waiting: 0,
		});
	});
});
