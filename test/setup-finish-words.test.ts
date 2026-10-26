import { describe, expect, it } from "vitest";
import {
	FINISH_HEADING,
	finishBillsLine,
	finishBudgetsLine,
	finishLead,
	finishPayLine,
	finishSavingsLine,
	SORTS_LINE,
	safeToSpendIn,
} from "../src/first-tally/finish";
import { FINISH_STEP } from "../src/views/step-bar";

// The setup finish's words (P142 A, decision 148, spec §8.8, #774): every line the finish screen shows, worded from the same
// helpers as the pay, bills and budgets steps, so each amount reads exactly as the step that set it does.

const EVERY_OTHER_FRIDAY = [
	"2026-07-17",
	"2026-07-31",
	"2026-08-14",
	"2026-08-28",
	"2026-09-11",
	"2026-09-25",
	"2026-10-09",
].map((date) => ({ date, cents: 245000 }));

describe("the finish's heading and fixed lines", () => {
	it("says You're set up. as the heading", () => {
		expect(FINISH_HEADING).toBe("You're set up.");
	});

	it("names the step bar's last step Setup done", () => {
		expect(FINISH_STEP).toBe("Setup done");
	});

	it("says what Tally does from now on, as the bank sends it", () => {
		expect(SORTS_LINE).toBe(
			"From now on Tally sorts new transactions as your bank sends them.",
		);
	});
});

describe("safeToSpendIn", () => {
	it("names the month the number is Safe to spend in", () => {
		expect(safeToSpendIn("2026-10")).toBe("Safe to spend in October");
		expect(safeToSpendIn("2026-01")).toBe("Safe to spend in January");
	});
});

describe("finishLead", () => {
	it("says what is left of the month's budgets after spending, bills and savings", () => {
		expect(finishLead("2026-10")).toBe(
			"What's left of October's budgets after what you've spent, the bills still to pay and your savings.",
		);
	});
});

describe("finishPayLine", () => {
	it("gives the merchant, its amount and its cadence, with the words' dot", () => {
		expect(
			finishPayLine({ name: "ACME Corp", deposits: EVERY_OTHER_FRIDAY }),
		).toBe("ACME Corp · $2,450 every other Friday");
	});

	it("gives the range and no cadence when the amounts vary on irregular dates", () => {
		expect(
			finishPayLine({
				name: "ACME Corp",
				deposits: [
					{ date: "2026-07-03", cents: 230000 },
					{ date: "2026-08-21", cents: 260000 },
					{ date: "2026-10-02", cents: 255000 },
				],
			}),
		).toBe("ACME Corp · $2,300 to $2,600");
	});

	it("gives a single deposit's amount with no cadence", () => {
		expect(
			finishPayLine({
				name: "ACME Corp",
				deposits: [{ date: "2026-10-09", cents: 245000 }],
			}),
		).toBe("ACME Corp · $2,450");
	});

	it("keeps cents from the deposits, through dollarsWords", () => {
		expect(
			finishPayLine({
				name: "ACME Corp",
				deposits: EVERY_OTHER_FRIDAY.map((deposit) => ({
					...deposit,
					cents: 245050,
				})),
			}),
		).toBe("ACME Corp · $2,450.50 every other Friday");
	});
});

describe("finishBillsLine", () => {
	it("counts the bills and gives their monthly total in whole dollars", () => {
		expect(finishBillsLine(8, 124000)).toBe("8 bills · $1,240 a month");
	});

	it("uses the singular for one bill", () => {
		expect(finishBillsLine(1, 1500)).toBe("1 bill · $15 a month");
	});

	it("keeps the cents of a total that has some, unchanged", () => {
		expect(finishBillsLine(8, 124050)).toBe("8 bills · $1,240.50 a month");
	});
});

describe("finishBudgetsLine", () => {
	it("counts the budgets and gives their monthly total", () => {
		expect(finishBudgetsLine(12, 405000)).toBe("12 budgets · $4,050 a month");
	});

	it("uses the singular for one budget", () => {
		expect(finishBudgetsLine(1, 65000)).toBe("1 budget · $650 a month");
	});

	it("keeps the cents of a total that has some, unchanged", () => {
		expect(finishBudgetsLine(12, 405025)).toBe(
			"12 budgets · $4,050.25 a month",
		);
	});
});

describe("finishSavingsLine", () => {
	it("gives the monthly savings goal in whole dollars", () => {
		expect(finishSavingsLine(15000)).toBe("$150 a month");
	});

	it("keeps the cents of a goal that has some, unchanged", () => {
		expect(finishSavingsLine(15050)).toBe("$150.50 a month");
	});
});
