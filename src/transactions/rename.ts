// The words of the edit panel's Rename list (decision 101, Name row round 2 A). Every number is what the
// change really does, so the words stay true: "This one only" leaves the other transactions from the
// merchant as they are, and "All" changes the merchant's transactions that have no own name of their own
// (src/db/transactions.ts saveEdit), this one included.
import { shortDay } from "../dates";

/** The line under "All" that says it reaches the transactions that come later. */
export const ALL_LATER_LINE = "And any that come later.";

/**
 * A transaction from the same merchant that has its own name (decision 79), other than this one. `part` marks
 * a split's part: it keeps its name under All, but a split purchase is already counted once in the total.
 */
export type OwnedRow = { name: string; date: string; part?: boolean };

/** "The other 22 stay as they are." under "This one only"; null when no other transaction is from the merchant. */
export function otherTransactionsLine(total: number): string | null {
	const others = total - 1;
	if (others <= 0) return null;
	return others === 1
		? "The other 1 stays as it is."
		: `The other ${others} stay as they are.`;
}

/**
 * How many transactions "All" changes: every transaction from the merchant except the others that have
 * their own name (`total` counts this one; `owned` lists the others that do, not this one). A split part
 * with its own name is not counted: the purchase it belongs to is.
 */
export function allUpdateCount({
	total,
	owned,
}: {
	total: number;
	owned: OwnedRow[];
}): number {
	return total - owned.filter((row) => !row.part).length;
}

/**
 * The label of "All": "All 23 from Amazon", never "All 0" or "All 1" ("This one and later ones") or "All 2"
 * ("Both from Amazon"). A transaction with its own name that "All" reaches adds "this one too". A count
 * below one only happens when a split part's purchase keeps its own name, and says the same one-transaction
 * words, with the owned names listed under it (allNotes).
 */
export function allLabel({
	count,
	merchant,
	thisOwn,
}: {
	count: number;
	merchant: string;
	thisOwn: boolean;
}): string {
	if (count <= 1) return "This one and later ones";
	const thisToo = thisOwn ? ", this one too" : "";
	return count === 2
		? `Both from ${merchant}${thisToo}`
		: `All ${count} from ${merchant}${thisToo}`;
}

/**
 * The muted lines under "All" about names it would replace or keep: this transaction's own name is
 * replaced, and each other own-named transaction keeps its name, with its date.
 */
export function allNotes({
	thisOwn,
	owned,
	today,
}: {
	thisOwn: string | null;
	owned: OwnedRow[];
	today: string;
}): string[] {
	const notes = thisOwn ? [`${thisOwn} is replaced.`] : [];
	for (const row of owned)
		notes.push(
			`${row.name} (${shortDay(row.date, today)}) keeps its own name.`,
		);
	return notes;
}

/**
 * A one-off name makes Tally guess the category again, from the purchase's own name (decision 101), when
 * the category is Tally's (`jev`) or empty and the person didn't pick a different one in the same save.
 * This covers the store's own name under This one only too, which is a one-off name as well. A merchant-wide
 * rename and a name that didn't change ask nothing. Tally guesses only while Jev answers categories
 * (`jevCategories`); with it off the category is left as it is.
 */
export function oneOffGuessesAgain({
	edit,
	current,
	postedCategory,
}: {
	edit: {
		nameChanged?: boolean;
		nameScope?: "one" | "all";
		jevCategories?: boolean;
	};
	current: { categoryId: number | null; categorySource: string | null };
	postedCategory: number | null;
}): boolean {
	if (edit.jevCategories !== true) return false;
	if (edit.nameChanged === false || edit.nameScope !== "one") return false;
	if (postedCategory !== null && postedCategory !== current.categoryId)
		return false;
	return (
		current.categorySource === "jev" ||
		(current.categoryId === null && current.categorySource === null)
	);
}
