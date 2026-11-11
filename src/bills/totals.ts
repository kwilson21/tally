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

/** One due date of one bill: what it costs, what has been paid toward it, and where it stands. */
export type BillOccurrence = {
	billId: number;
	dueDate: string;
	status: BillStatus;
	amountCents: number;
	paidCents: number;
};

/**
 * What names one occurrence in the totals: its bill and its due date. Two occurrences share a key only when both match
 * (the id's digits end at the first colon), which test/bill-set-aside-rule.test.ts checks.
 */
export function occurrenceKey(billId: number, dueDate: string): string {
	//@ extern
	// Trusted, not checked: a number written into a template string is outside LemmaScript's model, so the prover knows
	// only that the same bill and date give the same key (docs/verification.md, "What LemmaScript reads").
	return `${billId}:${dueDate}`;
}

/** What is left to pay of an occurrence: its amount less what is paid, never below zero. */
export function unpaidCents(occurrence: BillOccurrence): number {
	//@ verify
	//@ ensures \result === (occurrence.amountCents > occurrence.paidCents ? occurrence.amountCents - occurrence.paidCents : 0)
	return Math.max(0, occurrence.amountCents - occurrence.paidCents);
}

/**
 * What setAsideFor can add exactly (docs/verification.md, "Numbers"): no amount or paid amount above $100,000,000 and at
 * most 100,000 occurrences, so what is left of one is at most 2e10 cents and the sum at most 2e15, under the 2^53 (about
 * 9e15) a double holds exactly.
 */
export const MAX_OCCURRENCE_CENTS = 10_000_000_000;
export const MAX_COUNTED_OCCURRENCES = 100_000;

/** Whether an amount is a whole number of cents inside the limit. */
function fits(cents: number): boolean {
	return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_OCCURRENCE_CENTS;
}

/** Refuses occurrences past the limits above. The message names no amount: bill details are never logged. */
//@ skip
function assertSetAsideWithinLimits(occurrences: BillOccurrence[]): void {
	if (
		occurrences.length > MAX_COUNTED_OCCURRENCES ||
		!occurrences.every((o) => fits(o.amountCents) && fits(o.paidCents))
	)
		throw new RangeError(
			"These bills hold more money or more rows than Tally can add up exactly.",
		);
}

/**
 * What Safe to spend sets aside for bills (decision 123, #631): the unpaid part of each due or overdue occurrence of an
 * active bill that is due this month. Each occurrence is counted once, the first one given winning a tie, so the caller
 * gives the shown occurrences first. A bill due in a later month waits for its month. It refuses occurrences past the
 * limits above with a RangeError.
 */
//@ skip
export function setAsideFor(
	occurrences: BillOccurrence[],
	activeIds: Set<number>,
	month: string,
): number {
	assertSetAsideWithinLimits(occurrences);
	return setAsideWithinLimits(occurrences, activeIds, month);
}

// Checked by LemmaScript and Dafny (decision 188). The rule, in plain words: the set-aside is exactly the sum, over the
// occurrences, of the unpaid part (amount less paid, never below zero) of each one that is the first with its key, belongs
// to an active bill, is due this month and is due or overdue; every other occurrence adds nothing. So an occurrence given
// twice is counted once, the earlier one winning, and nothing paid, upcoming, inactive or due another month is counted.
function setAsideWithinLimits(
	occurrences: BillOccurrence[],
	activeIds: Set<number>,
	month: string,
): number {
	//@ verify
	//@ requires occurrences.length <= MAX_COUNTED_OCCURRENCES
	//@ requires forall(i: nat, i < occurrences.length ==> -MAX_OCCURRENCE_CENTS <= occurrences[i].amountCents && occurrences[i].amountCents <= MAX_OCCURRENCE_CENTS && -MAX_OCCURRENCE_CENTS <= occurrences[i].paidCents && occurrences[i].paidCents <= MAX_OCCURRENCE_CENTS)
	//@ ensures \result === setAsideTo(occurrences, occurrences.length, activeIds, month)
	//@ ensures 0 <= \result && \result <= 2 * MAX_OCCURRENCE_CENTS * occurrences.length
	const counted = new Set<string>();
	let setAsideCents = 0;
	for (const occurrence of occurrences) {
		//@ invariant forall(k: string, counted.has(k) <==> keyCountedIn(occurrences, _occurrence_idx, k))
		//@ invariant setAsideCents === setAsideTo(occurrences, _occurrence_idx, activeIds, month)
		//@ invariant 0 <= setAsideCents && setAsideCents <= 2 * MAX_OCCURRENCE_CENTS * _occurrence_idx
		const key = occurrenceKey(occurrence.billId, occurrence.dueDate);
		if (counted.has(key)) continue;
		counted.add(key);
		if (!activeIds.has(occurrence.billId)) continue;
		if (!occurrence.dueDate.startsWith(month)) continue;
		if (occurrence.status !== "due" && occurrence.status !== "overdue")
			continue;
		setAsideCents += unpaidCents(occurrence);
	}
	return setAsideCents;
}

