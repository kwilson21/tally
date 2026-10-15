// The bills step's words and its one-tap split (P125 E, spec §8.8, #579): the repeat charges Possible bills found, of
// which a charge with no category, over $100,000, or whose name collides with another found charge or an active bill
// waits in Possible bills instead of being kept in one tap.
import type { BillSuggestion } from "../bills/find";
import { BIG_BILL_CENTS, sameBillName } from "../bills/guards";
import { formatCents } from "../money";
import { dollarsWords } from "./pay";

/** A total about a month, in whole dollars ("$1,972"). */
const wholeDollars = (cents: number) =>
	formatCents(cents, { wholeDollars: true });

/** The found charges, split: `keep` is the one-tap answer, and `waiting` stays in Possible bills. */
export function splitKeepable(
	suggestions: BillSuggestion[],
	activeNames: string[],
): { keep: BillSuggestion[]; waiting: BillSuggestion[] } {
	const keep: BillSuggestion[] = [];
	const waiting: BillSuggestion[] = [];
	for (const suggestion of suggestions) {
		const collides =
			suggestions.some(
				(other) =>
					other !== suggestion &&
					sameBillName(other.displayName, suggestion.displayName),
			) ||
			activeNames.some((name) => sameBillName(name, suggestion.displayName));
		const leftOut =
			suggestion.categoryId === null ||
			suggestion.amountCents > BIG_BILL_CENTS ||
			collides;
		(leftOut ? waiting : keep).push(suggestion);
	}
	return { keep, waiting };
}

/**
 * The words before the link to Possible bills: "1 more waits in" or "2 more wait in" (the link ends the sentence), or
 * null when none waits.
 */
export function waitingWords(count: number): string | null {
	if (count === 0) return null;
	return count === 1 ? "1 more waits in" : `${count} more wait in`;
}

/** The question: "Keep these 8 as bills?", or "Keep this one as a bill?" for one. */
export function keepHeading(count: number): string {
	return count === 1
		? "Keep this one as a bill?"
		: `Keep these ${count} as bills?`;
}

/**
 * The muted line above the bills question: how many charges come back every month, their total, and the first three
 * with their amounts ("…and 1 more").
 */
export function billsMutedLine(charges: BillSuggestion[]): string {
	const total = charges.reduce((sum, charge) => sum + charge.amountCents, 0);
	const named = charges
		.slice(0, 3)
		.map(
			(charge) => `${charge.displayName} ${dollarsWords(charge.amountCents)}`,
		);
	const more = charges.length - named.length;
	const list =
		more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
	const count = charges.length;
	const noun =
		count === 1 ? "charge that comes back" : "charges that come back";
	return `Your bank shows ${count} ${noun} every month, about ${wholeDollars(total)} in all: ${list}.`;
}

/** The ledger line a kept bills step writes: "Bills · 8 kept, about $2,062 a month", in ink. */
export function billsLedgerLine(count: number, cents: number): string {
	return `Bills · ${count} kept, about ${wholeDollars(cents)} a month`;
}
