// The demo's months as Home's month strip reads them (monthResults): each finished month's budgets less its spending,
// null with no budget. The catalog and the proposal pictures that draw the strip read these, so they show the demo's
// results and can't disagree with its Home. The current month (October) is left out: the strip never reads it.
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
	"2026-08": -13359,
	"2026-09": -213447,
};
