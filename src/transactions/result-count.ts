// The result count above the list. It names every active filter, so any filter change changes
// its text and the aria-live region announces it, even when the number stays the same (#56).
import { monthLabel } from "../dates";
import { formatCents } from "../money";
import {
	type Filters,
	type SearchMatch,
	type Show,
	searchAmount,
} from "./filters";

type Page = { total: number; first: number; shown: number; pages: number };

const NO_MATCH: SearchMatch = { category: false, allByAmount: false };

/** The word before "transactions" for each Show choice; All says nothing. */
const TYPE_WORDS: Record<Show, string> = {
	all: "",
	spending: "spending ",
	income: "income ",
	refunds: "refund ",
	excluded: "excluded ",
};

/**
 * What a search matched, in brackets after its text (#211): the amount it names, to the cent or across the
 * dollar, or "(category)" when a row matched by a category's name. A plain number names its amount only
 * when every row matched by it, since it also finds names and notes; a mixed count names no amount.
 */
function matchNote(q: string, matched: SearchMatch): string {
	const amount = searchAmount(q);
	if (amount && (!amount.plain || matched.allByAmount)) {
		return amount.exact
			? ` (amount ${formatCents(amount.low)})`
			: ` (amounts ${formatCents(amount.low)} to ${formatCents(amount.high)})`;
	}
	return matched.category ? " (category)" : "";
}

/**
 * The count in three parts (#676, decision 128): `figures` is only the numbers, the part that lines up in
 * tabular figures; `before` and `after` are the words around them. Joined, they are the count's text.
 */
export function resultCountParts(
	{ total, first, shown, pages }: Page,
	f: Filters,
	categoryName: string | null,
	today: string,
	accountName: string | null = null,
	matched: SearchMatch = NO_MATCH,
): { before: string; figures: string; after: string } {
	const paged = pages > 1;
	const noun = `${TYPE_WORDS[f.show]}transaction${total === 1 ? "" : "s"}`;
	const month = f.month === "all" ? "all months" : monthLabel(f.month, today);
	// The category and the account come first, then the month: "in Groceries, Chase Card ••9921, October".
	const named = [categoryName, accountName].filter(Boolean);
	const where = `in ${[...named, month].join(", ")}`;
	const rest = [
		noun,
		f.uncategorized && "needing a category",
		f.q && `matching "${f.q}"${f.raw ? "" : matchNote(f.q, matched)}`,
		where,
	]
		.filter(Boolean)
		.join(" ");
	// The demo's raw view says so at the end, so switching views changes the text and is announced.
	const tail = f.raw ? `${rest}, as the bank sends them` : rest;
	return {
		before: paged ? "Showing " : "",
		figures: paged ? `${first}–${first + shown - 1} of ${total}` : `${total}`,
		after: ` ${tail}`,
	};
}

export function resultCount(
	page: Page,
	f: Filters,
	categoryName: string | null,
	today: string,
	accountName: string | null = null,
	matched: SearchMatch = NO_MATCH,
): string {
	const { before, figures, after } = resultCountParts(
		page,
		f,
		categoryName,
		today,
		accountName,
		matched,
	);
	return before + figures + after;
}
