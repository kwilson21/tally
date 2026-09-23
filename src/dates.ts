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
