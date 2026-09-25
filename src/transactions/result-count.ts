// The result count above the list. It names every active filter, so any filter change changes
// its text and the aria-live region announces it, even when the number stays the same (#56).
import { monthLabel } from "../dates";
import type { Filters } from "./filters";

type Page = { total: number; first: number; shown: number; pages: number };

export function resultCount(
	{ total, first, shown, pages }: Page,
	f: Filters,
	categoryName: string | null,
	today: string,
): string {
	const noun = `${f.excluded ? "excluded " : ""}transaction${total === 1 ? "" : "s"}`;
	const lead =
		pages > 1
			? `Showing ${first}–${first + shown - 1} of ${total} ${noun}`
			: `${total} ${noun}`;
	const month =
		f.month === "all" ? "across all months" : monthLabel(f.month, today);
	const where =
		categoryName !== null
			? `in ${categoryName}, ${month}`
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
