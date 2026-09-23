// The list's filters live in the URL, so every filtered view is a link that can be shared and reloaded.

export type Filters = {
	q: string;
	/** 'YYYY-MM', or 'all' for every month. */
	month: string;
	category: number | null;
	uncategorized: boolean;
	excluded: boolean;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function parseFilters(
	params: URLSearchParams,
	thisMonth: string,
): Filters {
	const month = params.get("month") ?? "";
	const category = Number(params.get("category"));
	return {
		q: (params.get("q") ?? "").trim().slice(0, 100),
		month: month === "all" || MONTH.test(month) ? month : thisMonth,
		category: Number.isInteger(category) && category > 0 ? category : null,
		uncategorized: params.get("uncategorized") === "1",
		excluded: params.get("excluded") === "1",
	};
}

/** The query string for these filters, leaving out defaults (used for links and the edit panel's "back"). */
export function filtersToQuery(f: Filters, thisMonth: string): string {
	const p = new URLSearchParams();
	if (f.q) p.set("q", f.q);
	if (f.month !== thisMonth) p.set("month", f.month);
	if (f.category !== null) p.set("category", String(f.category));
	if (f.uncategorized) p.set("uncategorized", "1");
	if (f.excluded) p.set("excluded", "1");
	return p.toString();
}

/** A LIKE pattern matching `q` anywhere, with LIKE's wildcards escaped (use with ESCAPE '\'). */
export function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
