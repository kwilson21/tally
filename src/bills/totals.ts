import type { BillStatus } from "./status";

export type BillTotalFrequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

/** An occurrence a status heading's total counts that no row lists (decision 122): Bills names it under the heading. */
type UnlistedOccurrence = { billId: number; dueDate: string };

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
	/** The amount of the occurrence shown, which its status and its set-aside totals read. */
	amountCents: number;
	/** The bill's current amount, which its monthly share uses (`monthlyBillShare`), not a past month's. */
	currentAmountCents: number;
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
 * on what is due soon (`soonCents`, `soonCount`, which Home's "Bills due soon" list also follows), what Safe to
 * spend sets aside (`setAsideCents`), and what is still to pay.
 */
export function billTotalsForRows(month: string, rows: BillTotalsRow[]) {
	const active = rows.filter((row) => row.active);
	return calculateBillTotals({
		month,
		bills: active.map(({ id, currentAmountCents, frequency }) => ({
			id,
			amountCents: currentAmountCents,
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
	const unlisted: Record<BillStatus, UnlistedOccurrence[]> = {
		overdue: [],
		due: [],
		upcoming: [],
		paid: [],
	};
	// Every heading counts each occurrence of its group in the month, listed as a row or not (decision 122, P136 A), and
	// names the ones no row lists in `unlisted`. Paid this month counts each paid occurrence at its full amount, since a
	// paid occurrence has nothing left to pay (issue #601). A shown paid row counts whatever its month; an unlisted one
	// counts only when it is due this month, so next month's prepaid occurrence stays out.
	const listed = new Set(
		displayedOccurrences.map(
			(occurrence) => `${occurrence.billId}:${occurrence.dueDate}`,
		),
	);
	const countedPaid = new Set<string>();
	for (const occurrence of [...displayedOccurrences, ...thisMonthOccurrences]) {
		const key = `${occurrence.billId}:${occurrence.dueDate}`;
		if (
			occurrence.status !== "paid" ||
			countedPaid.has(key) ||
			!activeIds.has(occurrence.billId)
		)
			continue;
		const isListed = listed.has(key);
		if (!isListed && !occurrence.dueDate.startsWith(month)) continue;
		countedPaid.add(key);
		groups.paidCents += occurrence.amountCents;
		if (!isListed)
			unlisted.paid.push({
				billId: occurrence.billId,
				dueDate: occurrence.dueDate,
			});
	}
	// "To pay soon" counts each due or overdue occurrence once (spec §6).
	const soon = new Map<string, number>();
	const soonBillIds = new Set<number>();
	for (const [key, occurrence] of judged) {
		if (!activeIds.has(occurrence.billId)) continue;
		const left = Math.max(0, occurrence.amountCents - occurrence.paidCents);
		const groupKey =
			`${occurrence.status === "paid" ? "paid" : occurrence.status}Cents` as keyof typeof groups;
		if (
			occurrence.status !== "paid" &&
			(occurrence.status !== "upcoming" || occurrence.dueDate.startsWith(month))
		) {
			groups[groupKey] += left;
			if (!listed.has(key))
				unlisted[occurrence.status].push({
					billId: occurrence.billId,
					dueDate: occurrence.dueDate,
				});
		}
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
	// Safe to spend sets aside only this month's bills that are due or overdue and not paid (decision 123, #631). The
	// shown occurrence and this month's occurrences are each judged once, the shown one winning a tie. A bill due in a
	// later month waits for its month; it still counts in soonCents, as Bills shows it due soon.
	const judgedForSetAside = new Set<string>();
	let setAsideCents = 0;
	for (const occurrence of [...displayedOccurrences, ...thisMonthOccurrences]) {
		const key = `${occurrence.billId}:${occurrence.dueDate}`;
		if (judgedForSetAside.has(key)) continue;
		judgedForSetAside.add(key);
		if (!activeIds.has(occurrence.billId)) continue;
		if (!occurrence.dueDate.startsWith(month)) continue;
		if (occurrence.status !== "due" && occurrence.status !== "overdue")
			continue;
		setAsideCents += Math.max(0, occurrence.amountCents - occurrence.paidCents);
	}
	return {
		monthlyCents,
		stillToPayCents,
		// Bills to pay soon, each bill once; soonCents still sums every occurrence due soon.
		soonCount: soonBillIds.size,
		soonCents,
		setAsideCents,
		groups,
		unlisted,
	};
}
