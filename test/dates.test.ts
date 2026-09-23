import { describe, expect, it } from "vitest";
import { monthName, todayUtc } from "../src/dates";

describe("monthName", () => {
	it.each([
		["2026-09", "September"],
		["2027-01", "January"],
		["2026-12", "December"],
	])("%s is %s", (month, name) => expect(monthName(month)).toBe(name));
});

describe("todayUtc", () => {
	it("is a YYYY-MM-DD string", () => {
		expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