// What the contract on setAsideWithinLimits compares against, written as the simplest recursions so each reads as the
// rule it names. They are exported only so the type checker sees them used.

/** Whether one of the first n occurrences has this key. */
export function keyCountedIn(
	occurrences: BillOccurrence[],
	n: number,
	key: string,
): boolean {
	//@ verify
	//@ type n nat
	//@ requires n <= occurrences.length
	//@ decreases n
	if (n === 0) return false;
	const o = occurrences[n - 1] as BillOccurrence;
	return (
		keyCountedIn(occurrences, n - 1, key) ||
		occurrenceKey(o.billId, o.dueDate) === key
	);
}

/** The set-aside of the first n occurrences: each adds its unpaid part only when the rule counts it. */
export function setAsideTo(
	occurrences: BillOccurrence[],
	n: number,
	activeIds: Set<number>,
	month: string,
): number {
	//@ verify
	//@ type n nat
	//@ requires n <= occurrences.length
	//@ decreases n
	if (n === 0) return 0;
	const o = occurrences[n - 1] as BillOccurrence;
	return (
		setAsideTo(occurrences, n - 1, activeIds, month) +
		(!keyCountedIn(occurrences, n - 1, occurrenceKey(o.billId, o.dueDate)) &&
		activeIds.has(o.billId) &&
		o.dueDate.startsWith(month) &&
		(o.status === "due" || o.status === "overdue")
			? unpaidCents(o)
			: 0)
	);
}

type BillTotalInput = {
	month: string;
	bills: {
		id: number;
		amountCents: number;
		frequency: BillTotalFrequency;
		active: boolean;
	}[];
	displayedOccurrences: BillOccurrence[];
	thisMonthOccurrences: BillOccurrence[];
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
	const shownFirst = [...displayedOccurrences, ...thisMonthOccurrences];
	const counted = new Map<string, BillOccurrence>();
	for (const occurrence of shownFirst) {
		const key = occurrenceKey(occurrence.billId, occurrence.dueDate);
		if (!counted.has(key)) counted.set(key, occurrence);
	}
	const listed = new Set(
		displayedOccurrences.map((occurrence) =>
			occurrenceKey(occurrence.billId, occurrence.dueDate),
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
			groups[`${occurrence.status}Cents` as keyof typeof groups] +=
				unpaidCents(occurrence);
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
	const overdueBillIds = new Set<number>();
	for (const [key, occurrence] of judged) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.status !== "due" && occurrence.status !== "overdue")
			continue;
		soon.set(key, unpaidCents(occurrence));
		soonBillIds.add(occurrence.billId);
		if (occurrence.status === "overdue") overdueBillIds.add(occurrence.billId);
	}
	let stillToPayCents = 0;
	for (const occurrence of thisMonthOccurrences) {
		if (!activeIds.has(occurrence.billId)) continue;
		if (occurrence.dueDate.startsWith(month))
			stillToPayCents += unpaidCents(occurrence);
	}
	const soonCents = [...soon.values()].reduce(
		(total, cents) => total + cents,
		0,
	);
	// Safe to spend sets aside only this month's bills that are due or overdue and not paid; it still counts a bill due
	// in a later month in soonCents, as Bills shows it due soon.
	const setAsideCents = setAsideFor(shownFirst, activeIds, month);
	return {
		monthlyCents,
		stillToPayCents,
		// Bills to pay soon, each bill once; soonCents still sums every occurrence due soon.
		soonCount: soonBillIds.size,
		// Bills with an overdue, unpaid occurrence, each once; Home's status sentence says so.
		overdueCount: overdueBillIds.size,
		soonCents,
		setAsideCents,
		groups,
		unlisted,
	};
}
