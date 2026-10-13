import { monthDay, ordinal } from "../dates";
import { formatCents } from "../money";

export type BillStatus = "paid" | "overdue" | "due" | "upcoming";
export type BillFrequency =
	| "monthly"
	| "yearly"
	| "weekly"
	| "biweekly"
	| "quarterly";

/** §6.1 rule 3: a weekly occurrence's payment window is three days, so two weeks' windows never overlap. */
export const WEEKLY_BILL_DATE_WINDOW_DAYS = 3;
const MANUAL_LINK_WINDOW_DAYS = 30;

/**
 * §6.1 "People override": the hand-link picker lists, and accepts, a payment within this many days of the
 * occurrence it pays. Weekly is three days, the same window the matcher uses; the other frequencies keep 30.
 */
export const manualLinkWindowDays = (frequency: BillFrequency) =>
	frequency === "weekly"
		? WEEKLY_BILL_DATE_WINDOW_DAYS
		: MANUAL_LINK_WINDOW_DAYS;

export type BillSchedule = {
	frequency: BillFrequency;
	dueDay: number;
	anchorMonth?: number | null;
	anchorDate?: string | null;
	/** The day the bill was added (`bills.added_on`, decision 99): an occurrence due before it is handled. */
	addedOn?: string | null;
};

/**
 * Decision 99 (#337): an occurrence due before the day its bill was added is already handled, so it is not
 * overdue, not set aside and not still to pay. A payment that links it still shows it Paid, so `linked` keeps it.
 * A bill with no added day (`addedOn` null) has no such occurrences.
 */
export const handledBeforeAdded = (
	addedOn: string | null | undefined,
	dueDate: string,
	linked: boolean,
) => !linked && !!addedOn && dueDate < addedOn;

/**
 * Decision 101 (#205): an occurrence is Paid once its linked payments add up to at least 90% of its amount, the
 * matcher's 10% tolerance (BILL_AMOUNT_TOLERANCE), so $1,080.00 of $1,200 is Paid and $1,079.99 is not. Paying
 * more is still Paid. Integer cents, so no float rounds the check. Until then the occurrence is part paid.
 */
export const occurrencePaid = (paidCents: number, amountCents: number) =>
	paidCents * 10 >= amountCents * 9;

/**
 * "Part paid: $600 of $1,200" (decision 101): each amount shows its cents only when it has them, so "$600" and
 * "$7.75 of $15.49" both read as they are written.
 */
export const partPaidSentence = (paidCents: number, amountCents: number) => {
	const money = (cents: number) =>
		formatCents(cents, { wholeDollars: cents % 100 === 0 });
	return `Part paid: ${money(paidCents)} of ${money(amountCents)}`;
};

const WEEKDAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];

export function billCadenceLabel(bill: BillSchedule) {
	if (bill.frequency === "weekly") return `every ${WEEKDAYS[bill.dueDay - 1]}`;
	if (bill.frequency === "biweekly") return "every two weeks";
	if (bill.frequency === "quarterly") return "every 3 months";
	return bill.frequency === "yearly" ? "a year" : "a month";
}

/**
 * An inactive bill's schedule, in the words its row shows instead of a due date (decision 99, #341):
 * "Monthly, on the 15th", "Yearly, on Jul 15", "Weekly, on Mondays", "Every two weeks, on Fridays",
 * "Quarterly, from Jan 15". A biweekly bill's day is its weekday (`dueDay`), set when it is saved.
 */
export function billScheduleLabel(bill: BillSchedule) {
	const month = bill.anchorMonth ?? 1;
	// A day past the month's end reads as its last day, as the due date clamps it. Year 2000 is a leap year, so
	// February keeps its 29th.
	const anchor = monthDay(
		month,
		Math.min(bill.dueDay, daysInMonth(2000, month)),
	);
	if (bill.frequency === "weekly")
		return `Weekly, on ${WEEKDAYS[bill.dueDay - 1]}s`;
	if (bill.frequency === "biweekly")
		return `Every two weeks, on ${WEEKDAYS[bill.dueDay - 1]}s`;
	if (bill.frequency === "yearly") return `Yearly, on ${anchor}`;
	if (bill.frequency === "quarterly") return `Quarterly, from ${anchor}`;
	return `Monthly, on the ${ordinal(bill.dueDay)}`;
}

function leap(year: number) {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
	return [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
		month - 1
	] as number;
}

const dateNumber = (date: string) =>
	Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const fromNumber = (day: number) =>
	new Date(day * 86_400_000).toISOString().slice(0, 10);

export function billOccurrenceForMonth(
	bill: BillSchedule,
	year: number,
	month: number,
) {
	const day = Math.min(bill.dueDay, daysInMonth(year, month));
	const dueDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const quarter = Math.floor((month - 1) / 3) + 1;
	return {
		dueDate,
		period:
			bill.frequency === "yearly"
				? String(year)
				: bill.frequency === "quarterly"
					? `${year}-Q${quarter}`
					: dueDate.slice(0, 7),
	};
}

