import { describe, expect, it } from "vitest";
import { parseUnpaidBills, unpaidBillsSentence } from "../src/bills/unpaid";

describe("unpaidBillsSentence", () => {
	it("says nothing when a split change unlinked no bill payment", () => {
		expect(unpaidBillsSentence([])).toBe("");
	});

	it("names a yearly bill's year, as the owner's example reads", () => {
		expect(
			unpaidBillsSentence([{ name: "Costco membership", period: "2026" }]),
		).toBe("The Costco membership bill for 2026 is no longer paid.");
	});

	it("names a monthly bill's month with its year", () => {
		expect(unpaidBillsSentence([{ name: "Water", period: "2026-09" }])).toBe(
			"The Water bill for September 2026 is no longer paid.",
		);
	});

	it("names a quarterly bill's quarter with its year", () => {
		expect(
			unpaidBillsSentence([{ name: "Insurance", period: "2026-Q3" }]),
		).toBe("The Insurance bill for Q3 2026 is no longer paid.");
	});

	it("names a weekly or every-two-weeks bill by its due date", () => {
		expect(
			unpaidBillsSentence([{ name: "Daycare", period: "2026-09-14" }]),
		).toBe("The Daycare bill for Sep 14, 2026 is no longer paid.");
	});

	it("counts two or more bill payments instead of naming them", () => {
		expect(
			unpaidBillsSentence([
				{ name: "Water", period: "2026-09" },
				{ name: "Costco membership", period: "2026" },
			]),
		).toBe("2 bills are no longer paid.");
	});
});

describe("parseUnpaidBills", () => {
	it("reads what a bank change stored", () => {
		expect(parseUnpaidBills('[{"name":"Water","period":"2026-09"}]')).toEqual([
			{ name: "Water", period: "2026-09" },
		]);
	});

	it("reads nothing from no stored value, an empty list or a damaged one", () => {
		expect(parseUnpaidBills(null)).toEqual([]);
		expect(parseUnpaidBills(undefined)).toEqual([]);
		expect(parseUnpaidBills("[]")).toEqual([]);
		expect(parseUnpaidBills("not json")).toEqual([]);
		expect(parseUnpaidBills('[{"name":1,"period":"2026"}]')).toEqual([]);
	});
});
