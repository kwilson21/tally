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
//@ skip
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
	//@ extern
	// Trusted, not checked: a generic function with a callback is outside LemmaScript's model (docs/verification.md).
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

/**
 * What summarizeMonth can add up exactly (docs/verification.md, "Numbers"). Its rules are proved for whole numbers of any
 * size, but a double holds a whole number exactly only up to 2^53 (about 9.0e15), so the proof describes what runs only
 * while every sum stays under that. With no amount above 1e10 cents ($100 million), at most 1e5 counted transactions and
 * 1e4 categories, spending is under 1e15, budgets under 1e14, and the four other terms under 4e10 together, so every
 * running sum, positive or negative, is exact. A month past a limit is refused instead of silently miscounted.
 */
export const MAX_CENTS_PER_AMOUNT = 10_000_000_000;
export const MAX_COUNTED_TRANSACTIONS = 100_000;
export const MAX_CATEGORIES = 10_000;

/** Whether an amount is a whole number of cents inside the limit (an absent one is fine: it counts as zero). */
function fits(cents: number | null | undefined): boolean {
	if (cents === null || cents === undefined) return true;

	return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS_PER_AMOUNT;
}

/** Refuses a month past the limits above. The message names no amount: transaction details are never logged. */
//@ skip
function assertWithinLimits(input: MonthInput): void {
	if (
		input.transactions.length > MAX_COUNTED_TRANSACTIONS ||
		input.categories.length > MAX_CATEGORIES ||
		!input.transactions.every((t) => fits(t.amountCents)) ||
		!input.amounts.every((a) => fits(a.amountCents)) ||
		!fits(input.unpaidDueBillsCents) ||
		!fits(input.savingsGoalCents) ||
		!fits(input.unpaidPlansCents)
	)
		throw new RangeError(
			"This month has more money or more rows than Tally can add up exactly.",
		);
}

/** An absent amount counts as zero. The contracts below use it to say what the month's totals are. */
export function orZero(cents: number | null | undefined): number {
	//@ verify
	return cents ?? 0;
}

export function summarizeMonth(input: MonthInput): MonthSummary {
	assertWithinLimits(input);

	return summarizeWithinLimits(input);
}

