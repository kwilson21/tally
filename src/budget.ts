// Budget math from spec §6. Pure functions: rows in, numbers out. All amounts are integer cents.

export type BudgetAmount = { categoryId: number; effectiveMonth: string; amountCents: number };
export type Category = { id: number; name: string };
/** A counted transaction: in the month, not excluded, not a split parent (the query guarantees this). */
export type CountedTransaction = { categoryId: number | null; amountCents: number; income: boolean };

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
	safeToSpendCents: number;
};

/** The budget for a category in a month: the latest amount effective on or before that month, or null. */
export function budgetForMonth(amounts: BudgetAmount[], categoryId: number, month: string): number | null {
	let best: BudgetAmount | undefined;
	for (const a of amounts) {
		if (a.categoryId !== categoryId || a.effectiveMonth > month) continue;
		if (!best || a.effectiveMonth > best.effectiveMonth) best = a;
	}
	return best ? best.amountCents : null;
}

type MonthInput = {
	month: string;
	categories: Category[];
	amounts: BudgetAmount[];
	transactions: CountedTransaction[];
	/** Bills due or overdue this month and not paid (0 until Phase 3 adds bills). */
	unpaidDueBillsCents: number;
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
			uncategorizedCount += 1;
		} else {
			spentByCategory.set(t.categoryId, (spentByCategory.get(t.categoryId) ?? 0) + t.amountCents);
		}
	}

	const categories: CategorySummary[] = [];
	for (const c of input.categories) {
		const budgetCents = budgetForMonth(input.amounts, c.id, input.month);
		if (budgetCents === null) continue;
		const spentCents = spentByCategory.get(c.id) ?? 0;
		const leftCents = budgetCents - spentCents;
		categories.push({ ...c, budgetCents, spentCents, leftCents, over: leftCents < 0 });
	}

	const totalBudgetCents = categories.reduce((sum, c) => sum + c.budgetCents, 0);

	return {
		month: input.month,
		categories,
		uncategorized: { spentCents: uncategorizedCents, count: uncategorizedCount },
		incomeCents,
		totalBudgetCents,
		totalSpentCents,
		safeToSpendCents: totalBudgetCents - totalSpentCents - input.unpaidDueBillsCents,
	};
}
