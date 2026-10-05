// Trends (spec §8.3): the numbers, sentences and bar shapes on the Trends page. Pure functions: rows
// in, words and geometry out. Nothing here reads a database or draws markup. All money is integer
// cents, formatted only into the sentences; code writes every sentence, never AI.
import { type BudgetAmount, budgetForMonth } from "./budget";
import {
	daysInMonth,
	monthName,
	monthsBefore,
	shortDay,
	shortMonthName,
} from "./dates";
import { formatCents } from "./money";

/** How many months Trends draws: the five before this one, and this one so far. */
export const TREND_MONTHS = 6;
/** Months in a row a category must be under budget, or up, to be Going well or Worth a look. */
export const RUN_MONTHS = 3;

export type TrendCategory = {
	id: number;
	name: string;
	icon: string;
	color: string;
	archived: boolean;
};

/** One category's counted spending in one month ('YYYY-MM'); a null category is uncategorized. */
export type MonthSpend = {
	month: string;
	categoryId: number | null;
	cents: number;
};

/**
 * One month of a series. The month still going is `partial`: it's drawn dashed and never judged.
 * The first month of history is a part month (`part`): Tally can't tell how much of it is there, so
 * it's drawn striped and never judged or compared. `from` is the date history starts, when it's
 * known to be in that month.
 */
export type MonthPoint = {
	month: string;
	cents: number;
	partial: boolean;
	part?: { from: string | null };
};

