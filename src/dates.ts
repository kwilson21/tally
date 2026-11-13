// Dates stay as YYYY-MM-DD / YYYY-MM strings (spec §6). A transaction's own date is never
// converted; only "today" depends on a time zone, the household's (decision 67).

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** The household's time zone until a person chooses another in Settings (decision 67). */
export const DEFAULT_TIME_ZONE = "America/New_York";

function dateIn(timeZone: string, now: Date): string | null {
	try {
		return Temporal.Instant.fromEpochMilliseconds(now.getTime())
			.toZonedDateTimeISO(timeZone)
			.toPlainDate()
			.toString();
	} catch {
		// Temporal throws a RangeError for a time zone it doesn't know.
		return null;
	}
}

/** The calendar date (YYYY-MM-DD) right now in `timeZone`. A zone Intl doesn't know falls back to Eastern. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	// SAFETY: DEFAULT_TIME_ZONE is the fixed, valid IANA zone "America/New_York" declared above, so dateIn cannot return null for it.
	return dateIn(timeZone, now) ?? (dateIn(DEFAULT_TIME_ZONE, now) as string);
}

/**
 * The household's time zone: the one saved in `household_settings`. A missing row, an unknown zone
 * or a table that doesn't exist yet all mean Eastern; any other database error is thrown, so a
 * request never runs on a different zone than the household's.
 */
export async function householdTimeZone(db: D1Database): Promise<string> {
	try {
		const row = await db
			.prepare("SELECT value FROM household_settings WHERE key = 'time_zone'")
			.first<{ value: string }>();

		if (row?.value && dateIn(row.value, new Date()) !== null) return row.value;
	} catch (error) {
		// Only a database not yet migrated may use the default zone. Any other failure (a dropped
		// connection, an overloaded D1) must fail the request, not quietly give it another date.
		if (!(error instanceof Error && /no such table/i.test(error.message)))
			throw error;
	}

	return DEFAULT_TIME_ZONE;
}

/**
 * "Today" for the household: its date in its time zone (`householdTimeZone`). It decides the
 * current month and every bill's status.
 * A request calls this once and passes the date down, so all of it agrees near midnight.
 */
export async function householdToday(
	db: D1Database,
	now: Date = new Date(),
): Promise<string> {
	return todayIn(await householdTimeZone(db), now);
}

/** The household's month, 'YYYY-MM': the month of `householdToday` (a bill's amount applies from it). */
export async function householdMonth(
	db: D1Database,
	now: Date = new Date(),
): Promise<string> {
	return (await householdToday(db, now)).slice(0, 7);
}

/** "2026-09" → "September". */
export function monthName(month: string): string {
	return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}

/**
 * The month `n` months before 'YYYY-MM' ("2026-01", 1 → "2025-12"); a negative `n` goes forward. The year
 * keeps four digits ("0100-01", 1 → "0099-12").
 */
export function monthsBefore(month: string, n: number): string {
	return Temporal.PlainYearMonth.from(month).subtract({ months: n }).toString();
}

/** How many days 'YYYY-MM' has (28 to 31; leap years counted). */
export function daysInMonth(month: string): number {
	return Temporal.PlainYearMonth.from(month).daysInMonth;
}

/** True for exactly 'YYYY-MM' with a month from 01 to 12. Only ASCII digits, so no spaces or trailing text. */
export function isRealMonth(text: string): boolean {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(text);
}

/** True for exactly 'YYYY-MM-DD' that is a real calendar day (leap days only in leap years). */
export function isRealDate(text: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
	const month = text.slice(0, 7);
	const day = Number(text.slice(8, 10));

	return isRealMonth(month) && day >= 1 && day <= daysInMonth(month);
}

const SHORT = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "2026-05" → "May", "2026-09" → "Sep". */
export function shortMonthName(month: string): string {
	return SHORT[Number(month.slice(5, 7)) - 1] ?? month;
}

/** Month 7 and day 15 → "Jul 15", for a day that repeats each year (no year is named). */
export const monthDay = (month: number, day: number) =>
	`${SHORT[month - 1]} ${day}`;

/** "Sep 5", or "Dec 31, 2025" when its year isn't the year of `beside` (both YYYY-MM-DD). */
export function shortDay(date: string, beside: string): string {
	const label = `${SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
	const year = date.slice(0, 4);

	return year === beside.slice(0, 4) ? label : `${label}, ${year}`;
}

/** "Today, Sep 22", "Sep 21", or "Dec 31, 2025", from YYYY-MM-DD strings. */
export function dayLabel(date: string, today: string): string {
	const label = shortDay(date, today);

	return date === today ? `Today, ${label}` : label;
}

/** A day's length in milliseconds. */
export const DAY_MS = 86_400_000;

/** Whole days from 1970-01-01 to a YYYY-MM-DD date, so two dates subtract to the days between them (calendar arithmetic only, no time zones). */
export const dayNumber = (date: string) => {
	// setUTCFullYear, not Date.UTC: Date.UTC reads a year below 100 as 19xx.
	const midnight = new Date(0);
	midnight.setUTCFullYear(
		Number(date.slice(0, 4)),
		Number(date.slice(5, 7)) - 1,
		Number(date.slice(8, 10)),
	);

	return Math.floor(midnight.getTime() / DAY_MS);
};

/** The YYYY-MM-DD date of a day number from `dayNumber`. */
export const dateOfDayNumber = (day: number) =>
	new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The calendar date `days` days before a YYYY-MM-DD date (calendar arithmetic only, no time zones). */
export function daysBefore(date: string, days: number): string {
	return Temporal.PlainDate.from(date).subtract({ days }).toString();
}

/** "September", or "December 2025" when it isn't this year. */
export function monthLabel(month: string, today: string): string {
	const year = month.slice(0, 4);

	return year === today.slice(0, 4)
		? monthName(month)
		: `${monthName(month)} ${year}`;
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export const ordinal = (day: number) =>
	`${day}${day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
