import type { BillStatus } from "./status";

export type BillTotalFrequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

export function monthlyBillShare(
	amountCents: number,
	frequency: BillTotalFrequency,
) {
	const [numerator, denominator] = {
		monthly: [1, 1],
		yearly: [1, 12],
		weekly: [52, 12],
		biweekly: [26, 12],
		quarterly: [1, 3],
	}[frequency] as Record<
		BillTotalFrequency,
		[number, number]
	>[BillTotalFrequency];
	return Math.floor((amountCents * numerator + denominator / 2) / denominator);
}

type BillTotalInput = {
	month: string;
	bills: {
		id: number;
		amountCents: number;
		frequency: BillTotalFrequency;
		active: boolean;
	}[];
	displayedOccurrences: {
		billId: number;
		dueDate: string;
		status: BillStatus;
		amountCents: number;
		paidCents: number;
	}[];
	thisMonthOccurrences: {
		billId: number;
		dueDate: string;
		status: BillStatus;
		amountCents: number;
		paidCents: number;
	}[];
};

export function calculateBillTotals({
	month,
	bills,
	displayedOccurrences,
	thisMonthOccurrences,
}: BillTotalInput) {
	const activeIds = new Set(
		bills.filter((bill) => bill.active).map((bill) => bill.id),
	);
	const monthlyCents = bills.reduce(
		(total, bill) =>
			total +
			(bill.active ? monthlyBillShare(bill.amountCents, bill.frequency) : 0),
		0,
	);
	const groups = {
		overdueCents: 0,
		dueCents: 0,
		upcomingCents: 0,
		paidCents: 0,
	};
	let stillToPayCents = 0;
	for (const occurrence of displayedOccurrences) {
		if (!activeIds.has(occurrence.billId)) continue;
		const left = Math.max(0, occurrence.amountCents - occurrence.paidCents);
		const key =
			`${occurrence.status === "paid" ? "paid" : occurrence.status}Cents` as keyof typeof groups;
		if (
			occurrence.status !== "upcoming" ||
			occurrence.dueDate.startsWith(month)
		)
			groups[key] += left;
	}
	for (const occurrence of thisMonthOccurrences) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.dueDate.startsWith(month))
			stillToPayCents += Math.max(
				0,
				occurrence.amountCents - occurrence.paidCents,
			);
	}
	return { monthlyCents, stillToPayCents, groups };
}
