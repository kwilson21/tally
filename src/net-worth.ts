// Net worth over time for Accounts (spec §5 balance_history, §8.3, decision 64). Pure: balance rows
// in, a line and its words out. Money stays in integer cents; only the line's coordinates are
// fractions, and they are drawing, not money.

import { monthName, shortDay } from "./dates";
import { formatCents } from "./money";

/** One account's balance on one day, as `balance_history` stores it (debt as the amount owed). */
export type BalanceRow = {
	accountId: number;
	date: string;
	balanceCents: number;
	isLiability: boolean;
};

/** Net worth on one day, in cents. */
export type NetWorthPoint = { date: string; cents: number };

/** What the chart space shows: a line with its sentence, or, before two days of balances, when it starts. */
export type NetWorthView =
	| { kind: "early"; sentence: string | null; note: string }
	| {
			kind: "line";
			/** "Up $3,600 since May." */
			sentence: string;
			/** Under the line's left end, like "May"; under its right end, "Today". */
			startLabel: string;
			endLabel: string;
			/** What a screen reader hears instead of the picture. */
			description: string;
			/** The line as SVG points in a 100 × 100 box, left to right, higher net worth higher up. */
			points: string;
			/** The last point, where the line ends in a dot. */
			end: { x: number; y: number };
	  };

/**
 * The first day of the chart: the first of the month five months back. The 6 months include this
 * one so far (decision 64).
 */
export function chartStart(today: string): string {
	const index = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 6;
	const year = Math.floor(index / 12);
	return `${year}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * Net worth on each day that has a balance, oldest first, from `from` on. An account with no row on
 * a day keeps its last balance; debt (`isLiability`) subtracts, as `netWorthCents` does. The series
 * starts on the first day every account has a balance, so linking another bank later doesn't look
 * like growth.
 */
export function netWorthSeries(
	rows: BalanceRow[],
	from: string,
): NetWorthPoint[] {
	const accounts = new Set(rows.map((r) => r.accountId));
	const sorted = [...rows].sort((a, b) =>
		a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
	);
	// Each account's latest balance so far, debt negative.
	const latest = new Map<number, number>();
	const points: NetWorthPoint[] = [];
	for (const [i, r] of sorted.entries()) {
		latest.set(r.accountId, r.isLiability ? -r.balanceCents : r.balanceCents);
		// A day is finished once the next row is on a later day.
		if (sorted[i + 1]?.date === r.date) continue;
		if (latest.size < accounts.size || r.date < from) continue;
		let cents = 0;
		for (const balance of latest.values()) cents += balance;
		points.push({ date: r.date, cents });
	}
	return points;
}

const NEXT_SYNC = "The chart starts with the next sync.";

/** Where the chart's first day is named: its month, or its day when the history began this month. */
const sinceLabel = (date: string, today: string) =>
	date.slice(0, 7) === today.slice(0, 7)
		? shortDay(date, today)
		: monthName(date.slice(0, 7));

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });

const dayNumber = (date: string) =>
	Date.UTC(
		Number(date.slice(0, 4)),
		Number(date.slice(5, 7)) - 1,
		Number(date.slice(8, 10)),
	) / 86_400_000;

const tenth = (value: number) => Math.round(value * 10) / 10;

// The line stays inside this band of its 100-high box, between the top and bottom ledger rules
// (NetWorthChart draws them at 6 and 94), so the end dot never sits on one.
const TOP = 14;
const BOTTOM = 86;

/** The change as a sentence, in whole dollars: "Up $3,600 since May.", "Down $1,200 since May." */
function changeSentence(
	first: NetWorthPoint,
	last: NetWorthPoint,
	today: string,
) {
	const since = sinceLabel(first.date, today);
	const change = last.cents - first.cents;
	if (Math.abs(change) < 50) return `No change since ${since}.`;
	return `${change > 0 ? "Up" : "Down"} ${whole(Math.abs(change))} since ${since}.`;
}

/**
 * The chart space from a series: the line, its sentence and its words for screen readers, or, with
 * fewer than two days, a note on when it starts (P31). Points are spaced by their dates, so a gap
 * in syncing is a straight stretch, not a squeeze.
 */
export function netWorthView(
	points: NetWorthPoint[],
	today: string,
): NetWorthView {
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last)
		return { kind: "early", sentence: null, note: NEXT_SYNC };
	if (first === last) {
		return first.date === today
			? {
					kind: "early",
					sentence: "Tally started following your balances today.",
					note: "The chart starts tomorrow, with a second day of balances.",
				}
			: {
					kind: "early",
					sentence: `Tally started following your balances on ${shortDay(first.date, today)}.`,
					note: NEXT_SYNC,
				};
	}

	const span = dayNumber(last.date) - dayNumber(first.date);
	const lowest = Math.min(...points.map((p) => p.cents));
	const highest = Math.max(...points.map((p) => p.cents));
	const y = (cents: number) =>
		highest === lowest
			? 50
			: tenth(
					BOTTOM - ((cents - lowest) / (highest - lowest)) * (BOTTOM - TOP),
				);
	const coordinates = points.map((p) => ({
		x: tenth(((dayNumber(p.date) - dayNumber(first.date)) / span) * 100),
		y: y(p.cents),
	}));

	const sentence = changeSentence(first, last, today);
	const isToday = last.date === today;
	return {
		kind: "line",
		sentence,
		startLabel: sinceLabel(first.date, today),
		endLabel: isToday ? "Today" : shortDay(last.date, today),
		description: `Net worth over time. ${sentence} It was ${whole(first.cents)} on ${shortDay(first.date, today)} and ${isToday ? "is" : "was"} ${whole(last.cents)} ${isToday ? "today" : `on ${shortDay(last.date, today)}`}.`,
		points: coordinates.map((c) => `${c.x},${c.y}`).join(" "),
		end: coordinates.at(-1) as { x: number; y: number },
	};
}
