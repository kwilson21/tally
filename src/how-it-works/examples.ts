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
	return `${formatCents(s.totalBudgetCents)} budget − ${formatCents(s.totalSpentCents)} spent = ${formatCents(s.safeToSpendCents)} safe to spend.`;
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
	unsure: number;
}): string {
	const parts: string[] = [];
	if (c.jev > 0) {
		parts.push(
			`Jev picked ${plural(c.jev, "category", "categories")} on its own${
				c.unsure > 0
					? ` and left ${c.unsure} it wasn't sure about for a person`
					: ""
			}.`,
		);
	} else if (c.unsure > 0) {
		parts.push(`Jev left ${c.unsure} it wasn't sure about for a person.`);
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
