import { describe, expect, it } from "vitest";
import { daysBefore, monthName, shortDay, todayUtc } from "../src/dates";

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

describe("shortDay", () => {
	it.each([
		["2026-09-05", "2026-09-26", "Sep 5"],
		["2026-09-26", "2026-09-26", "Sep 26"],
		["2025-12-31", "2026-01-04", "Dec 31, 2025"],
	])("%s beside %s is %s", (date, beside, label) =>
		expect(shortDay(date, beside)).toBe(label),
	);
});

describe("daysBefore", () => {
	it.each([
		["2026-10-04", 5, "2026-09-29"],
		["2026-10-04", 30, "2026-09-04"],
		["2026-03-01", 1, "2026-02-28"],
		["2028-03-01", 1, "2028-02-29"],
		["2026-01-03", 5, "2025-12-29"],
	])("%s minus %i days is %s", (date, days, result) =>
		expect(daysBefore(date, days)).toBe(result),
	);
});
