// The budget sheet's one field (#66): a dollar amount, read into integer cents (spec §7).
import { toCents } from "../money";

/** $1,000,000 a month: far above any household budget, and well inside exact integer cents. */
export const MAX_BUDGET_CENTS = 100_000_000;

const NOT_DOLLARS = "Enter a dollar amount, like 250 or 250.50.";

/** Reads the typed budget. It's required: a budget can't be removed yet (spec §12). */
export function parseBudgetAmount(
	text: string,
): { ok: true; cents: number } | { ok: false; error: string } {
	let cents: number;
	try {
		cents = toCents(text.trim() === "" ? "x" : text);
	} catch {
		return { ok: false, error: NOT_DOLLARS };
	}
	if (cents < 0) return { ok: false, error: NOT_DOLLARS };
	if (cents > MAX_BUDGET_CENTS)
		return {
			ok: false,
			error: "Keep the budget to $1,000,000 a month or less.",
		};
	return { ok: true, cents };
}
