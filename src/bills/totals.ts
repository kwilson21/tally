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
	// The occurrences the totals count, each once (decisions 62 and 122): the shown one of every bill, then this month's
	// occurrences of every frequency, each judged on its own. The shown one wins a tie.
	const counted = new Map<string, (typeof displayedOccurrences)[number]>();
	for (const occurrence of [...displayedOccurrences, ...thisMonthOccurrences]) {
		const key = `${occurrence.billId}:${occurrence.dueDate}`;
		if (!counted.has(key)) counted.set(key, occurrence);
	}
	const listed = new Set(
		displayedOccurrences.map(
			(occurrence) => `${occurrence.billId}:${occurrence.dueDate}`,
		),
	);
	// "To pay soon" judges the shown occurrence of every bill and a weekly or every-two-weeks bill's other occurrences
	// (decision 62). A monthly bill's handed-off occurrence is counted under its heading but not judged for it.
	const judged = [...counted].filter(
		([key, occurrence]) =>
			listed.has(key) ||
			dayStepFrequencies.has(frequencyById.get(occurrence.billId) ?? "monthly"),
	);
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
	// Every heading counts each occurrence of its group in the month, listed as a row or not (decisions 122 and 127), and
	// names the ones no row lists in `unlisted`. Paid this month counts every listed paid row at its full amount, since a
	// paid occurrence has nothing left to pay (issue #601), plus each unlisted paid occurrence due this month, whenever it
	// was paid. The unpaid headings count what is left of an occurrence, and Upcoming only those due this month.
	for (const [key, occurrence] of counted) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.status === "paid") {
			if (!listed.has(key) && !occurrence.dueDate.startsWith(month)) continue;
			groups.paidCents += occurrence.amountCents;
		} else {
			if (
				occurrence.status === "upcoming" &&
				!occurrence.dueDate.startsWith(month)
			)
				continue;
			groups[`${occurrence.status}Cents` as keyof typeof groups] += Math.max(
				0,
				occurrence.amountCents - occurrence.paidCents,
			);
		}
		if (!listed.has(key))
			unlisted[occurrence.status].push({
				billId: occurrence.billId,
				dueDate: occurrence.dueDate,
			});
	}
	// "To pay soon" counts each due or overdue occurrence once (spec §6).
	const soon = new Map<string, number>();
	const soonBillIds = new Set<number>();
	for (const [key, occurrence] of judged) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.status !== "due" && occurrence.status !== "overdue")
			continue;
		soon.set(key, Math.max(0, occurrence.amountCents - occurrence.paidCents));
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
	// Safe to spend sets aside only this month's bills that are due or overdue and not paid (decision 123, #631). Each
	// counted occurrence is judged once, the shown one winning a tie. A bill due in a later month waits for its month;
	// it still counts in soonCents, as Bills shows it due soon.
	let setAsideCents = 0;
	for (const occurrence of counted.values()) {
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