// Checked by LemmaScript and Dafny (decision 188). The rules, in plain words: total spent, income and uncategorized
// (amount and count) are each exactly the sum over the transactions, so none is counted twice or dropped; each category
// row's spent is exactly the sum of that category's transactions; and Safe to spend is the stated sum. A category with
// spending but no budget yet has no row, so rows plus uncategorized need not equal total spent, and no rule says they do.
function summarizeWithinLimits(input: MonthInput): MonthSummary {
	//@ verify
	//@ requires input.transactions.length <= MAX_COUNTED_TRANSACTIONS && input.categories.length <= MAX_CATEGORIES
	//@ requires forall(i: nat, i < input.transactions.length ==> -MAX_CENTS_PER_AMOUNT <= input.transactions[i].amountCents && input.transactions[i].amountCents <= MAX_CENTS_PER_AMOUNT)
	//@ requires forall(i: nat, i < input.amounts.length ==> -MAX_CENTS_PER_AMOUNT <= input.amounts[i].amountCents && input.amounts[i].amountCents <= MAX_CENTS_PER_AMOUNT)
	//@ requires -MAX_CENTS_PER_AMOUNT <= input.unpaidDueBillsCents && input.unpaidDueBillsCents <= MAX_CENTS_PER_AMOUNT
	//@ requires -MAX_CENTS_PER_AMOUNT <= orZero(input.savingsGoalCents) && orZero(input.savingsGoalCents) <= MAX_CENTS_PER_AMOUNT
	//@ requires -MAX_CENTS_PER_AMOUNT <= orZero(input.unpaidPlansCents) && orZero(input.unpaidPlansCents) <= MAX_CENTS_PER_AMOUNT
	//@ ensures forall(j: nat, j < \result.categories.length ==> \result.categories[j].spentCents === catTo(input.transactions, input.transactions.length, \result.categories[j].id))
	//@ ensures \result.totalSpentCents === outTo(input.transactions, input.transactions.length)
	//@ ensures \result.incomeCents === inTo(input.transactions, input.transactions.length)
	//@ ensures \result.uncategorized.spentCents === uncatTo(input.transactions, input.transactions.length)
	//@ ensures \result.uncategorized.count === uncatCountTo(input.transactions, input.transactions.length)
	//@ ensures \result.safeToSpendCents === \result.totalBudgetCents - \result.totalSpentCents - input.unpaidDueBillsCents - orZero(input.savingsGoalCents) - orZero(input.unpaidPlansCents)
	const spentByCategory = new Map<number, number>();
	let uncategorizedCents = 0;
	let uncategorizedCount = 0;
	let incomeCents = 0;
	let totalSpentCents = 0;

	for (const t of input.transactions) {
		//@ invariant forall(k: number, spentByCategory.has(k) ==> spentByCategory.get(k) === catTo(input.transactions, _t_idx, k))
		//@ invariant forall(k: number, !spentByCategory.has(k) ==> catTo(input.transactions, _t_idx, k) === 0)
		//@ invariant totalSpentCents === outTo(input.transactions, _t_idx)
		//@ invariant incomeCents === inTo(input.transactions, _t_idx)
		//@ invariant uncategorizedCents === uncatTo(input.transactions, _t_idx)
		//@ invariant uncategorizedCount === uncatCountTo(input.transactions, _t_idx)
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
		//@ invariant forall(j: nat, j < categories.length ==> categories[j].spentCents === catTo(input.transactions, input.transactions.length, categories[j].id))
		const budgetCents = budgetForMonth(input.amounts, c.id, input.month);

		if (budgetCents === null) continue;
		const spentCents = spentByCategory.get(c.id) ?? 0;
		const leftCents = budgetCents - spentCents;
		categories.push({
			id: c.id,
			name: c.name,
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

// The status sentence is words, not money rules (docs/verification.md), and Intl is outside LemmaScript's model.
//@ skip
const listFormat = new Intl.ListFormat("en-US", {
	style: "long",
	type: "conjunction",
});

//@ skip
/** " 2 bills are overdue." (with its leading space), or nothing at 0: the clause Home's status line ends with. */
export function overdueBillsClause(overdueBills: number): string {
	if (overdueBills <= 0) return "";

	return ` ${overdueBills} ${overdueBills === 1 ? "bill is" : "bills are"} overdue.`;
}

//@ skip
/** The one-line status under the headline, written by code from the numbers (never by AI). Overdue bills are said once, plainly, since a sentence about the budgets alone must not read as "all is well" over them. */
export function statusSentence(
	categories: CategorySummary[],
	overdueBills = 0,
): string {
	const bills = overdueBillsClause(overdueBills);

	if (categories.length === 0) return `No budgets set yet.${bills}`;
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
		// SAFETY: the length check on the line above proves `over` holds exactly one category.
		const [only] = over as [CategorySummary];
		const amount = -only.leftCents;
		const text = formatCents(amount, { wholeDollars: amount % 100 === 0 });

		return `${only.name} is ${text} over.${rest}${bills}`;
	}

	return `${listFormat.format(over.map((c) => c.name))} are over.${rest}${bills}`;
}

// What the contracts on summarizeWithinLimits compare against: plain sums over the first n transactions, written as
// the simplest recursion so each reads as the rule it names. They are exported only so the type checker sees them used.

/** Money out: every non-income amount. */
export function outTo(txs: CountedTransaction[], n: number): number {
	//@ verify
	//@ type n nat
	//@ requires n <= txs.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= txs.length, so txs[n - 1] is a transaction.
	const t = txs[n - 1] as CountedTransaction;

	return outTo(txs, n - 1) + (t.income ? 0 : t.amountCents);
}

/** Money in, as a positive amount: Plaid's money in is negative. */
export function inTo(txs: CountedTransaction[], n: number): number {
	//@ verify
	//@ type n nat
	//@ requires n <= txs.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= txs.length, so txs[n - 1] is a transaction.
	const t = txs[n - 1] as CountedTransaction;

	return inTo(txs, n - 1) + (t.income ? -t.amountCents : 0);
}

/** Money out with no category. */
export function uncatTo(txs: CountedTransaction[], n: number): number {
	//@ verify
	//@ type n nat
	//@ requires n <= txs.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= txs.length, so txs[n - 1] is a transaction.
	const t = txs[n - 1] as CountedTransaction;

	return (
		uncatTo(txs, n - 1) +
		(!t.income && t.categoryId === null ? t.amountCents : 0)
	);
}

/** How many uncategorized money-out rows count toward the "needs a category" number: a linked refund does not. */
export function uncatCountTo(txs: CountedTransaction[], n: number): number {
	//@ verify
	//@ type n nat
	//@ requires n <= txs.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= txs.length, so txs[n - 1] is a transaction.
	const t = txs[n - 1] as CountedTransaction;

	return (
		uncatCountTo(txs, n - 1) +
		(!t.income && t.categoryId === null && !t.linked ? 1 : 0)
	);
}

/** Money out in one category. */
export function catTo(
	txs: CountedTransaction[],
	n: number,
	id: number,
): number {
	//@ verify
	//@ type n nat
	//@ requires n <= txs.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= txs.length, so txs[n - 1] is a transaction.
	const t = txs[n - 1] as CountedTransaction;

	return (
		catTo(txs, n - 1, id) +
		(!t.income && t.categoryId === id ? t.amountCents : 0)
	);
}
