import { formatCents, toCents } from "../money";

export type SplitPart = { categoryId: number; amountCents: number };
export type SplitResult =
	| { ok: true; parts: SplitPart[] }
	| { ok: false; error: string };

export function positiveCents(value: string): number | null {
	try {
		const cents = toCents(value);
		return cents > 0 ? cents : null;
	} catch {
		return null;
	}
}

/**
 * The split's live sentence in three parts (#676, decision 128): `figures` is only the amount, the part that lines up in
 * tabular figures; `before` and `after` are the words around it. Joined, they are the sentence's text.
 */
export function splitStatus(parentCents: number, amounts: string[]) {
	const assigned = amounts.reduce(
		(sum, value) => sum + (positiveCents(value) ?? 0),
		0,
	);
	const total = Math.abs(parentCents);
	if (assigned === total)
		return {
			kind: "done" as const,
			cents: assigned,
			before: "Adds up to ",
			figures: formatCents(total),
			after: "",
		};
	if (assigned > total)
		return {
			kind: "over" as const,
			cents: assigned - total,
			before: "",
			figures: formatCents(assigned - total),
			after: " over",
		};
	return {
		kind: "left" as const,
		cents: total - assigned,
		before: "",
		figures: formatCents(total - assigned),
		after: " left to assign",
	};
}

/**
 * Checks a split sheet's rows. A row takes an active category (`liveCategoryIds`), or the one archived
 * category its saved part already has (`keptCategoryIds[i]`, Change the parts only); nothing else.
 */
export function parseSplit(
	categories: string[],
	amounts: string[],
	parentCents: number,
	liveCategoryIds: number[],
	keptCategoryIds: (number | undefined)[] = [],
): SplitResult {
	if (
		categories.length < 2 ||
		amounts.length < 2 ||
		categories.length !== amounts.length
	)
		return { ok: false, error: "Add at least two parts." };
	const sign = parentCents < 0 ? -1 : 1;
	const parts: SplitPart[] = [];
	for (let i = 0; i < categories.length; i++) {
		const categoryId = Number(categories[i]);
		if (
			!liveCategoryIds.includes(categoryId) &&
			categoryId !== keptCategoryIds[i]
		)
			return { ok: false, error: `Pick a category for part ${i + 1}.` };
		const cents = positiveCents(amounts[i] ?? "");
		if (cents === null)
			return {
				ok: false,
				error: `Enter an amount above $0 for part ${i + 1}.`,
			};
		parts.push({ categoryId, amountCents: cents * sign });
	}
	if (parts.reduce((sum, part) => sum + part.amountCents, 0) !== parentCents)
		return {
			ok: false,
			error: "The parts must add up exactly to the transaction amount.",
		};
	return { ok: true, parts };
}
