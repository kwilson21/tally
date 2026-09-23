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

/** "Today, Sep 22", "Sep 21", or "Dec 31, 2025", from YYYY-MM-DD strings. */
export function dayLabel(date: string, today: string): string {
	const label = `${SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
	if (date === today) return `Today, ${label}`;
	const year = date.slice(0, 4);
	return year === today.slice(0, 4) ? label : `${label}, ${year}`;
}

/** "September", or "December 2025" when it isn't this year. */
export function monthLabel(month: string, today: string): string {
	const year = month.slice(0, 4);
	return year === today.slice(0, 4)
		? monthName(month)
		: `${monthName(month)} ${year}`;
}
