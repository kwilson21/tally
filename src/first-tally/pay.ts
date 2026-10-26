// The pay step's words (P125 E, decision 114, spec §8.8): one merchant whose money in Tally marked as income. Every
// number comes from the deposits the bank sent, so nothing here is typed in.
import { BILL_FIND_MAX_DAYS, BILL_FIND_MIN_DAYS } from "../bills/find";
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
 * How often the deposits came, from the gaps between their distinct days (two on one day count once). Each cadence
 * needs every gap in its own window: every week, or every weekday when all the deposits share one weekday, when every
 * gap is 6 to 8 days; every other week, or every other weekday when they share one (what a fortnightly paycheck does, a
 * holiday shift aside), when every gap is 13 to 15; twice a month, every gap 12 to 19 (a 1st-and-15th payday moved for
 * weekends); or every month, every gap 25 to 35, the same "about a month" window the bill finder uses. Null when no
 * cadence fits every gap (a skipped week, or one long gap among short ones, is none of them).
 */
export function cadenceOf(dates: string[]): string | null {
	const sorted = [...new Set(dates)].sort();
	if (sorted.length < 2) return null;
	const gaps = sorted
		.slice(1)
		.map((date, i) => epochDay(date) - epochDay(sorted[i] as string));
	const every = (low: number, high: number) =>
		gaps.every((gap) => gap >= low && gap <= high);
	const latest = sorted[sorted.length - 1] as string;
	const oneWeekday = sorted.every(
		(date) => weekdayOf(date) === weekdayOf(latest),
	);
	if (every(6, 8))
		return oneWeekday ? `every ${weekdayOf(latest)}` : "every week";
	if (every(13, 15))
		return oneWeekday ? `every other ${weekdayOf(latest)}` : "every other week";
	if (every(12, 19)) return "twice a month";
	if (every(BILL_FIND_MIN_DAYS, BILL_FIND_MAX_DAYS)) return "every month";
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

/**
 * The setup question's lead (P142 A): "Tally found money that comes in regularly from one place." when the deposits have a
 * cadence (cadenceOf); otherwise, since a single deposit or irregular ones don't come in regularly, "…that comes in from one
 * place.".
 */
export function payLead(dates: string[]): string {
	return cadenceOf(dates)
		? "Tally found money that comes in regularly from one place."
		: "Tally found money that comes in from one place.";
}

/**
 * The setup card's line under the merchant's amount: the cadence capitalized with the count and the first day ("Every other
 * Friday · 7 times since Jul 17"), with no cadence "7 times since Jul 17", and a single deposit "Once, on Jul 17". Unlike
 * paySentence, it shows the cadence even when the amounts vary, since the card shows their range above it.
 */
export function payCadenceLine(deposits: PayDeposit[]): string {
	const dates = deposits.map((deposit) => deposit.date).sort();
	const first = dates[0] as string;
	const latest = dates[dates.length - 1] as string;
	if (deposits.length === 1) return `Once, on ${shortDay(first, latest)}`;
	const cadence = cadenceOf(dates);
	const since = `${deposits.length} times since ${shortDay(first, latest)}`;
	return cadence
		? `${cadence.charAt(0).toUpperCase()}${cadence.slice(1)} · ${since}`
		: since;
}

/**
 * The card's deposit rows: the three latest by date, newest first, and how many earlier deposits there are ("And 4 earlier").
 */
export function latestDeposits(deposits: PayDeposit[]): {
	shown: PayDeposit[];
	earlier: number;
} {
	const newest = [...deposits].sort((a, b) => b.date.localeCompare(a.date));
	return {
		shown: newest.slice(0, 3),
		earlier: Math.max(0, newest.length - 3),
	};
}

/** One deposit's day on the card: its weekday's first three letters and the day, "Fri, Oct 9" (shortDay names a year when it differs). */
export function depositDay(date: string, latest: string): string {
	return `${(weekdayOf(date) ?? "").slice(0, 3)}, ${shortDay(date, latest)}`;
}

/**
 * The value a pay form's hidden `deposit` field carries for each deposit the question shows: its transaction id, merchant
 * key, day and cents. `ids[i]` goes with `deposits[i]` (payMerchants builds them in step), so a value is what the page showed of it.
 */
export function shownPayValues({
	key,
	ids,
	deposits,
}: {
	key: string;
	ids: number[];
	deposits: PayDeposit[];
}): string[] {
	return deposits.map((deposit, i) =>
		JSON.stringify({
			id: ids[i] as number,
			key,
			date: deposit.date,
			cents: deposit.cents,
		}),
	);
}

/**
 * Whether a pay answer's submitted values are exactly the merchant's deposits now: as a set, the same size, and every
 * current value among them. So a deposit that arrived since the page drew, or one whose merchant key, day or cents
 * changed in place, fails it, and so do an empty or garbled submission.
 */
export function payShown(
	merchant: { key: string; ids: number[]; deposits: PayDeposit[] },
	values: string[],
): boolean {
	const current = shownPayValues(merchant);
	const submitted = new Set(values);
	return (
		submitted.size === current.length &&
		current.every((value) => submitted.has(value))
	);
}