export function billOccurrencesForMonth(
	bill: BillSchedule,
	year: number,
	month: number,
) {
	const days = daysInMonth(year, month);
	const result: ReturnType<typeof billOccurrenceForMonth>[] = [];
	for (let day = 1; day <= days; day++) {
		const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
		if (bill.frequency === "monthly")
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (bill.frequency === "yearly" && month === bill.anchorMonth)
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "quarterly" &&
			(month - (bill.anchorMonth ?? 1) + 12) % 3 === 0
		)
			result.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "weekly" &&
			((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 === bill.dueDay
		)
			result.push({ dueDate: date, period: date });
		else if (
			bill.frequency === "biweekly" &&
			bill.anchorDate &&
			(dateNumber(date) - dateNumber(bill.anchorDate)) % 14 === 0
		)
			result.push({ dueDate: date, period: date });
		if (
			bill.frequency === "monthly" ||
			bill.frequency === "yearly" ||
			bill.frequency === "quarterly"
		)
			break;
	}
	return result;
}

function addMonth(year: number, month: number) {
	return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function daysBetween(from: string, to: string) {
	return dateNumber(to) - dateNumber(from);
}

function periodicOccurrences(bill: BillSchedule, today: string) {
	const todayNumber = dateNumber(today);
	if (bill.frequency === "weekly" || bill.frequency === "biweekly") {
		const anchor =
			bill.frequency === "weekly"
				? fromNumber(
						dateNumber(today) -
							((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) +
							((bill.dueDay - 1) % 7),
					)
				: (bill.anchorDate ?? today);
		const step = bill.frequency === "weekly" ? 7 : 14;
		const anchorNumber = dateNumber(anchor);
		const firstIndex = Math.floor((todayNumber - 35 - anchorNumber) / step);
		return Array.from({ length: 16 }, (_, i) => {
			const dueDate = fromNumber(anchorNumber + (firstIndex + i) * step);
			return { dueDate, period: dueDate };
		});
	}
	const occurrences: ReturnType<typeof billOccurrenceForMonth>[] = [];
	let year = Number(today.slice(0, 4)) - 1;
	let month = 1;
	while (year <= Number(today.slice(0, 4)) + 2) {
		if (bill.frequency === "yearly" && month === (bill.anchorMonth ?? 1))
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		else if (
			bill.frequency === "quarterly" &&
			(month - (bill.anchorMonth ?? 1) + 12) % 3 === 0
		)
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		else if (bill.frequency === "monthly")
			occurrences.push(billOccurrenceForMonth(bill, year, month));
		[year, month] = addMonth(year, month) as [number, number];
	}
	return occurrences;
}

/**
 * The occurrence a person needs to act on (decision 62). `paid` holds the periods that are Paid (occurrencePaid),
 * which decide its status. `linked` holds the periods with any payment linked, which keep an occurrence due before
 * the bill was added in view (decision 99); it defaults to `paid`.
 */
export function billOccurrence(
	bill: BillSchedule,
	today: string,
	paid: boolean | ReadonlySet<string>,
	linked: boolean | ReadonlySet<string> = paid,
): { dueDate: string; period: string; status: BillStatus } {
	const isLinked = (period: string) =>
		typeof linked === "boolean" ? linked : linked.has(period);
	const isPaid = (period: string) =>
		typeof paid === "boolean" ? paid : paid.has(period);
	// Left out before anything below judges them: an occurrence handled before its bill was added (decision 99).
	const occurrences = periodicOccurrences(bill, today).filter(
		(o) => !handledBeforeAdded(bill.addedOn, o.dueDate, isLinked(o.period)),
	);
	if (bill.frequency === "weekly" || bill.frequency === "biweekly") {
		let index = occurrences.findIndex((o) => o.dueDate >= today);
		if (index < 0) index = occurrences.length - 1;
		if (index > 0 && occurrences[index]?.dueDate !== today) index--;
		let current = occurrences[index] as ReturnType<
			typeof billOccurrenceForMonth
		>;
		// The latest occurrence on or before today is the one shown. Each paid one gives way to the next, and so
		// does an unpaid one from an earlier month: that one reads Not paid on the bill's page and is no longer
		// set aside. An unpaid one from this month stays overdue until it is paid.
		let next = occurrences[index + 1];
		while (
			next &&
			(isPaid(current.period) ||
				current.dueDate.slice(0, 7) < today.slice(0, 7))
		) {
			index++;
			current = next;
			next = occurrences[index + 1];
		}
		const distance = daysBetween(today, current.dueDate);
		const status: BillStatus = isPaid(current.period)
			? "paid"
			: distance < 0
				? "overdue"
				: distance <= 7
					? "due"
					: "upcoming";
		return { ...current, status };
	}
	// Monthly, yearly and quarterly schedules use the same seven-day handoff as decision 62.
	let index = occurrences.findIndex((o) => daysBetween(today, o.dueDate) > 7);
	if (index < 0) index = occurrences.length - 1;
	// Include the last missed occurrence until its successor enters the seven-day due window.
	if (index > 0) index--;
	let current = occurrences[index] as ReturnType<typeof billOccurrenceForMonth>;
	if (
		isPaid(current.period) &&
		current.dueDate.slice(0, 7) < today.slice(0, 7)
	) {
		index++;
		current = occurrences[index] as ReturnType<typeof billOccurrenceForMonth>;
	}
	if (
		isPaid(current.period) ||
		(current.dueDate < today && daysBetween(today, current.dueDate) < -7)
	) {
		const next = occurrences[index + 1];
		if (next && daysBetween(today, next.dueDate) <= 7) {
			index++;
			current = next;
		}
	}
	const distance = daysBetween(today, current.dueDate);
	const status: BillStatus = isPaid(current.period)
		? "paid"
		: distance < 0
			? "overdue"
			: distance <= 7
				? "due"
				: "upcoming";
	return { ...current, status };
}
