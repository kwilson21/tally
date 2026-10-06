// The worked examples on the How Tally works page (spec §9), written by code from the demo's own
// numbers. Exact cents, so budget − spent always equals the result shown.
import type { MonthSummary } from "../budget";
import { monthName } from "../dates";
import { formatCents } from "../money";
import { type TrendsPage, trendsAmount } from "../trends";

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

export function budgetExample(
	s: Pick<
		MonthSummary,
		| "totalBudgetCents"
		| "totalSpentCents"
		| "safeToSpendCents"
		| "uncategorized"
	> & { unbudgetedCents: number; billsDueCents: number },
): string {
	const uncategorizedCents = s.uncategorized.spentCents;
	const budgetsLeftCents =
		s.totalBudgetCents -
		s.totalSpentCents +
		uncategorizedCents +
		s.unbudgetedCents;
	const differenceCents =
		uncategorizedCents + s.unbudgetedCents + s.billsDueCents;
	const amount = (cents: number) =>
		formatCents(cents, { wholeDollars: cents % 100 === 0 });
	return `Your budgets have ${amount(budgetsLeftCents)} left. Safe to spend is ${amount(differenceCents)} less: ${amount(uncategorizedCents)} has no category yet, ${amount(s.unbudgetedCents)} went to categories with no budget, and ${amount(s.billsDueCents)} is set aside for bills due.`;
}

/**
 * Net worth in two sums, from the accounts Accounts adds up (a disconnected bank's are left out, as
 * its headline does): what they hold, less what is owed. Null when no account counts.
 */
export function netWorthExample(
	accounts: {
		balanceCents: number;
		isLiability: boolean;
		connected?: boolean;
	}[],
): string | null {
	const counted = accounts.filter((a) => a.connected !== false);
	if (counted.length === 0) return null;
	const held = counted
		.filter((a) => !a.isLiability)
		.reduce((sum, a) => sum + a.balanceCents, 0);
	const owed = counted
		.filter((a) => a.isLiability)
		.reduce((sum, a) => sum + a.balanceCents, 0);
	if (owed === 0)
		return `${formatCents(held)} in accounts and nothing owed, so net worth is ${formatCents(held)}.`;
	return `${formatCents(held)} in accounts − ${formatCents(owed)} owed = ${formatCents(held - owed)} net worth.`;
}

export function transactionsExample(c: {
	counted: number;
	needsCategory: number;
}): string {
	const needs =
		c.needsCategory === 0
			? "every one has a category"
			: plural(c.needsCategory, "needs a category", "need a category");
	if (c.counted === 0) return "No transaction counts this month yet.";
	return `This month has ${plural(c.counted, "counted transaction", "counted transactions")}, and ${needs}.`;
}

/** "a, b and c": a list as a sentence says it. */
const listed = (items: string[]) =>
	items.length < 2
		? items.join("")
		: `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The Trends section's example, from the page's own numbers: the first category that's going well,
 * else the first worth a look, else this month so far against the same days last month. Null before
 * there's a full month to compare, when the section says so in a plain sentence instead.
 */
export function trendsExample(page: TrendsPage): string | null {
	if (page.kind !== "full") return null;
	const [good] = page.goingWell;
	if (good) {
		// The run is the months before the last point (this month, still going).
		const end = good.months.length - 1;
		const names = good.months
			.slice(end - good.run, end)
			.map((m) => monthName(m.month));
		return `${good.name} stayed under its budget in ${listed(names)}, so it's going well.`;
	}
	const [watch] = page.worthALook;
	if (watch) {
		const last = watch.months.length - 2;
		const from = watch.months[last - watch.run];
		const to = watch.months[last];
		if (from && to)
			return `${watch.name} spent more each month from ${monthName(from.month)} to ${monthName(to.month)}, so it's worth a look.`;
	}
	const [now = "", then = ""] = page.caption.split(" against ");
	return `${now}: ${trendsAmount(page.sameDaysCents.now)} spent, against ${trendsAmount(page.sameDaysCents.last)} for ${then}.`;
}

/** This month's excluded transactions by why: flagged transfer, flagged reimbursement, or a person's choice. */
export type ExcludedBreakdown = {
	transfer: number;
	reimbursement: number;
	byPerson: number;
};

export const excludedTotal = (b: ExcludedBreakdown) =>
	b.transfer + b.reimbursement + b.byPerson;

export function exclusionsExample(b: ExcludedBreakdown): string {
	const total = excludedTotal(b);
	if (total === 0) return "Nothing is excluded this month.";
	const kinds = listed(
		[
			b.transfer > 0 && plural(b.transfer, "transfer", "transfers"),
			b.reimbursement > 0 &&
				plural(b.reimbursement, "reimbursement", "reimbursements"),
			b.byPerson > 0 && `${b.byPerson} excluded by a person`,
		].filter((k): k is string => Boolean(k)),
	);
	return total === 1
		? `This month, 1 transaction is excluded (${kinds}), so it doesn't count toward spending or safe to spend.`
		: `This month, ${total} transactions are excluded (${kinds}), so they don't count toward spending or safe to spend.`;
}

export function categorizationExample(
	c: {
		user: number;
		merchantRule: number;
		jev: number;
		/** Jev picked a category but wasn't sure enough to apply it. */
		unsure: number;
		/** Jev said none of the categories fit. */
		noneFit: number;
		/** Needs a category and Jev hasn't been asked yet. */
		notYetAsked: number;
		/** Income with no category: it needs none. */
		income: number;
		heldForReview?: number;
	},
	/** What to call the AI: "Tally" on screens, "Jev" only on the demo's page (decision 64). */
	ai: "Jev" | "Tally" = "Tally",
): string {
	const parts: string[] = [];
	if (c.jev > 0) {
		parts.push(
			`${ai} categorized ${plural(c.jev, "transaction", "transactions")}.`,
		);
	}
	const left: string[] = [];
	if (c.unsure > 0) left.push(`${c.unsure} it wasn't sure about`);
	if (c.noneFit > 0) left.push(`${c.noneFit} that fit none of the categories`);
	if (left.length > 0) {
		parts.push(
			`${c.jev > 0 ? "It" : ai} left ${left.join(" and ")} for a person.`,
		);
	}
	if (c.notYetAsked > 0) {
		parts.push(
			`${c.notYetAsked} ${c.notYetAsked === 1 ? "is" : "are"} waiting for tonight's run.`,
		);
	}
	if (c.merchantRule > 0)
		parts.push(`${c.merchantRule} came from merchant rules.`);
	if (c.user > 0)
		parts.push(
			`${c.user} ${c.user === 1 ? "was" : "were"} chosen by a person.`,
		);
	if (c.income > 0)
		parts.push(
			`${c.income} ${c.income === 1 ? "is" : "are"} income, which needs no category.`,
		);
	if (c.heldForReview && c.heldForReview > 0)
		parts.push(
			`${c.heldForReview} ${c.heldForReview === 1 ? "credit is" : "credits are"} held for review and ${c.heldForReview === 1 ? "doesn't" : "don't"} count toward spending yet.`,
		);
	if (parts.length === 0) return "Nothing has been categorized yet this month.";
	return `This month, ${parts.join(" ")}`;
}
