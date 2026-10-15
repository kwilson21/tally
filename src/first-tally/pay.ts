// The pay step's words (P125 E, decision 114, spec §8.8): one merchant whose money in Tally marked as income. Every
// number comes from the deposits the bank sent, so nothing here is typed in.
import { shortDay } from "../dates";
import { formatCents } from "../money";

/** One deposit of a merchant's money in: its day (YYYY-MM-DD) and its amount in cents (positive). */
export type PayDeposit = { date: string; cents: number };

const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;
const DAY_MS = 86_400_000;

const epochDay = (date: string) =>
	Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const weekdayOf = (date: string) =>
	WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** Integer cents as the words show money: whole dollars, or the cents when there are some. */
export const dollarsWords = (cents: number) =>
	formatCents(cents, { wholeDollars: cents % 100 === 0 });

/**
 * How often the deposits came, from the typical gap between them: every week, or every weekday when all the deposits
 * share one weekday; every other week, or every other weekday when they share one (what a fortnightly paycheck does,
 * a holiday shift aside); twice a month, for gaps about two weeks apart that aren't all one fortnight's; or every month.
 * Null with fewer than two deposits, or with a gap none of these fits.
 */
export function cadenceOf(dates: string[]): string | null {
	if (dates.length < 2) return null;
	const sorted = [...dates].sort();
	const gaps = sorted
		.slice(1)
		.map((date, i) => epochDay(date) - epochDay(sorted[i] as string));
	const median = [...gaps].sort((a, b) => a - b)[
		Math.floor(gaps.length / 2)
	] as number;
	const latest = sorted[sorted.length - 1] as string;
	const oneWeekday = sorted.every(
		(date) => weekdayOf(date) === weekdayOf(latest),
	);
	const fortnightly = gaps.every((gap) => gap >= 13 && gap <= 15);
	if (median <= 9)
		return oneWeekday ? `every ${weekdayOf(latest)}` : "every week";
	if (median >= 13 && median <= 15 && fortnightly)
		return oneWeekday ? `every other ${weekdayOf(latest)}` : "every other week";
	if (median >= 13 && median <= 17) return "twice a month";
	if (median >= 25 && median <= 35) return "every month";
	return null;
}

/** The deposits' amount in words: one amount, or the range they vary across ("$2,300 to $2,600"). */
export function amountWords(deposits: PayDeposit[]): string {
	const cents = deposits.map((deposit) => deposit.cents);
	const low = Math.min(...cents);
	const high = Math.max(...cents);
	return low === high
		? dollarsWords(low)
		: `${dollarsWords(low)} to ${dollarsWords(high)}`;
}

/**
 * The question's muted line: what the bank shows for this merchant. One amount gets its cadence; varying amounts give
 * their range and how often they came, and a single deposit says so once, with its day.
 */
export function paySentence({
	bankText,
	deposits,
}: {
	bankText: string;
	deposits: PayDeposit[];
}): string {
	const dates = deposits.map((deposit) => deposit.date).sort();
	const first = dates[0] as string;
	const latest = dates[dates.length - 1] as string;
	const since = shortDay(first, latest);
	const count = deposits.length;
	const cents = deposits.map((deposit) => deposit.cents);
	if (count === 1)
		return `Your bank shows ${bankText} paying ${amountWords(deposits)}, once, on ${since}.`;
	if (Math.min(...cents) !== Math.max(...cents))
		return `Your bank shows ${bankText} paying ${amountWords(deposits)}, ${count} times since ${since}.`;
	const cadence = cadenceOf(dates);
	return `Your bank shows ${bankText} paying ${amountWords(deposits)}${cadence ? ` ${cadence}` : ""}, ${count} times since ${since}.`;
}

/** The ledger line an answered pay writes: "Pay · Acme Corp, $2,450 every other Friday", in ink. */
export function payLedgerLine({
	name,
	deposits,
}: {
	name: string;
	deposits: PayDeposit[];
}): string {
	const dates = deposits.map((deposit) => deposit.date).sort();
	const cadence = cadenceOf(dates);
	return `Pay · ${name}, ${amountWords(deposits)}${cadence ? ` ${cadence}` : ""}`;
}
