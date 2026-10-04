import { formatCents, toCents } from "../money";

export type SplitPart = { categoryId: number; amountCents: number };
export type SplitResult =
	| { ok: true; parts: SplitPart[] }
	| { ok: false; error: string };

function positiveCents(value: string): number | null {
	try {
		const cents = toCents(value);
		return cents > 0 ? cents : null;
	} catch {
		return null;
	}
}

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
			text: `Adds up to ${formatCents(total)}`,
		};
	if (assigned > total)
		return {
			kind: "over" as const,
			cents: assigned - total,
			text: `${formatCents(assigned - total)} over`,
		};
	return {
		kind: "left" as const,
		cents: total - assigned,
		text: `${formatCents(total - assigned)} left to assign`,
	};
}

export function parseSplit(
	categories: string[],
	amounts: string[],
	parentCents: number,
	liveCategoryIds: number[],
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
		if (!liveCategoryIds.includes(categoryId))
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
