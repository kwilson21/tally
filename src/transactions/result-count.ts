// The result count above the list. It names every active filter, so any filter change changes
// its text and the aria-live region announces it, even when the number stays the same (#56).
import { monthLabel } from "../dates";
import { formatCents } from "../money";
import { type Filters, type Show, searchAmount } from "./filters";

type Page = { total: number; first: number; shown: number; pages: number };

/** The word before "transactions" for each Show choice; All says nothing. */
const TYPE_WORDS: Record<Show, string> = {
	all: "",
	spending: "spending ",
	income: "income ",
	refunds: "refund ",
	excluded: "excluded ",
};

/**
 * What a search matched, in brackets after its text (#211): the amount a number names, to the cent or
 * across the dollar, or "(category)" when the text is a category's name. An amount is named first.
 */
function matchNote(q: string, categoryMatch: boolean): string {
	const amount = searchAmount(q);
	if (amount) {
		return amount.exact
			? ` (amount ${formatCents(amount.low)})`
			: ` (amounts ${formatCents(amount.low)} to ${formatCents(amount.high)})`;
	}
	return categoryMatch ? " (category)" : "";
}

export function resultCount(
	{ total, first, shown, pages }: Page,
	f: Filters,
	categoryName: string | null,
	today: string,
	accountName: string | null = null,
	categoryMatch = false,
): string {
	const noun = `${TYPE_WORDS[f.show]}transaction${total === 1 ? "" : "s"}`;
	const lead =
		pages > 1
			? `Showing ${first}–${first + shown - 1} of ${total} ${noun}`
			: `${total} ${noun}`;
	const month = f.month === "all" ? "all months" : monthLabel(f.month, today);
	// The category and the account come first, then the month: "in Groceries, Chase Card ••9921, October".
	const named = [categoryName, accountName].filter(Boolean);
	const where = `in ${[...named, month].join(", ")}`;
	const text = [
		lead,
		f.uncategorized && "needing a category",
		f.q && `matching "${f.q}"${f.raw ? "" : matchNote(f.q, categoryMatch)}`,
		where,
	]
		.filter(Boolean)
		.join(" ");
	// The demo's raw view says so at the end, so switching views changes the text and is announced.
	return f.raw ? `${text}, as the bank sends them` : text;
}
