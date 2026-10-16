import { describe, expect, it } from "vitest";
import { calculateBillTotals } from "../src/bills/totals";

// Decision 122 (#602, P136 A): each status heading's total counts every occurrence of its group in the month, listed as a
// row or not, and `unlisted` says which occurrences it counts that no row lists (the words Bills names under the heading).

const bill = (
	id: number,
	amountCents: number,
	frequency: "monthly" | "weekly" = "monthly",
) => ({ id, amountCents, frequency, active: true });

const occurrence = (
	billId: number,
	dueDate: string,
	status: "paid" | "due" | "overdue" | "upcoming",
	amountCents: number,
) => ({
	billId,
	dueDate,
	status,
	amountCents,
	paidCents: status === "paid" ? amountCents : 0,
});

describe("each heading counts every occurrence of its group, listed or not (decision 122)", () => {
	it("counts a weekly bill's two paid Fridays in Paid this month, and names them as unlisted", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(8, 24000, "weekly")],
			displayedOccurrences: [occurrence(8, "2026-10-16", "due", 24000)],
			thisMonthOccurrences: [
				occurrence(8, "2026-10-02", "paid", 24000),
				occurrence(8, "2026-10-09", "paid", 24000),
				occurrence(8, "2026-10-16", "due", 24000),
				occurrence(8, "2026-10-23", "upcoming", 24000),
				occurrence(8, "2026-10-30", "upcoming", 24000),
			],
		});
		expect(totals.groups.paidCents).toBe(48000);
		expect(totals.groups.upcomingCents).toBe(48000);
		expect(totals.groups.dueCents).toBe(24000);
		expect(totals.unlisted.paid).toEqual([
			{ billId: 8, dueDate: "2026-10-02" },
			{ billId: 8, dueDate: "2026-10-09" },
		]);
		expect(totals.unlisted.upcoming).toEqual([
			{ billId: 8, dueDate: "2026-10-23" },
			{ billId: 8, dueDate: "2026-10-30" },
		]);
		expect(totals.unlisted.due).toEqual([]);
		expect(totals.unlisted.overdue).toEqual([]);
	});

	it("names no occurrence when every one a heading counts is a row", () => {
		const paid = occurrence(3, "2026-10-15", "paid", 299);
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(3, 299)],
			displayedOccurrences: [paid],
			thisMonthOccurrences: [paid],
		});
		expect(totals.groups.paidCents).toBe(299);
		expect(totals.unlisted.paid).toEqual([]);
	});

	it("counts a paid occurrence once when it is both the shown row and this month's list", () => {
		const paid = occurrence(8, "2026-10-09", "paid", 24000);
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(8, 24000, "weekly")],
			displayedOccurrences: [paid],
			thisMonthOccurrences: [paid],
		});
		expect(totals.groups.paidCents).toBe(24000);
		expect(totals.unlisted.paid).toEqual([]);
	});

	it("does not count an unlisted paid occurrence due next month in Paid this month (decision 127)", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(8, 24000, "weekly")],
			displayedOccurrences: [occurrence(8, "2026-10-16", "due", 24000)],
			thisMonthOccurrences: [occurrence(8, "2026-11-06", "paid", 24000)],
		});
		expect(totals.groups.paidCents).toBe(0);
		expect(totals.unlisted.paid).toEqual([]);
	});

	it("counts every unlisted paid occurrence due this month, whenever it was paid (decision 127)", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(8, 24000, "weekly")],
			displayedOccurrences: [occurrence(8, "2026-10-16", "due", 24000)],
			thisMonthOccurrences: [
				occurrence(8, "2026-10-02", "paid", 24000),
				occurrence(8, "2026-10-09", "paid", 24000),
			],
		});
		expect(totals.groups.paidCents).toBe(48000);
		expect(totals.unlisted.paid).toEqual([
			{ billId: 8, dueDate: "2026-10-02" },
			{ billId: 8, dueDate: "2026-10-09" },
		]);
	});

	it("counts a listed paid row at its full amount, so the row and the total agree (decision 127)", () => {
		const paid = occurrence(10, "2026-10-01", "paid", 10000);
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(10, 10000)],
			displayedOccurrences: [paid],
			thisMonthOccurrences: [paid],
		});
		expect(totals.groups.paidCents).toBe(10000);
		expect(totals.unlisted.paid).toEqual([]);
	});

	it("counts a listed paid row due next month, as Bills lists it (decision 127)", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(10, 10000)],
			displayedOccurrences: [occurrence(10, "2026-11-01", "paid", 10000)],
			thisMonthOccurrences: [],
		});
		expect(totals.groups.paidCents).toBe(10000);
		expect(totals.unlisted.paid).toEqual([]);
	});

	it("counts a monthly bill's paid occurrence this month when its row already shows next month", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(10, 10000)],
			displayedOccurrences: [occurrence(10, "2026-11-01", "upcoming", 10000)],
			thisMonthOccurrences: [occurrence(10, "2026-10-01", "paid", 10000)],
		});
		expect(totals.groups.paidCents).toBe(10000);
		expect(totals.unlisted.paid).toEqual([
			{ billId: 10, dueDate: "2026-10-01" },
		]);
		expect(totals.groups.upcomingCents).toBe(0);
	});

	it("names an unpaid Friday behind the shown one as unlisted under Overdue", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(8, 24000, "weekly")],
			displayedOccurrences: [occurrence(8, "2026-10-16", "due", 24000)],
			thisMonthOccurrences: [
				occurrence(8, "2026-10-09", "overdue", 24000),
				occurrence(8, "2026-10-16", "due", 24000),
			],
		});
		expect(totals.groups.overdueCents).toBe(24000);
		expect(totals.unlisted.overdue).toEqual([
			{ billId: 8, dueDate: "2026-10-09" },
		]);
		expect(totals.unlisted.due).toEqual([]);
	});
});

