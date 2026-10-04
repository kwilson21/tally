import { describe, expect, it } from "vitest";
import { billOccurrence } from "../src/bills/status";

describe("bill status", () => {
	it("clamps month ends and includes the seventh day", () => {
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 31 }, "2026-04-23", false),
		).toMatchObject({
			dueDate: "2026-04-30",
			period: "2026-04",
			status: "due",
		});
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 31 }, "2026-04-22", false)
				.status,
		).toBe("upcoming");
	});

	it("handles common and leap-year February", () => {
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 31 }, "2026-02-28", false)
				.dueDate,
		).toBe("2026-02-28");
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 31 }, "2028-02-29", false)
				.dueDate,
		).toBe("2028-02-29");
	});

	it("uses the anchor month and year period for yearly bills", () => {
		expect(
			billOccurrence(
				{ frequency: "yearly", dueDay: 15, anchorMonth: 10 },
				"2026-10-10",
				false,
			),
		).toEqual({ dueDate: "2026-10-15", period: "2026", status: "due" });
	});

	it("makes a linked occurrence paid before considering its date", () => {
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 1 }, "2026-10-20", true)
				.status,
		).toBe("paid");
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 19 }, "2026-10-20", false)
				.status,
		).toBe("overdue");
	});

	it("moves into the next month and year when it enters the seven-day window", () => {
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 1 }, "2026-09-28", false),
		).toMatchObject({
			dueDate: "2026-10-01",
			period: "2026-10",
			status: "due",
		});
		expect(
			billOccurrence({ frequency: "monthly", dueDay: 2 }, "2026-12-28", false),
		).toMatchObject({
			dueDate: "2027-01-02",
			period: "2027-01",
			status: "due",
		});
	});

	it("does not leave yearly bills overdue outside their anchor month", () => {
		expect(
			billOccurrence(
				{ frequency: "yearly", dueDay: 15, anchorMonth: 2 },
				"2026-10-04",
				false,
			),
		).toMatchObject({ dueDate: "2027-02-15", status: "upcoming" });
	});
});