/** "$1,240", or "$0.30" under a dollar so a small amount never reads "$0" (as Home's Band does). */
export function trendsAmount(cents: number): string {
	return formatCents(cents, {
		wholeDollars: Math.abs(cents) >= 100 || cents === 0,
	});
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The days Trends compares: this month's so far against days 1 to today's day-of-month of last
 * month, clamped to last month's length (on Mar 31, all of February).
 */
export function sameDays(today: string) {
	const month = today.slice(0, 7);
	const lastMonth = monthsBefore(month, 1);
	const day = Number(today.slice(8, 10));
	const lastDay = Math.min(day, daysInMonth(lastMonth));
	return {
		month,
		lastMonth,
		day,
		lastDay,
		/** The last date of last month the comparison counts, YYYY-MM-DD. */
		lastThrough: `${lastMonth}-${pad(lastDay)}`,
	};
}

/** "Oct 1–5 against Sep 1–5": the two ranges the numbers cover. */
export function sameDaysCaption(today: string): string {
	const { month, lastMonth, day, lastDay } = sameDays(today);
	const range = (m: string, d: number) =>
		`${shortMonthName(m)} ${d === 1 ? "1" : `1–${d}`}`;
	return `${range(month, day)} against ${range(lastMonth, lastDay)}`;
}

/** "$90 less than by this time in September.", the sentence under the headline. */
export function compareSentence(
	nowCents: number,
	thenCents: number,
	lastMonth: string,
): string {
	const gap = nowCents - thenCents;
	const by = `by this time in ${monthName(lastMonth)}`;
	// Whole dollars would read "$0 less"; under a dollar is the same, in words.
	if (Math.abs(gap) < 100) return `About the same as ${by}.`;
	return `${trendsAmount(Math.abs(gap))} ${gap < 0 ? "less" : "more"} than ${by}.`;
}

export type Direction = "up" | "down" | "same";

/** A category's change in words, with the direction its arrow points: "Up $31". */
export function changeWords(
	nowCents: number,
	thenCents: number,
): { direction: Direction; words: string } {
	const gap = nowCents - thenCents;
	if (gap === 0) return { direction: "same", words: "No change" };
	return gap > 0
		? { direction: "up", words: `Up ${trendsAmount(gap)}` }
		: { direction: "down", words: `Down ${trendsAmount(-gap)}` };
}

/**
 * The months in a row, ending with the latest, a category spent no more than its budget (Home's
 * "over" is more than the budget). Each month is judged against the budget it had; a month with no
 * budget isn't under one, so it ends the run. Oldest first.
 */
export function underBudgetRun(
	cents: number[],
	budgets: (number | null)[],
): number {
	let run = 0;
	for (let i = cents.length - 1; i >= 0; i--) {
		const budget = budgets[i];
		if (budget === null || budget === undefined || (cents[i] ?? 0) > budget)
			break;
		run += 1;
	}
	return run;
}

/** The months in a row, ending with the latest, that spending went up on the month before. Oldest first. */
export function risingRun(cents: number[]): number {
	let run = 0;
	for (let i = cents.length - 1; i >= 1; i--) {
		if ((cents[i] ?? 0) <= (cents[i - 1] ?? 0)) break;
		run += 1;
	}
	return run;
}

/**
 * The months Trends draws: the six ending with this one, but only from the month Tally's history
 * starts in, so a household two months in sees two. Always includes this month.
 */
export function shownMonths(today: string, startMonth: string): string[] {
	const thisMonth = today.slice(0, 7);
	const months = Array.from({ length: TREND_MONTHS }, (_, i) =>
		monthsBefore(thisMonth, TREND_MONTHS - 1 - i),
	).filter((m) => m >= startMonth);
	return months.includes(thisMonth) ? months : [thisMonth];
}

/** A chart's numbers in words, for a screen reader: "Spending by month: May $820, …, October so far $196." */
export function monthsLabel(points: MonthPoint[], subject: string): string {
	const parts = points.map((p) => {
		const started = p.part
			? ` (${p.part.from ? `from ${shortDay(p.part.from, p.part.from)}` : "part month"})`
			: "";
		return `${monthName(p.month)}${p.partial ? " so far" : ""}${started} ${trendsAmount(p.cents)}`;
	});
	return `${subject} by month: ${parts.join(", ")}.`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export type MiniBar = {
	x: number;
	y: number;
	width: number;
	height: number;
	/** The last one, the month still going. */
	dashed: boolean;
};

/**
 * Six small bars on a 96 by 32 drawing, each month taller by its amount against the row's tallest.
 * A short history sits at the right, where the latest months are; a month with nothing (or less
 * than nothing, when refunds outweigh spending) stays a thin line.
 */
export function miniBars(cents: number[]): MiniBar[] {
	const max = Math.max(0, ...cents);
	const offset = Math.max(0, TREND_MONTHS - cents.length);
	return cents.map((c, i) => {
		const height = Math.max(
			1,
			max > 0 ? round1((30 * Math.max(c, 0)) / max) : 0,
		);
		return {
			x: (i + offset) * 16 + 3,
			y: round1(31 - height),
			width: 10,
			height,
			dashed: i === cents.length - 1,
		};
	});
}

/** The size of the larger all-spending chart's drawing, and the rules on it. */
export const MONTH_BARS = {
	width: 350,
	height: 170,
	top: 22,
	bottom: 146,
	rules: 4,
} as const;

export type MonthBar = {
	x: number;
	y: number;
	width: number;
	height: number;
	dashed: boolean;
	/** A part month (the first month of history): drawn striped. */
	part: boolean;
	/** "$2,860", drawn above the bar. */
	amount: string;
	/** "Sep", or "Oct so far" for the month still going. */
	label: string;
};

/** All spending by month as bars on ledger rules, each month's amount above it (the early state). */
export function monthBars(points: MonthPoint[]): MonthBar[] {
	const { width, top, bottom } = MONTH_BARS;
	const max = Math.max(0, ...points.map((p) => p.cents));
	const slot = width / TREND_MONTHS;
	const offset = Math.max(0, TREND_MONTHS - points.length);
	return points.map((p, i) => {
		const height = Math.max(
			2,
			max > 0 ? round1(((bottom - top) * Math.max(p.cents, 0)) / max) : 0,
		);
		return {
			x: round1((i + offset) * slot + slot * 0.2),
			y: round1(bottom - height),
			width: round1(slot * 0.6),
			height,
			dashed: p.partial,
			part: p.part !== undefined,
			amount: trendsAmount(p.cents),
			label: p.partial
				? `${shortMonthName(p.month)} so far`
				: shortMonthName(p.month),
		};
	});
}

// ---------------------------------------------------------------------------------------------

export type TrendsInput = {
	/** The household's date (YYYY-MM-DD, decision 67); it decides this month and the days compared. */
	today: string;
	/** The date of the earliest transaction of any kind, or null when there are none. */
	firstDate: string | null;
	/** Every category, in Home's order. */
	categories: TrendCategory[];
	amounts: BudgetAmount[];
	/** Counted spending (spec §6) by the month it counts in and its category, for the months drawn. */
	spend: MonthSpend[];
	/** Counted spending dated on last month's days 1 to today's day-of-month, by category. */
	sameDays: { categoryId: number | null; cents: number }[];
};

/** A category's row: its line in words and its months as bars. */
export type TrendRowData = {
	id: number;
	name: string;
	icon: string;
	color: string;
	/** "4 months under budget", "Up 3 months running" or "$150 in September". */
	line: string;
	/** The months in a row the line counts (3 or more), or 0 for a row in no group. */
	run: number;
	/** A muted second line: "Still under budget" under a Worth a look row that is also under budget. */
	note: string | null;
	months: MonthPoint[];
	/** The months' amounts in words, for a screen reader. */
	label: string;
};

/** One category's change from the same days last month to this month so far. */
export type ChangeData = {
	/** Null for money counted but not in a category. */
	id: number | null;
	name: string;
	icon: string;
	color: string;
	nowCents: number;
	thenCents: number;
	direction: Direction;
	/** "Up $31" */
	words: string;
	/** "$92, was $61" */
	detail: string;
};

export type TrendsPage =
	| { kind: "empty" }
	| {
			/** Before there's a full month to compare: all spending by month, and when Tally started. */
			kind: "early";
			startMonthName: string;
			months: MonthPoint[];
			label: string;
	  }
	| {
			kind: "full";
			monthName: string;
			lastMonthName: string;
			soFarCents: number;
			sentence: string;
			caption: string;
			/** The two sides of the comparison, in cents. */
			sameDaysCents: { now: number; last: number };
			changes: ChangeData[];
			goingWell: TrendRowData[];
			worthALook: TrendRowData[];
			others: TrendRowData[];
			/** "May to October": the months the rows draw. */
			rangeLabel: string;
	  };

/** Money counted but in no category, in Home's words ("N transactions need a category"). */
const NEEDS_A_CATEGORY = { name: "Needs a category", icon: "list", color: "" };

/**
 * The Trends page from its rows. Tally can't tell whether the month its history starts in is
 * complete, so that month is drawn but never judged or compared; this month isn't over, so it
 * isn't either. A category up three months running is Worth a look, even when it's also under its
 * budget; otherwise one under budget three months running is Going well. Archived categories are
 * never in either group.
 */
export function buildTrends(input: TrendsInput): TrendsPage {
	const { firstDate } = input;
	if (firstDate === null) return { kind: "empty" };
	const thisMonth = input.today.slice(0, 7);
	const { lastMonth } = sameDays(input.today);
	// The month history starts in: the first transaction's, or an earlier month a payment counts in.
	const startMonth = input.spend.reduce(
		(first, row) => (row.month < first ? row.month : first),
		firstDate.slice(0, 7),
	);
	const months = shownMonths(input.today, startMonth);
	const judged = months.filter((m) => m > startMonth && m < thisMonth);

	const spent = new Map<string, number>();
	const totals = new Map<string, number>();
	for (const row of input.spend) {
		const key = `${row.month}|${row.categoryId ?? ""}`;
		spent.set(key, (spent.get(key) ?? 0) + row.cents);
		totals.set(row.month, (totals.get(row.month) ?? 0) + row.cents);
	}
	const cents = (month: string, id: number | null) =>
		spent.get(`${month}|${id ?? ""}`) ?? 0;
	const total = (month: string) => totals.get(month) ?? 0;
	const points = (id: number | null): MonthPoint[] =>
		months.map((m) => ({
			month: m,
			cents: cents(m, id),
			partial: m === thisMonth,
		}));
	// The first month of history may be only part of a month: say so, and from when if it's known.
	const firstMonth = firstDate.slice(0, 7);
	const allPoints = months.map((m): MonthPoint => {
		const point = { month: m, cents: total(m), partial: m === thisMonth };
		return m === startMonth
			? {
					...point,
					part: { from: m === firstMonth ? firstDate : null },
				}
			: point;
	});

	if (judged.length === 0) {
		return {
			kind: "early",
			startMonthName: monthName(startMonth),
			months: allPoints,
			label: monthsLabel(allPoints, "All spending"),
		};
	}

	const before = new Map<number | null, number>();
	for (const row of input.sameDays)
		before.set(row.categoryId, (before.get(row.categoryId) ?? 0) + row.cents);

	// Active categories, and an archived one only while it has spending in the months drawn or in
	// last month's compared days. A purchase and its refund in different halves of last month net
	// $0 for the month but not for those days, and the changes must still add up to the comparison.
	const hasSpending = (id: number) => points(id).some((p) => p.cents !== 0);
	const shown = input.categories.filter(
		(c) => !c.archived || hasSpending(c.id) || (before.get(c.id) ?? 0) !== 0,
	);

	const goingWell: TrendRowData[] = [];
	const worthALook: TrendRowData[] = [];
	const others: TrendRowData[] = [];
	for (const c of shown) {
		const series = points(c.id);
		const row = (
			line: string,
			run = 0,
			note: string | null = null,
		): TrendRowData => ({
			id: c.id,
			name: c.name,
			icon: c.icon,
			color: c.color,
			line,
			run,
			note,
			months: series,
			label: monthsLabel(series, "Spending"),
		});
		const judgedCents = judged.map((m) => cents(m, c.id));
		const rising = risingRun(judgedCents);
		const under = underBudgetRun(
			judgedCents,
			judged.map((m) => budgetForMonth(input.amounts, c.id, m)),
		);
		if (!c.archived && rising >= RUN_MONTHS) {
			// Also under budget three months running: it would be Going well, so say it still is.
			worthALook.push(
				row(
					`Up ${rising} months running`,
					rising,
					under >= RUN_MONTHS ? "Still under budget" : null,
				),
			);
		} else if (!c.archived && under >= RUN_MONTHS) {
			goingWell.push(row(`${under} months under budget`, under));
		} else if (hasSpending(c.id)) {
			others.push(
				row(
					`${trendsAmount(cents(lastMonth, c.id))} in ${monthName(lastMonth)}`,
				),
			);
		}
	}

	const changes = [
		...shown.map((c) => ({ ...c })),
		{ id: null, ...NEEDS_A_CATEGORY },
	]
		.map((c, order) => {
			const nowCents = cents(thisMonth, c.id);
			const thenCents = before.get(c.id) ?? 0;
			return { c, order, nowCents, thenCents };
		})
		.filter((e) => e.nowCents !== 0 || e.thenCents !== 0)
		.sort(
			(a, b) =>
				Math.abs(b.nowCents - b.thenCents) -
					Math.abs(a.nowCents - a.thenCents) || a.order - b.order,
		)
		.map(
			({ c, nowCents, thenCents }): ChangeData => ({
				id: c.id,
				name: c.name,
				icon: c.icon,
				color: c.color,
				nowCents,
				thenCents,
				...changeWords(nowCents, thenCents),
				detail: `${trendsAmount(nowCents)}, was ${trendsAmount(thenCents)}`,
			}),
		);

	const soFarCents = total(thisMonth);
	const thenTotal = input.sameDays.reduce((sum, row) => sum + row.cents, 0);
	return {
		kind: "full",
		monthName: monthName(thisMonth),
		lastMonthName: monthName(lastMonth),
		soFarCents,
		sentence: compareSentence(soFarCents, thenTotal, lastMonth),
		caption: sameDaysCaption(input.today),
		sameDaysCents: { now: soFarCents, last: thenTotal },
		changes,
		goingWell,
		worthALook,
		others,
		rangeLabel: `${monthName(months[0] ?? thisMonth)} to ${monthName(thisMonth)}`,
	};
}
