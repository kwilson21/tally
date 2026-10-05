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
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(now);
		const part = (type: string) =>
			parts.find((p) => p.type === type)?.value ?? "";
		return `${part("year")}-${part("month")}-${part("day")}`;
	} catch {
		// Intl throws a RangeError for a time zone it doesn't know.
		return null;
	}
}

/** The calendar date (YYYY-MM-DD) right now in `timeZone`. A zone Intl doesn't know falls back to Eastern. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
	return dateIn(timeZone, now) ?? (dateIn(DEFAULT_TIME_ZONE, now) as string);
}

/**
 * "Today" for the household: its date in the time zone saved in `household_settings`.
 * It decides the current month and every bill's status. A missing row, an unknown zone or a
 * table that doesn't exist yet all mean Eastern; any other database error is thrown, so a
 * request never runs on a different date than the household's.
 * A request calls this once and passes the date down, so all of it agrees near midnight.
 */
export async function householdToday(
	db: D1Database,
	now: Date = new Date(),
): Promise<string> {
	let timeZone = DEFAULT_TIME_ZONE;
	try {
		const row = await db
			.prepare("SELECT value FROM household_settings WHERE key = 'time_zone'")
			.first<{ value: string }>();
		if (row?.value) timeZone = row.value;
	} catch (error) {
		// Only a database not yet migrated may use the default zone. Any other failure (a dropped
		// connection, an overloaded D1) must fail the request, not quietly give it another date.
		if (!(error instanceof Error && /no such table/i.test(error.message)))
			throw error;
	}
	return todayIn(timeZone, now);
}

/** "2026-09" → "September". */
export function monthName(month: string): string {
	return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
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

/** The calendar date `days` days before a YYYY-MM-DD date (calendar arithmetic only, no time zones). */
export function daysBefore(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
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
