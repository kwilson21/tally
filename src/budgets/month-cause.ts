// What names a finished month's overspend (spec §8.4, decision 121). Pure: integer cents in, words out.

import { wholeUnlessTiny } from "../money";

/** Where a cause is: over its budget, a category with no budget, or the month's uncategorized money (no budget too). */
export type CauseKind = "over" | "unbudgeted" | "uncategorized";

/** One cause of a finished month's overspend, by how much it adds to the overspend. */
export type MonthCause = { name: string; cents: number; kind: CauseKind };

/** One named cause in a cause line: its words, and its kind so MonthEnd can link it to where it's listed. */
export type NamedCause = { words: string; kind: CauseKind };

/**
 * The causes of a month's overspend: each over-budget category by how far over, then each category with no budget by
 * its spending, then the month's uncategorized money as Needs a category. Only what's above $0 counts, so a refund
 * never does, and neither does a budget that wasn't exceeded.
 */
export function monthCauses(
	rows: { name: string; budgetCents: number; spentCents: number }[],
	unbudgeted: { name: string; spentCents: number }[],
	uncategorizedCents: number,
): MonthCause[] {
	return [
		...rows
			.filter((row) => row.spentCents > row.budgetCents)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents - row.budgetCents,
				kind: "over" as const,
			})),
		...unbudgeted
			.filter((row) => row.spentCents > 0)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents,
				kind: "unbudgeted" as const,
			})),
		...(uncategorizedCents > 0
			? [
					{
						name: "Needs a category",
						cents: uncategorizedCents,
						kind: "uncategorized" as const,
					},
				]
			: []),
	];
}

/**
 * The cause line for a month that ended over budget, or null: nothing for a month under budget, or with no cause to
 * name. It takes the two largest causes by amount (ties keep the order given) and says "Most of it" only when those
 * two are over half the overspend, "Part of it" otherwise. `lead` is the words before the names: when Needs a category
 * is the only cause it says it still needs a category and names just the amount; when both are over budget it says so
 * once; when both have no budget (Needs a category counts as one) it says so once; and when they mix, each names its
 * own kind. `named` has each cause's words and kind, so MonthEnd can link each one to where it's listed.
 */
export function monthCause(
	causes: MonthCause[],
	overCents: number,
): { text: string; lead: string; named: NamedCause[] } | null {
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
	const share = shareCents * 2 > overCents ? "Most of it" : "Part of it";
	const amount = (cause: MonthCause) =>
		`${cause.name} ${wholeUnlessTiny(cause.cents)}`;
	// Needs a category is the only uncategorized cause, so this is true only when it is the one cause named.
	const onlyUncategorized = largest.every(
		(cause) => cause.kind === "uncategorized",
	);
	const allOver = largest.every((cause) => cause.kind === "over");
	const noBudget = largest.every((cause) => cause.kind !== "over");
	const lead = onlyUncategorized
		? `${share} still needs a category: `
		: allOver
			? `${share} was over budget: `
			: noBudget
				? `${share} had no budget: `
				: `${share}: `;
	const named = largest.map((cause): NamedCause => {
		if (onlyUncategorized)
			return { words: wholeUnlessTiny(cause.cents), kind: cause.kind };
		if (allOver || noBudget) return { words: amount(cause), kind: cause.kind };
		return {
			words:
				cause.kind === "over"
					? `${amount(cause)} over`
					: `${amount(cause)} with no budget`,
			kind: cause.kind,
		};
	});
	return {
		text: `${lead}${named.map((name) => name.words).join(" and ")}.`,
		lead,
		named,
	};
}
