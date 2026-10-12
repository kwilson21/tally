import { describe, expect, it } from "vitest";
import { billTotalsForRows, calculateBillTotals } from "../src/bills/totals";

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
	it("gives a monthly bill's share at its current amount, and its overdue occurrence at the amount it was due", () => {
		const totals = billTotalsForRows("2026-10", [
			{
				id: 1,
				active: true,
				amountCents: 10000,
				currentAmountCents: 12000,
				frequency: "monthly",
				dueDate: "2026-09-28",
				status: "overdue",
				paidCents: 0,
				totalOccurrences: [
					{
						dueDate: "2026-09-28",
						status: "overdue",
						amountCents: 10000,
						paidCents: 0,
					},
				],
			},
		]);
		expect(totals.monthlyCents).toBe(12000);
		expect(totals.groups.overdueCents).toBe(10000);
		expect(totals.soonCents).toBe(10000);
	});

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
					displayedOccurrences: [],
					thisMonthOccurrences: [],
				}).monthlyCents,
			).toBe(expected);
		},
	);

	it("counts overdue unpaid bills in still to pay and excludes a yearly bill due in March", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(5000), { ...bill(12000, "yearly"), id: 2 }],
			displayedOccurrences: [
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
			thisMonthOccurrences: [
				{
					billId: 5000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 5000,
					paidCents: 0,
				},
			],
		});
		expect(totals.stillToPayCents).toBe(5000);
	});

	it("sets aside each weekly occurrence this month, but not last month's Not paid occurrence", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-09-25",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-16",
					status: "due",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-23",
					status: "upcoming",
					amountCents: 24000,
					paidCents: 0,
				},
			],
		});
		expect(totals.stillToPayCents).toBe(96000);
	});

	it("counts each due or overdue weekly occurrence in the shared soon summary", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-16",
					status: "upcoming",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-23",
					status: "upcoming",
					amountCents: 24000,
					paidCents: 0,
				},
			],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(48000);
	});

	it("uses displayed occurrences for headings and all October occurrences for still to pay", () => {
		const upcomingBill = { ...bill(5000), id: 2 };
		const bills = [bill(10000), upcomingBill];
		const septemberDisplayed = {
			billId: 10000,
			dueDate: "2026-09-28",
			status: "overdue" as const,
			amountCents: 10000,
			paidCents: 0,
		};
		const octoberDisplayed = {
			billId: 2,
			dueDate: "2026-10-20",
			status: "upcoming" as const,
			amountCents: 5000,
			paidCents: 0,
		};
		const octoberOccurrence = {
			billId: 10000,
			dueDate: "2026-10-28",
			status: "upcoming" as const,
			amountCents: 10000,
			paidCents: 0,
		};
		const displayedOccurrences = [septemberDisplayed, octoberDisplayed];
		const octoberOccurrences = [octoberOccurrence, octoberDisplayed];
		const withOverdueBill = calculateBillTotals({
			month: "2026-10",
			bills,
			displayedOccurrences,
			thisMonthOccurrences: octoberOccurrences,
		});
		expect(withOverdueBill.groups.overdueCents).toBe(10000);
		expect(withOverdueBill.groups.upcomingCents).toBe(5000);
		// Issue #207: October still to pay is October's $100 + $50 = $150. September's $100 is the separate overdue row, not due this month.
		expect(withOverdueBill.stillToPayCents).toBe(15000);

		const withoutOverdueBill = calculateBillTotals({
			month: "2026-10",
			bills: [upcomingBill],
			displayedOccurrences: [octoberDisplayed],
			thisMonthOccurrences: [octoberDisplayed],
		});
		expect(withoutOverdueBill.groups.overdueCents).toBe(0);
		expect(withoutOverdueBill.groups.upcomingCents).toBe(5000);
		expect(withoutOverdueBill.stillToPayCents).toBe(5000);
	});

	it.each([
		["2026-10-08", "2026-09-28", "overdue", 10000, 10000],
		["2026-10-08", "2026-10-28", "upcoming", 0, 10000],
		["2026-10-05", "2026-09-20", "overdue", 10000, 10000],
		["2026-10-25", "2026-10-20", "overdue", 10000, 10000],
	] as const)(
		"counts this month's occurrence with displayed %s when its date is %s",
		(today, displayedDate, displayedStatus, overdueCents, stillToPayCents) => {
			const totals = calculateBillTotals({
				month: today.slice(0, 7),
				bills: [bill(10000)],
				displayedOccurrences: [
					{
						billId: 10000,
						dueDate: displayedDate,
						status: displayedStatus,
						amountCents: 10000,
						paidCents: 0,
					},
				],
				thisMonthOccurrences: [
					{
						billId: 10000,
						dueDate:
							displayedDate.slice(0, 7) === today.slice(0, 7)
								? displayedDate
								: "2026-10-20",
						status:
							displayedDate.slice(0, 7) === today.slice(0, 7)
								? displayedStatus
								: today >= "2026-10-20"
									? "overdue"
									: "upcoming",
						amountCents: 10000,
						paidCents: 0,
					},
				],
			});
			expect(totals.stillToPayCents).toBe(stillToPayCents);
			expect(totals.groups.overdueCents).toBe(overdueCents);
			expect(
				totals.groups.overdueCents +
					totals.groups.dueCents +
					totals.groups.upcomingCents +
					totals.groups.paidCents,
			).toBe(10000);
		},
	);

	it("groups every weekly occurrence this month, not only the shown one", () => {
		const friday = (
			dueDate: string,
			status: "paid" | "due" | "upcoming",
			paidCents = 0,
		) => ({ billId: 24000, dueDate, status, amountCents: 24000, paidCents });
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [friday("2026-10-16", "due")],
			thisMonthOccurrences: [
				friday("2026-10-02", "paid", 24000),
				friday("2026-10-09", "paid", 24000),
				friday("2026-10-16", "due"),
				friday("2026-10-23", "upcoming"),
				friday("2026-10-30", "upcoming"),
			],
		});
		expect(totals.groups.dueCents).toBe(24000);
		expect(totals.groups.upcomingCents).toBe(48000);
		expect(totals.stillToPayCents).toBe(72000);
		expect(totals.groups.overdueCents + totals.groups.dueCents).toBe(
			totals.soonCents,
		);
	});

	it("groups every unpaid weekly Friday this month as overdue, not only the shown one", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
		});
		expect(totals.groups.overdueCents).toBe(48000);
		expect(totals.groups.overdueCents + totals.groups.dueCents).toBe(
			totals.soonCents,
		);
	});

	it("counts only this month's occurrences in Upcoming", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [
				{ ...bill(18800), id: 1 },
				{ ...bill(45000), id: 2 },
			],
			displayedOccurrences: [
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
			thisMonthOccurrences: [
				{
					billId: 1,
					dueDate: "2026-10-20",
					status: "upcoming",
					amountCents: 18800,
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
			displayedOccurrences: [
				{
					billId: 10000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 10000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
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

	it("counts a weekly occurrence due in November, after this month's last Friday was paid", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-11-06",
					status: "due",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-30",
					status: "paid",
					amountCents: 24000,
					paidCents: 24000,
				},
			],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(24000);
	});

	it("counts an unpaid Friday this month and the next Friday when it falls due before the month ends", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-30",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-30",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-11-06",
					status: "due",
					amountCents: 24000,
					paidCents: 0,
				},
			],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(48000);
	});

	it("counts a weekly occurrence once when it is both the shown row and this month's list", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "weekly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
				{
					billId: 24000,
					dueDate: "2026-10-09",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(48000);
	});

	it("sets aside a quarterly bill's shown overdue occurrence, as the overdue group does", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "quarterly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-08-01",
					status: "overdue",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [],
		});
		expect(totals.groups.overdueCents).toBe(24000);
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(24000);
	});

	it("counts a quarterly bill due in November when it is shown", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(24000, "quarterly")],
			displayedOccurrences: [
				{
					billId: 24000,
					dueDate: "2026-11-01",
					status: "due",
					amountCents: 24000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(24000);
	});

	it("leaves a monthly bill's handed-off earlier occurrence out of the soon total", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(10000)],
			displayedOccurrences: [
				{
					billId: 10000,
					dueDate: "2026-11-01",
					status: "due",
					amountCents: 10000,
					paidCents: 0,
				},
			],
			thisMonthOccurrences: [
				{
					billId: 10000,
					dueDate: "2026-10-01",
					status: "overdue",
					amountCents: 10000,
					paidCents: 0,
				},
			],
		});
		expect(totals.soonCount).toBe(1);
		expect(totals.soonCents).toBe(10000);
	});

	it("counts a part-paid occurrence in full monthly and by its remainder in the group", () => {
		const totals = calculateBillTotals({
			month: "2026-10",
			bills: [bill(120000)],
			displayedOccurrences: [
				{
					billId: 120000,
					dueDate: "2026-10-02",
					status: "overdue",
					amountCents: 120000,
					paidCents: 60000,
				},
			],
			thisMonthOccurrences: [
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
