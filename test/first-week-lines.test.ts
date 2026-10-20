import { describe, expect, it } from "vitest";
import type { FirstTally } from "../src/db/first-tally";
import { doneNote, type FirstWeekNames } from "../src/first-tally/setup";

// What each drawn stroke did, in one plain line (spec §9 item 1): the words Your first week shows beside the stroke's day.
// Pure over the record and the names, so each input kind is tested without a database.

const names: FirstWeekNames = {
	bankName: "Chase",
	merchants: { "ACME CORP": "Acme Corp", "HARBOR PAY": "Harbor Pay" },
};
const EMPTY: FirstTally = { strokes: {}, budgets: {} };
const yes = (cents: number, at: number) => ({
	yes: { "1": { date: "2026-10-03", cents } },
	at,
});
const no = (at: number) => ({
	no: { "9": { date: "2026-10-01", cents: 100 } },
	at,
});

describe("doneNote: the bank's line", () => {
	it("names the first connected bank", () => {
		expect(doneNote("bank", EMPTY, names)).toBe("Chase, linked");
	});

	it("says Your bank when no bank name is known", () => {
		expect(doneNote("bank", EMPTY, { ...names, bankName: null })).toBe(
			"Your bank, linked",
		);
	});
});

describe("doneNote: the pay line", () => {
	it("says no paycheck found with no pay record at all", () => {
		expect(doneNote("pay", EMPTY, names)).toBe("no paycheck found");
	});

	it("says no paycheck kept when every merchant was answered No", () => {
		expect(
			doneNote("pay", { ...EMPTY, pay: { "HARBOR PAY": no(0) } }, names),
		).toBe("no paycheck kept");
	});

	it("names the one merchant answered Yes, by its display name", () => {
		expect(
			doneNote(
				"pay",
				{ ...EMPTY, pay: { "ACME CORP": yes(245000, 0) } },
				names,
			),
		).toBe("Acme Corp");
	});

	it("names the first Yes merchant in the order answered, counts the rest, and leaves out a No", () => {
		const pay = {
			"ACME CORP": yes(245000, 1),
			"HARBOR PAY": { ...yes(1000, 0) },
			"OTHER NO": no(2),
		};
		expect(
			doneNote(
				"pay",
				{ ...EMPTY, pay },
				{ ...names, merchants: { ...names.merchants, "OTHER NO": "Other" } },
			),
		).toBe("Harbor Pay and 1 more");
	});
});

describe("doneNote: the bills line", () => {
	it("says none kept with no bills record", () => {
		expect(doneNote("bills", EMPTY, names)).toBe("none kept");
	});

	it("says how many bills were kept, and 1 kept for one (#714)", () => {
		expect(
			doneNote("bills", { ...EMPTY, bills: { kept: 8, cents: 206200 } }, names),
		).toBe("8 kept");
		expect(
			doneNote("bills", { ...EMPTY, bills: { kept: 1, cents: 1600 } }, names),
		).toBe("1 kept");
	});

	it("says none kept when the bills step kept none", () => {
		expect(
			doneNote("bills", { ...EMPTY, bills: { kept: 0, cents: 0 } }, names),
		).toBe("none kept");
	});
});

describe("doneNote: the budgets line", () => {
	it("says no budgets to set when the step asked nothing", () => {
		expect(doneNote("budgets", EMPTY, names)).toBe("no budgets to set");
	});

	it("counts the answers that set an amount, and leaves out a skip", () => {
		const budgets: FirstTally["budgets"] = {
			"1": { kind: "suggested", cents: 65000 },
			"2": { kind: "skipped", cents: null },
			"3": { kind: "another", cents: 40000 },
		};
		expect(doneNote("budgets", { ...EMPTY, budgets }, names)).toBe("2 budgets");
	});

	it("counts twelve budgets the same way", () => {
		const budgets: FirstTally["budgets"] = {};
		for (let id = 1; id <= 12; id++) {
			budgets[String(id)] = { kind: "suggested", cents: 10000 };
		}
		expect(doneNote("budgets", { ...EMPTY, budgets }, names)).toBe(
			"12 budgets",
		);
	});

	it("says 1 budget for one", () => {
		expect(
			doneNote(
				"budgets",
				{ ...EMPTY, budgets: { "1": { kind: "suggested", cents: 100 } } },
				names,
			),
		).toBe("1 budget");
	});
});

describe("doneNote: the count line", () => {
	it("says the night's transactions, all sorted, when none needs a person", () => {
		expect(
			doneNote("count", { ...EMPTY, night: { brought: 3, needYou: 0 } }, names),
		).toBe("3 new transactions, all sorted");
	});

	it("says no new transactions on a quiet night, in the fifth day's words", () => {
		expect(
			doneNote("count", { ...EMPTY, night: { brought: 0, needYou: 0 } }, names),
		).toBe("no new transactions, all sorted");
	});

	it("says how many need a person, with a comma, and 1 needs you for one", () => {
		expect(
			doneNote("count", { ...EMPTY, night: { brought: 3, needYou: 1 } }, names),
		).toBe("3 new transactions, 1 needs you");
	});

	it("groups a large count with commas", () => {
		expect(
			doneNote(
				"count",
				{ ...EMPTY, night: { brought: 1234, needYou: 2 } },
				names,
			),
		).toBe("1,234 new transactions, 2 need you");
	});

	it("has no line with no night kept", () => {
		expect(doneNote("count", EMPTY, names)).toBeNull();
	});
});

describe("doneNote: the savings part of the budgets line (#721)", () => {
	const twelve: FirstTally["budgets"] = {};
	for (let id = 1; id <= 12; id++) {
		twelve[String(id)] = { kind: "suggested", cents: 10000 };
	}

	it("adds the kept goal to the budgets words: 12 budgets, saving $300 a month", () => {
		expect(
			doneNote("budgets", { ...EMPTY, budgets: twelve, savings: 30000 }, names),
		).toBe("12 budgets, saving $300 a month");
	});

	it("adds it to no budgets to set too", () => {
		expect(doneNote("budgets", { ...EMPTY, savings: 30000 }, names)).toBe(
			"no budgets to set, saving $300 a month",
		);
	});

	it("keeps the cents of a goal that has them", () => {
		expect(doneNote("budgets", { ...EMPTY, savings: 30050 }, names)).toBe(
			"no budgets to set, saving $300.50 a month",
		);
	});

	it("adds nothing for a skip, or before the question is answered", () => {
		expect(doneNote("budgets", { ...EMPTY, savings: "skipped" }, names)).toBe(
			"no budgets to set",
		);
		expect(doneNote("budgets", EMPTY, names)).toBe("no budgets to set");
	});
});
