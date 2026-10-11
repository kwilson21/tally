import type { BillStatus } from "./status";

export type BillTotalFrequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

/** Bills whose occurrences fall every 7 or 14 days: each one is judged on its own, so several can be set aside. */
const dayStepFrequencies = new Set<BillTotalFrequency>(["weekly", "biweekly"]);

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

/** A bill as Bills' rows give it: what the month's totals need, from `loadBillRows`. */
export type BillTotalsRow = {
	id: number;
	active: boolean;
	amountCents: number;
	frequency: BillTotalFrequency;
	dueDate: string;
	status: BillStatus;
	paidCents: number;
	totalOccurrences: {
		dueDate: string;
		status: BillStatus;
		amountCents: number;
		paidCents: number;
	}[];
	/** A weekly or every-two-weeks bill's occurrence after the shown one, when it falls in a later month. */
	nextOccurrence?: {
		dueDate: string;
		status: BillStatus;
		amountCents: number;
		paidCents: number;
	};
};

/**
 * The month's bill totals from Bills' rows. Bills, Home and How Tally works all call this, so they agree
 * on what is set aside (`soonCents`), which Home's "Bills due soon" list also follows, and what is still to pay.
 */
export function billTotalsForRows(month: string, rows: BillTotalsRow[]) {
	const active = rows.filter((row) => row.active);
	return calculateBillTotals({
		month,
		bills: active.map(({ id, amountCents, frequency }) => ({
			id,
			amountCents,
			frequency,
			active: true,
		})),
		displayedOccurrences: active.map((row) => ({
			billId: row.id,
			dueDate: row.dueDate,
			status: row.status,
			amountCents: row.amountCents,
			paidCents: row.paidCents,
		})),
		thisMonthOccurrences: active.flatMap((row) => [
			...row.totalOccurrences
				.filter((occurrence) => occurrence.dueDate.startsWith(month))
				.map((occurrence) => ({ billId: row.id, ...occurrence })),
			...(row.nextOccurrence
				? [{ billId: row.id, ...row.nextOccurrence }]
				: []),
		]),
	});
}

export function calculateBillTotals({
	month,
	bills,
	displayedOccurrences,
	thisMonthOccurrences,
}: BillTotalInput) {
	const activeIds = new Set(
		bills.filter((bill) => bill.active).map((bill) => bill.id),
	);
	const frequencyById = new Map(bills.map((bill) => [bill.id, bill.frequency]));
	const monthlyCents = bills.reduce(
		(total, bill) =>
			total +
			(bill.active ? monthlyBillShare(bill.amountCents, bill.frequency) : 0),
		0,
	);
	// The occurrences the totals judge, each once (decision 62): the shown one of every bill, and for a weekly or
	// every-two-weeks bill its other occurrences this month and the next, each judged on its own. The shown one
	// wins a tie. A monthly bill's handed-off occurrence is not judged.
	const judged = new Map<string, (typeof displayedOccurrences)[number]>();
	for (const occurrence of displayedOccurrences)
		judged.set(`${occurrence.billId}:${occurrence.dueDate}`, occurrence);
	for (const occurrence of thisMonthOccurrences) {
		const key = `${occurrence.billId}:${occurrence.dueDate}`;
		if (
			dayStepFrequencies.has(
				frequencyById.get(occurrence.billId) ?? "monthly",
			) &&
			!judged.has(key)
		)
			judged.set(key, occurrence);
	}
	const groups = {
		overdueCents: 0,
		dueCents: 0,
		upcomingCents: 0,
		paidCents: 0,
	};
	// Safe to spend and "to pay soon" set aside each due or overdue occurrence once (spec §6).
	const soon = new Map<string, number>();
	const soonBillIds = new Set<number>();
	for (const [key, occurrence] of judged) {
		if (!activeIds.has(occurrence.billId)) continue;
		const left = Math.max(0, occurrence.amountCents - occurrence.paidCents);
		const groupKey =
			`${occurrence.status === "paid" ? "paid" : occurrence.status}Cents` as keyof typeof groups;
		if (
			occurrence.status !== "upcoming" ||
			occurrence.dueDate.startsWith(month)
		)
			groups[groupKey] += left;
		if (occurrence.status !== "due" && occurrence.status !== "overdue")
			continue;
		soon.set(key, left);
		soonBillIds.add(occurrence.billId);
	}
	let stillToPayCents = 0;
	for (const occurrence of thisMonthOccurrences) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.dueDate.startsWith(month))
			stillToPayCents += Math.max(
				0,
				occurrence.amountCents - occurrence.paidCents,
			);
	}
	const soonCents = [...soon.values()].reduce(
		(total, cents) => total + cents,
		0,
	);
	return {
		monthlyCents,
		stillToPayCents,
		// Bills to pay soon, each bill once; soonCents still sums every occurrence set aside.
		soonCount: soonBillIds.size,
		soonCents,
		groups,
	};
}
