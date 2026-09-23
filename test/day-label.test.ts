import { describe, expect, it } from "vitest";
import { dayLabel, monthLabel } from "../src/dates";

describe("dayLabel", () => {
	it("names today and formats other days as 'Mon D'", () => {
		expect(dayLabel("2026-09-22", "2026-09-22")).toBe("Today, Sep 22");
		expect(dayLabel("2026-09-21", "2026-09-22")).toBe("Sep 21");
		expect(dayLabel("2026-01-05", "2026-09-22")).toBe("Jan 5");
	});

	it("adds the year for other years", () => {
		expect(dayLabel("2025-12-31", "2026-01-02")).toBe("Dec 31, 2025");
	});
});

describe("monthLabel", () => {
	it("adds the year only for other years", () => {
		expect(monthLabel("2026-09", "2026-09-22")).toBe("September");
		expect(monthLabel("2025-12", "2026-01-02")).toBe("December 2025");
	});
});
