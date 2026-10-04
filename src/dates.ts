// Dates stay as YYYY-MM-DD / YYYY-MM strings (spec §6). No time-zone math.

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

/** Today's UTC date. The demo seed and nightly reset use the same day. */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
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
