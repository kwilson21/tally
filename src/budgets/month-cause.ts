// What names a finished month's overspend (spec §8.4, decision 121). Pure: integer cents in, words out.

import { wholeUnlessTiny } from "../money";

/** One cause of a finished month's overspend: an over-budget category by how far over, or a category with no budget by its spending. */
export type MonthCause = { name: string; cents: number; budgeted: boolean };

/**
 * The causes of a month's overspend: each over-budget category by how far over, then each category with no budget by
 * its spending. Only what's above $0 counts, so a refund never does, and neither does a budget that wasn't exceeded.
 * Uncategorized spending is not a category, so it isn't a cause.
 */
export function monthCauses(
	rows: { name: string; budgetCents: number; spentCents: number }[],
	unbudgeted: { name: string; spentCents: number }[],
): MonthCause[] {
	return [
		...rows
			.filter((row) => row.spentCents > row.budgetCents)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents - row.budgetCents,
				budgeted: true,
			})),
		...unbudgeted
			.filter((row) => row.spentCents > 0)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents,
				budgeted: false,
			})),
	];
}

/**
 * The cause line for a month that ended over budget, or null: nothing for a month under budget, or with no cause to
 * name. It takes the two largest causes by amount (ties keep the order given) and says "Most of it" only when those
 * two are over half the overspend, "Part of it" otherwise. When both are unbudgeted it says so once, when both are over
 * budget once, and when they mix each names its own. `toNotBudgeted` is true when a named cause is one with no budget,
 * so the line links to the Not budgeted list; otherwise it links to the bars.
 */
export function monthCause(
	causes: MonthCause[],
	overCents: number,
): { text: string; toNotBudgeted: boolean } | null {
	if (overCents <= 0) return null;
	const largest = causes
		.filter((cause) => cause.cents > 0)
		.map((cause, index) => ({ cause, index }))
		.sort((a, b) => b.cause.cents - a.cause.cents || a.index - b.index)
		.slice(0, 2)
		.sort((a, b) => a.index - b.index)
		.map(({ cause }) => cause);
	if (largest.length === 0) return null;
	const shareCents = largest.reduce((sum, cause) => sum + cause.cents, 0);
	const lead = shareCents * 2 > overCents ? "Most of it" : "Part of it";
	const amount = (cause: MonthCause) =>
		`${cause.name} ${wholeUnlessTiny(cause.cents)}`;
	const toNotBudgeted = largest.some((cause) => !cause.budgeted);
	if (largest.every((cause) => !cause.budgeted))
		return {
			text: `${lead} had no budget: ${largest.map(amount).join(" and ")}.`,
			toNotBudgeted,
		};
	if (largest.every((cause) => cause.budgeted))
		return {
			text: `${lead} was over budget: ${largest.map(amount).join(" and ")}.`,
			toNotBudgeted,
		};
	const each = largest.map((cause) =>
		cause.budgeted
			? `${amount(cause)} over`
			: `${amount(cause)} with no budget`,
	);
	return { text: `${lead}: ${each.join(" and ")}.`, toNotBudgeted };
}
