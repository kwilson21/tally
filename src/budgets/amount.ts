// The budget sheet's one field (#66): a dollar amount, read into integer cents (spec §7).
import * as z from "zod";
import { toCents } from "../money";

/** $1,000,000 a month: far above any household budget, and well inside exact integer cents. */
export const MAX_BUDGET_CENTS = 100_000_000;

const NOT_DOLLARS = "Enter a dollar amount, like 250 or 250.50.";

/**
 * The typed budget as integer cents, at the edge (decision 191): text in, cents out, or one of the two sentences. It's
 * required: a budget can't be removed yet (spec §12). toCents throws for text it can't read, so it is caught here.
 */
export const BudgetAmount = z.string().transform((text, ctx) => {
	let cents: number;
	try {
		cents = toCents(text.trim() === "" ? "x" : text);
	} catch {
		cents = -1;
	}
	if (cents >= 0 && cents <= MAX_BUDGET_CENTS) return cents;
	ctx.issues.push({
		code: "custom",
		message:
			cents < 0
				? NOT_DOLLARS
				: "Keep the budget to $1,000,000 a month or less.",
		input: text,
	});
	return z.NEVER;
});

/** Reads the typed budget, as the sheets use it: the cents, or the sentence to show. */
export function parseBudgetAmount(
	text: string,
): { ok: true; cents: number } | { ok: false; error: string } {
	const read = BudgetAmount.safeParse(text);
	return read.success
		? { ok: true, cents: read.data }
		: { ok: false, error: read.error.issues[0]?.message ?? NOT_DOLLARS };
}

/** A category's id from the address: a whole number above zero. */
export const CategoryId = z.coerce.number().pipe(z.int().positive());

/** Which way a nudge goes, from the address. */
export const NudgeDirection = z.enum(["up", "down"]);