describe("a monthly bill's handed-off unpaid occurrence stays in Overdue until the next one is due (decision 122)", () => {
	const rent = (
		thisMonth: ReturnType<typeof occurrence>[],
		displayedStatus: "due" | "upcoming" = "due",
	) =>
		calculateBillTotals({
			month: "2026-10",
			bills: [bill(10, 120000)],
			displayedOccurrences: [
				occurrence(10, "2026-11-01", displayedStatus, 120000),
			],
			thisMonthOccurrences: thisMonth,
		});

	it("counts the unpaid Oct 1 in Overdue and names it, while To pay soon stays as it was", () => {
		const totals = rent([occurrence(10, "2026-10-01", "overdue", 120000)]);
		expect(totals.groups.overdueCents).toBe(120000);
		expect(totals.unlisted.overdue).toEqual([
			{ billId: 10, dueDate: "2026-10-01" },
		]);
		expect(totals.groups.dueCents).toBe(120000);
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(120000);
		expect(totals.setAsideCents).toBe(120000);
	});

	it("counts only what is left of a part-paid Oct 1 in Overdue", () => {
		const partPaid = {
			...occurrence(10, "2026-10-01", "overdue", 120000),
			paidCents: 60000,
		};
		const totals = rent([partPaid]);
		expect(totals.groups.overdueCents).toBe(60000);
		expect(totals.unlisted.overdue).toEqual([
			{ billId: 10, dueDate: "2026-10-01" },
		]);
	});

	it("counts a monthly bill's upcoming occurrence of this month in Upcoming, unlisted, and not in To pay soon", () => {
		const totals = rent(
			[occurrence(10, "2026-10-28", "upcoming", 120000)],
			"upcoming",
		);
		expect(totals.groups.upcomingCents).toBe(120000);
		expect(totals.unlisted.upcoming).toEqual([
			{ billId: 10, dueDate: "2026-10-28" },
		]);
		expect(totals.soonCount).toBe(0);
	});
});
