// The result count above the list. It names every active filter, so any filter change changes
// its text and the aria-live region announces it, even when the number stays the same (#56).
import { monthLabel } from "../dates";
import type { Filters, Show } from "./filters";

type Page = { total: number; first: number; shown: number; pages: number };

/** The word before "transactions" for each Show choice; All says nothing. */
const TYPE_WORDS: Record<Show, string> = {
	all: "",
	spending: "spending ",
	income: "income ",
	refunds: "refund ",
	excluded: "excluded ",
};

export function resultCount(
	{ total, first, shown, pages }: Page,
	f: Filters,
	categoryName: string | null,
	today: string,
	accountName: string | null = null,
): string {
	const noun = `${TYPE_WORDS[f.show]}transaction${total === 1 ? "" : "s"}`;
	const lead =
		pages > 1
			? `Showing ${first}–${first + shown - 1} of ${total} ${noun}`
			: `${total} ${noun}`;
	const month =
		f.month === "all" ? "across all months" : monthLabel(f.month, today);
	// The category and the account come first, then the month: "in Groceries, Chase Card ••9921, October".
	const named = [categoryName, accountName].filter(Boolean);
	const where =
		named.length > 0
			? `in ${[...named, month].join(", ")}`
			: f.month === "all"
				? month
				: `in ${month}`;
	return [
		lead,
		f.uncategorized && "needing a category",
		f.q && `matching "${f.q}"`,
		where,
	]
		.filter(Boolean)
		.join(" ");
}
