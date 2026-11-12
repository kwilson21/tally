import { formatCents, toCents } from "../money";

export type SplitPart = { categoryId: number; amountCents: number };

export type SplitResult =
	| { ok: true; parts: SplitPart[] }
	| { ok: false; error: string };

/**
 * What partsAddUp can add exactly (docs/verification.md, "Numbers"): no part above $100,000,000 and at most 1,000 parts, so
 * the parts add up to at most 1e13 cents, far under the 2^53 a double holds exactly. A split past a limit is refused in words.
 */
export const MAX_SPLIT_CENTS = 10_000_000_000;
export const MAX_SPLIT_PARTS = 1_000;

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

	if (categories.length > MAX_SPLIT_PARTS)
		return { ok: false, error: `Use at most ${MAX_SPLIT_PARTS} parts.` };
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

		if (cents > MAX_SPLIT_CENTS)
			return {
				ok: false,
				error: `Enter an amount of ${formatCents(MAX_SPLIT_CENTS, { wholeDollars: true })} or less for part ${i + 1}.`,
			};
		parts.push({ categoryId, amountCents: cents * sign });
	}

	if (!partsAddUp(parts, parentCents))
		return {
			ok: false,
			error: "The parts must add up exactly to the transaction amount.",
		};

	return { ok: true, parts };
}

/**
 * Whether these parts are a real split of a transaction: at least two, each with the transaction's sign (a zero amount
 * takes positive parts) and none zero, adding up to its amount exactly. Checked by LemmaScript and Dafny (decision 188),
 * both ways: it is true exactly when all of that holds. The transaction's amount is a safe integer (Plaid's
 * plaidAmountToCents rejects larger, cash entry checks it), and parseSplit keeps the parts inside the limits above.
 */
export function partsAddUp(parts: SplitPart[], parentCents: number): boolean {
	//@ verify
	//@ requires parts.length <= MAX_SPLIT_PARTS
	//@ requires forall(i: nat, i < parts.length ==> -MAX_SPLIT_CENTS <= parts[i].amountCents && parts[i].amountCents <= MAX_SPLIT_CENTS)
	//@ requires -9007199254740991 <= parentCents && parentCents <= 9007199254740991
	//@ ensures \result <==> (parts.length >= 2 && partSumTo(parts, parts.length) === parentCents && forall(i: nat, i < parts.length ==> ((parentCents < 0 && parts[i].amountCents < 0) || (parentCents >= 0 && parts[i].amountCents > 0))))
	//@ type i nat
	let sum = 0;
	let signed = true;
	let i = 0;

	while (i < parts.length) {
		//@ invariant 0 <= i && i <= parts.length
		//@ invariant sum === partSumTo(parts, i)
		//@ invariant signed <==> forall(j: nat, j < i ==> ((parentCents < 0 && parts[j].amountCents < 0) || (parentCents >= 0 && parts[j].amountCents > 0)))
		//@ decreases parts.length - i
		// SAFETY: the loop runs only while i < parts.length, so parts[i] is a part.
		const part = parts[i] as SplitPart;
		sum = sum + part.amountCents;

		if (
			(parentCents < 0 && part.amountCents >= 0) ||
			(parentCents >= 0 && part.amountCents <= 0)
		)
			signed = false;
		i = i + 1;
	}

	return parts.length >= 2 && signed && sum === parentCents;
}

/** What partsAddUp's contract compares against: the plain sum of the first n parts. */
export function partSumTo(parts: SplitPart[], n: number): number {
	//@ verify
	//@ type n nat
	//@ requires n <= parts.length
	//@ decreases n
	if (n === 0) return 0;
	// SAFETY: n is at least 1 here and the contract requires n <= parts.length, so parts[n - 1] is a part.
	const part = parts[n - 1] as SplitPart;

	return partSumTo(parts, n - 1) + part.amountCents;
}
