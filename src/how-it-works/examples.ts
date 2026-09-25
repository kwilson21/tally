// The worked examples on the How Tally works page (spec §9), written by code from the demo's own
// numbers. Exact cents, so budget − spent always equals the result shown.
import type { MonthSummary } from "../budget";
import { formatCents } from "../money";

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

export function budgetExample(
	s: Pick<
		MonthSummary,
		"totalBudgetCents" | "totalSpentCents" | "safeToSpendCents"
	>,
): string {
	// What was set aside for bills is whatever makes the sum add up (spec §6); 0 until bills ship.
	const billsCents =
		s.totalBudgetCents - s.totalSpentCents - s.safeToSpendCents;
	const bills =
		billsCents > 0 ? ` − ${formatCents(billsCents)} for bills due` : "";
	return `${formatCents(s.totalBudgetCents)} budget − ${formatCents(s.totalSpentCents)} spent${bills} = ${formatCents(s.safeToSpendCents)} safe to spend.`;
}

export function transactionsExample(c: {
	counted: number;
	needsCategory: number;
}): string {
	const needs =
		c.needsCategory === 0
			? "every one has a category"
			: plural(c.needsCategory, "needs a category", "need a category");
	return `This month has ${plural(c.counted, "counted transaction", "counted transactions")}, and ${needs}.`;
}

export function categorizationExample(c: {
	user: number;
	merchantRule: number;
	jev: number;
	/** Jev picked a category but wasn't sure enough to apply it. */
	unsure: number;
	/** Jev said none of the categories fit. */
	noneFit: number;
	/** Needs a category and Jev hasn't been asked yet. */
	notYetAsked: number;
}): string {
	const parts: string[] = [];
	if (c.jev > 0) {
		parts.push(
			`Jev categorized ${plural(c.jev, "transaction", "transactions")}.`,
		);
	}
	const left: string[] = [];
	if (c.unsure > 0) left.push(`${c.unsure} it wasn't sure about`);
	if (c.noneFit > 0) left.push(`${c.noneFit} that fit none of the categories`);
	if (left.length > 0) {
		parts.push(
			`${c.jev > 0 ? "It" : "Jev"} left ${left.join(" and ")} for a person.`,
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
	if (parts.length === 0) return "Nothing has been categorized yet this month.";
	return `This month, ${parts.join(" ")}`;
}
