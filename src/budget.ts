// Budget math from spec §6. Pure functions: rows in, numbers out. All amounts are integer cents.

import { formatCents } from "./money";

export type BudgetAmount = {
	categoryId: number;
	effectiveMonth: string;
	amountCents: number;
};
export type SavingsGoalAmount = { effectiveMonth: string; amountCents: number };
export type Category = { id: number; name: string };
/** A counted transaction: in the month, not excluded, not a split parent (the query guarantees this). */
export type CountedTransaction = {
	categoryId: number | null;
	amountCents: number;
	income: boolean;
	/** A refund linked to its purchase: its money counts, but its purchase is the row to categorize. */
	linked?: boolean;
};

export type CategorySummary = Category & {
	budgetCents: number;
	spentCents: number;
	leftCents: number;
	over: boolean;
};

export type MonthSummary = {
	month: string;
	categories: CategorySummary[];
	uncategorized: { spentCents: number; count: number };
	incomeCents: number;
	totalBudgetCents: number;
	totalSpentCents: number;
	savingsGoalCents?: number;
	/** Planned one-time expenses set aside this month (spec §6, decision 74). */
	plannedCents: number;
	safeToSpendCents: number;
};

/** The latest amount effective on or before the month, optionally limited by a matching rule. */
function latestEffectiveAmount<
	T extends { effectiveMonth: string; amountCents: number },
>(
	amounts: T[],
	month: string,
	matches: (amount: T) => boolean = () => true,
): number | null {
	let best: T | undefined;
	for (const amount of amounts) {
		if (!matches(amount) || amount.effectiveMonth > month) continue;
		if (!best || amount.effectiveMonth > best.effectiveMonth) best = amount;
	}
	return best?.amountCents ?? null;
}

/** The budget for a category in a month, or null if it has not started yet. */
export function budgetForMonth(
	amounts: BudgetAmount[],
	categoryId: number,
	month: string,
): number | null {
	return latestEffectiveAmount(
		amounts,
		month,
		(amount) => amount.categoryId === categoryId,
	);
}

/** The savings goal for a month: its latest amount effective on or before that month, or null. */
export function savingsGoalForMonth(
	amounts: SavingsGoalAmount[],
	month: string,
): number | null {
	return latestEffectiveAmount(amounts, month);
}

type MonthInput = {
	month: string;
	categories: Category[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
	/** Bills due or overdue this month and not paid (0 until Phase 3 adds bills). */
	unpaidDueBillsCents: number;
	/** The full monthly savings goal, set aside from the first day of the month. */
	savingsGoalCents?: number | null;
	/**
	 * Planned one-time expenses set aside (spec §6, decision 74): this month's, and any from an earlier month not yet
	 * moved, dropped or paid, whose payment isn't linked. The plan's own payment is never counted here, only its set-aside.
	 */
	unpaidPlansCents?: number;
};

export function summarizeMonth(input: MonthInput): MonthSummary {
	const spentByCategory = new Map<number, number>();
	let uncategorizedCents = 0;
	let uncategorizedCount = 0;
	let incomeCents = 0;
	let totalSpentCents = 0;

	for (const t of input.transactions) {
		if (t.income) {
			incomeCents -= t.amountCents; // money in is negative under Plaid's convention
			continue;
		}
		totalSpentCents += t.amountCents;
		if (t.categoryId === null) {
			uncategorizedCents += t.amountCents;
			if (!t.linked) uncategorizedCount += 1;
		} else {
			spentByCategory.set(
				t.categoryId,
				(spentByCategory.get(t.categoryId) ?? 0) + t.amountCents,
			);
		}
	}

	const categories: CategorySummary[] = [];
	for (const c of input.categories) {
		const budgetCents = budgetForMonth(input.amounts, c.id, input.month);
		if (budgetCents === null) continue;
		const spentCents = spentByCategory.get(c.id) ?? 0;
		const leftCents = budgetCents - spentCents;
		categories.push({
			...c,
			budgetCents,
			spentCents,
			leftCents,
			over: leftCents < 0,
		});
	}

	const totalBudgetCents = categories.reduce(
		(sum, c) => sum + c.budgetCents,
		0,
	);

	return {
		month: input.month,
		categories,
		uncategorized: {
			spentCents: uncategorizedCents,
			count: uncategorizedCount,
		},
		incomeCents,
		totalBudgetCents,
		totalSpentCents,
		savingsGoalCents: input.savingsGoalCents ?? 0,
		plannedCents: input.unpaidPlansCents ?? 0,
		safeToSpendCents:
			totalBudgetCents -
			totalSpentCents -
			input.unpaidDueBillsCents -
			(input.savingsGoalCents ?? 0) -
			(input.unpaidPlansCents ?? 0),
	};
}

const listFormat = new Intl.ListFormat("en-US", {
	style: "long",
	type: "conjunction",
});

/** " 2 bills are overdue." (with its leading space), or nothing at 0: the clause Home's status line ends with. */
export function overdueBillsClause(overdueBills: number): string {
	if (overdueBills <= 0) return "";
	return ` ${overdueBills} ${overdueBills === 1 ? "bill is" : "bills are"} overdue.`;
}

/** The one-line status under the headline, written by code from the numbers (never by AI). Overdue bills are said once, plainly, since a sentence about the budgets alone must not read as "all is well" over them. */
export function statusSentence(
	categories: CategorySummary[],
	overdueBills = 0,
): string {
	if (categories.length === 0) return "No budgets set yet.";
	const bills = overdueBillsClause(overdueBills);
	const over = categories.filter((c) => c.over);
	if (over.length === 0)
		return overdueBills > 0
			? `Budgets are on track.${bills}`
			: "Everything is on track.";
	const rest =
		over.length < categories.length
			? overdueBills > 0
				? " Other budgets are on track."
				: " Everything else is on track."
			: "";
	if (over.length === 1) {
		const [only] = over as [CategorySummary];
		const amount = -only.leftCents;
		const text = formatCents(amount, { wholeDollars: amount % 100 === 0 });
		return `${only.name} is ${text} over.${rest}${bills}`;
	}
	return `${listFormat.format(over.map((c) => c.name))} are over.${rest}${bills}`;
}
