import { describe, expect, it } from "vitest";
import { calculateBillTotals } from "../src/bills/totals";

const bill = (
	amountCents: number,
	frequency:
		| "monthly"
		| "yearly"
		| "weekly"
		| "biweekly"
		| "quarterly" = "monthly",
	active = true,
) => ({ id: amountCents, amountCents, frequency, active });

describe("bill totals", () => {
	it.each([
		[54000, "yearly", 4500],
		[24000, "weekly", 104000],
		[11000, "biweekly", 23833],
		[18600, "quarterly", 6200],
	] as const)(
		"uses the drawn monthly share for %s cents %s",
		(amountCents, frequency, expected) => {
			expect(
				calculateBillTotals({
					month: "2026-10",
					bills: [bill(amountCents, frequency)],
					occurrences: [],
				}).monthlyCents,
			).toBe(expected);
		},
	);

	it("counts overdue unpaid bills in still to pay and excludes a yearly bill due in March", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(5000), { ...bill(12000, "yearly"), id: 2 }],
			occurrences: [
				{
					billId: 5000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 5000,
					paidCents: 0,
				},
				{
					billId: 2,
					dueDate: "2027-03-01",
					status: "upcoming",
					amountCents: 12000,
					paidCents: 0,
				},
			],
		});
		expect(totals.stillToPayCents).toBe(5000);
	});

	it("counts only this month's occurrences in Upcoming", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [
				{ ...bill(18800), id: 1 },
				{ ...bill(45000), id: 2 },
			],
			occurrences: [
				{
					billId: 1,
					dueDate: "2026-10-20",
					status: "upcoming",
					amountCents: 18800,
					paidCents: 0,
				},
				{
					billId: 2,
					dueDate: "2027-03-01",
					status: "upcoming",
					amountCents: 45000,
					paidCents: 0,
				},
			],
		});
		expect(totals.groups.upcomingCents).toBe(18800);
	});

	it("leaves inactive bills out of monthly and still-to-pay totals", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(10000, "monthly", false)],
			occurrences: [
				{
					billId: 10000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 10000,
					paidCents: 0,
				},
			],
		});
		expect(totals.monthlyCents).toBe(0);
		expect(totals.stillToPayCents).toBe(0);
	});

	it("counts a part-paid occurrence in full monthly and by its remainder in the group", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(120000)],
			occurrences: [
				{
					billId: 120000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 120000,
					paidCents: 60000,
				},
			],
		});
		expect(totals.monthlyCents).toBe(120000);
		expect(totals.stillToPayCents).toBe(60000);
		expect(totals.groups.overdueCents).toBe(60000);
	});
});
