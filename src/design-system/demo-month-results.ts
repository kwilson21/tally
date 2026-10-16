// The demo's months as Home's month strip reads them (monthResults): each finished month's budgets less its spending,
// null with no budget. These are the results when the demo is reset for 2026-10-16: resetDemo builds the seed relative
// to today, so the month keys hold only for that day, and test/month-results.test.ts pins that date and checks every
// value. The catalog and the proposal pictures that draw the strip read these. The current month (October) is left out:
// the strip never reads it.
export const DEMO_MONTH_RESULTS: Record<string, number | null> = {
	"2025-11": null,
	"2025-12": null,
	"2026-01": null,
	"2026-02": null,
	"2026-03": null,
	"2026-04": null,
	"2026-05": 31000,
	"2026-06": 9800,
	"2026-07": 31500,
	"2026-08": 14352,
	"2026-09": -213447,
};
