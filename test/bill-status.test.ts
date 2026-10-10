import { describe, expect, it } from "vitest";
import { billOccurrence, billOccurrenceForMonth } from "../src/bills/status";
import { BillRow, billStatusLine } from "../src/views/bill-row";

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
			billOccurrence(
				{ frequency: "monthly", dueDay: 31 },
				"2026-04-22",
				new Set(["2026-03"]),
			).status,
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

	it("keys each weekly occurrence by its due date", () => {
		const bill = { frequency: "weekly", dueDay: 5 } as const;
		expect(
			[2, 9, 16, 23, 30].map((day) =>
				billOccurrence(bill, `2026-10-${String(day).padStart(2, "0")}`, false),
			),
		).toEqual(
			[2, 9, 16, 23, 30].map((day) => ({
				dueDate: `2026-10-${String(day).padStart(2, "0")}`,
				period: `2026-10-${String(day).padStart(2, "0")}`,
				status: "due",
			})),
		);
	});

	it("counts biweekly occurrences from its anchor date", () => {
		expect(
			billOccurrence(
				{ frequency: "biweekly", dueDay: 5, anchorDate: "2026-10-02" },
				"2026-10-16",
				false,
			),
		).toMatchObject({ dueDate: "2026-10-16", period: "2026-10-16" });
	});

	it("keys quarterly occurrences by calendar quarter", () => {
		expect(
			billOccurrenceForMonth(
				{ frequency: "quarterly", dueDay: 15, anchorMonth: 11 },
				2026,
				11,
			),
		).toEqual({ dueDate: "2026-11-15", period: "2026-Q4" });
	});

	it("keeps weekly missed occurrences set aside until paid, then drops an earlier month", () => {
		const bill = { frequency: "weekly", dueDay: 5 } as const;
		expect(billOccurrence(bill, "2026-10-12", false)).toMatchObject({
			dueDate: "2026-10-09",
			status: "overdue",
		});
		expect(
			billOccurrence(bill, "2026-10-12", new Set(["2026-10-09"])),
		).toMatchObject({ dueDate: "2026-10-16", status: "due" });
		// Still this month: the missed Friday stays overdue, whatever day of the month it is.
		expect(billOccurrence(bill, "2026-10-31", false)).toMatchObject({
			dueDate: "2026-10-30",
			status: "overdue",
		});
		// Next month: Oct 30 is last month's, so it is not the one shown (it reads Not paid on the page),
		// and the next Friday takes its place.
		expect(billOccurrence(bill, "2026-11-02", false)).toMatchObject({
			dueDate: "2026-11-06",
			status: "due",
		});
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

	describe("a missed bill stays overdue until paid or the next one is due (decision 62)", () => {
		const monthly28 = { frequency: "monthly", dueDay: 28 } as const;
		it("keeps last month's missed bill overdue into this month", () => {
			expect(billOccurrence(monthly28, "2026-10-08", false)).toMatchObject({
				dueDate: "2026-09-28",
				status: "overdue",
			});
			expect(billOccurrence(monthly28, "2026-10-20", false)).toMatchObject({
				dueDate: "2026-09-28",
				status: "overdue",
			});
		});
		it("lets the next one take its place once it is due", () => {
			expect(billOccurrence(monthly28, "2026-10-21", false)).toMatchObject({
				dueDate: "2026-10-28",
				status: "due",
			});
		});
		it("shows last month's paid bill as the next upcoming one", () => {
			expect(
				billOccurrence(monthly28, "2026-10-08", new Set(["2026-09"])),
			).toMatchObject({ dueDate: "2026-10-28", status: "upcoming" });
		});
		it("keeps this month's bill paid until the next one is due", () => {
			const bill = { frequency: "monthly", dueDay: 2 } as const;
			expect(
				billOccurrence(bill, "2026-10-20", new Set(["2026-10"])),
			).toMatchObject({ dueDate: "2026-10-02", status: "paid" });
			expect(
				billOccurrence(bill, "2026-10-28", new Set(["2026-10"])),
			).toMatchObject({ dueDate: "2026-11-02", status: "due" });
			expect(billOccurrence(bill, "2026-10-28", false)).toMatchObject({
				dueDate: "2026-11-02",
				status: "due",
			});
		});
		it("applies the same seven-day handoff to quarterly bills", () => {
			const bill = {
				frequency: "quarterly",
				dueDay: 15,
				anchorMonth: 1,
			} as const;
			// The hand-off boundary: Apr 15 is still overdue on Jul 7, and Jul 15 is due on Jul 8.
			expect(billOccurrence(bill, "2026-07-07", false)).toMatchObject({
				dueDate: "2026-04-15",
				status: "overdue",
			});
			expect(billOccurrence(bill, "2026-07-08", false)).toMatchObject({
				dueDate: "2026-07-15",
				status: "due",
			});
		});
		it("applies the same rule to yearly bills", () => {
			const bill = { frequency: "yearly", dueDay: 15, anchorMonth: 2 } as const;
			expect(billOccurrence(bill, "2026-10-04", false)).toMatchObject({
				dueDate: "2026-02-15",
				status: "overdue",
			});
			expect(
				billOccurrence(bill, "2026-10-04", new Set(["2026"])),
			).toMatchObject({ dueDate: "2027-02-15", status: "upcoming" });
			expect(
				billOccurrence(bill, "2026-02-20", new Set(["2026"])),
			).toMatchObject({ dueDate: "2026-02-15", status: "paid" });
			expect(billOccurrence(bill, "2027-02-10", false)).toMatchObject({
				dueDate: "2027-02-15",
				status: "due",
			});
		});
	});
});

