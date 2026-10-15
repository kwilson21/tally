// The first budget's suggestion (spec §6, decision 114): pure money logic in whole cents. A category's suggestion is the
// mean of its Spent over the last three full calendar months Tally has, rounded up to the next $10. It is only offered:
// nothing is saved until a person says yes (§8.8, decision 101).
import { monthsBefore } from "../dates";
import { MAX_BUDGET_CENTS } from "./amount";

export type MonthSpent = {
	/** 'YYYY-MM'. */
	month: string;
	/** The month's counted Spent for the category (or, for uncategorized spending, its counted amount), in cents. */
	spentCents: number;
};

/**
 * The full calendar months this suggestion may use, oldest first: up to the last three months before today's month,
 * and only those after `firstCountedMonth`, since the first counted month is a part month (Plaid's history starts
 * partway through it, so it never counts). The current month is never full. No history means none.
 */
export function fullMonths(
	firstCountedMonth: string | null,
	today: string,
): string[] {
	if (firstCountedMonth === null) return [];
	const current = today.slice(0, 7);
	const earliest = monthsBefore(firstCountedMonth, -1);
	const months: string[] = [];
	for (let n = 3; n >= 1; n -= 1) {
		const month = monthsBefore(current, n);
		if (month >= earliest) months.push(month);
	}
	return months;
}

export type FirstBudgetSuggestion = {
	/** The suggested monthly budget in cents, a whole $10 and no more than the largest budget (MAX_BUDGET_CENTS). */
	amountCents: number;
	/** The months it came from, oldest first (a month with no spending is $0 and still counts). */
	months: MonthSpent[];
};

/**
 * A category's suggested budget, or null when it has none: no full month, a mean of $0 or less, or a rounded amount over
 * the largest budget. `ceil(mean / 1000) * 1000` is computed as `ceil(total / (months * 1000)) * 1000` in integers, so a
 * mean of exactly a $10 multiple stays where it is, and one cent over rounds up.
 */
export function firstBudgetSuggestion(
	months: MonthSpent[],
): FirstBudgetSuggestion | null {
	if (months.length === 0) return null;
	const total = months.reduce((sum, month) => sum + month.spentCents, 0);
	if (total <= 0) return null;
	const amountCents = Math.ceil(total / (months.length * 1000)) * 1000;
	if (amountCents > MAX_BUDGET_CENTS) return null;
	return { amountCents, months };
}

/**
 * The monthly mean of spending with no category over the same full months, in whole cents, rounded down (so a negative
 * mean rounds away from zero). Null with no full month. It is shown beside the suggestions, never saved.
 */
export function monthlyMeanCents(months: MonthSpent[]): number | null {
	if (months.length === 0) return null;
	const total = months.reduce((sum, month) => sum + month.spentCents, 0);
	return Math.floor(total / months.length);
}
