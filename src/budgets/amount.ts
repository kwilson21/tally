// The budget sheet's one field (#66): a dollar amount, read into integer cents (spec §7).
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { readAtEdge, readText } from "../edge";
import { toCents } from "../money";

/** $1,000,000 a month: far above any household budget, and well inside exact integer cents. */
export const MAX_BUDGET_CENTS = 100_000_000;

const NOT_DOLLARS = "Enter a dollar amount, like 250 or 250.50.";

/**
 * The typed budget as integer cents, at the edge (decision 206): text in, cents out, or one of the two sentences. It's
 * required: a budget can't be removed yet (spec §12). toCents throws for text it can't read, so it is caught here.
 */
export const BudgetAmount = Schema.String.pipe(
	Schema.decodeTo(Schema.Number, {
		decode: readText<number>((text) => {
			let cents: number;

			try {
				cents = toCents(text.trim() === "" ? "x" : text);
			} catch {
				cents = -1;
			}

			if (cents < 0) return { say: NOT_DOLLARS };

			return cents <= MAX_BUDGET_CENTS
				? { value: cents }
				: { say: "Keep the budget to $1,000,000 a month or less." };
		}),
		encode: SchemaGetter.transform((cents: number) => (cents / 100).toFixed(2)),
	}),
);

/** Reads the typed budget, as the sheets use it: the cents, or the sentence to show. */
export function parseBudgetAmount(
	text: string,
): { ok: true; cents: number } | { ok: false; error: string } {
	const read = readAtEdge(BudgetAmount, text);

	return read.ok
		? { ok: true, cents: read.value }
		: { ok: false, error: read.say };
}

/** Which way a nudge goes, from the address. */
export const NudgeDirection = Schema.Literals(["up", "down"]);