describe("billStatusLine", () => {
	const bill = {
		id: 1,
		name: "Streaming",
		amountCents: 1549,
		icon: "household",
		color: "cat-brown",
	};
	const today = "2026-10-05";

	it("keeps today lower case in the middle of a sentence", () => {
		expect(
			billStatusLine(
				{
					...bill,
					status: "paid",
					dueDate: "2026-10-05",
					paidDate: "2026-10-05",
				},
				today,
			),
		).toBe("Paid today, Oct 5");
		expect(
			billStatusLine(
				{
					...bill,
					status: "paid",
					dueDate: "2026-10-02",
					paidDate: "2026-10-05",
				},
				today,
			),
		).toBe("Paid today, Oct 5, 3 days late");
		expect(
			billStatusLine({ ...bill, status: "due", dueDate: "2026-10-05" }, today),
		).toBe("Due today, Oct 5");
	});

	it("leaves other days as they were", () => {
		expect(
			billStatusLine({ ...bill, status: "due", dueDate: "2026-10-08" }, today),
		).toBe("Due Oct 8");
		expect(
			billStatusLine(
				{ ...bill, status: "overdue", dueDate: "2026-10-02" },
				today,
			),
		).toBe("Was due Oct 2");
	});
});

describe("BillRow cadence", () => {
	const daycare = {
		id: 8,
		name: "Daycare",
		amountCents: 24000,
		status: "due" as const,
		dueDate: "2026-10-09",
		icon: "kids",
		color: "cat-ochre",
	};
	const rowText = (
		frequency: "weekly" | "biweekly" | "quarterly" | "monthly",
		dueDay: number,
	) =>
		String(
			BillRow({
				bill: { ...daycare, frequency, dueDay },
				today: "2026-10-05",
			}),
		);

	it("adds the weekday after the status sentence for a weekly bill", () => {
		expect(rowText("weekly", 5)).toContain("Due Oct 9 · every Friday");
	});

	it("adds the interval for a bill every two weeks", () => {
		expect(rowText("biweekly", 5)).toContain("Due Oct 9 · every two weeks");
	});

	it("leaves a quarterly or monthly row's status sentence as it is", () => {
		expect(rowText("quarterly", 9)).not.toContain("every 3 months");
		expect(rowText("monthly", 9)).not.toContain("· every");
	});
});
