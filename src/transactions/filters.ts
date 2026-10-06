// The list's filters live in the URL, so every filtered view is a link that can be shared and reloaded.

/** The Show choice's options, in the order it lists them (spec §8.4). */
export const SHOWS = [
	"all",
	"spending",
	"income",
	"refunds",
	"excluded",
] as const;

/** Which kind of transaction to list: what each holds is `SHOW_SQL` in `src/db/transactions.ts`. */
export type Show = (typeof SHOWS)[number];

export const SHOW_LABELS: Record<Show, string> = {
	all: "All",
	spending: "Spending",
	income: "Income",
	refunds: "Refunds",
	excluded: "Excluded",
};

const isShow = (value: string | null): value is Show =>
	SHOWS.includes(value as Show);

export type Filters = {
	q: string;
	/** 'YYYY-MM', or 'all' for every month. */
	month: string;
	category: number | null;
	/** An account's id, or null for every account. */
	account: number | null;
	show: Show;
	uncategorized: boolean;
	/** 1-based page of results. Changing any filter starts again at page 1. */
	page: number;
	/** The demo's "Straight from the bank" view (`?raw=1`, spec §8.6): the list as the bank sends it. Never set outside the demo. */
	raw: boolean;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `allowRaw` is true only in the demo: the family app ignores `?raw=1`. */
export function parseFilters(
	params: URLSearchParams,
	thisMonth: string,
	allowRaw = false,
): Filters {
	const month = params.get("month") ?? "";
	const category = Number(params.get("category"));
	const account = Number(params.get("account"));
	const show = params.get("show");
	const page = Number(params.get("page"));
	return {
		q: (params.get("q") ?? "").trim().slice(0, 100),
		month: month === "all" || MONTH.test(month) ? month : thisMonth,
		category: Number.isInteger(category) && category > 0 ? category : null,
		account: Number.isInteger(account) && account > 0 ? account : null,
		// A link made when Excluded was a chip (`excluded=1`) still shows the excluded ones.
		show: isShow(show)
			? show
			: params.get("excluded") === "1"
				? "excluded"
				: "all",
		uncategorized: params.get("uncategorized") === "1",
		page: Number.isInteger(page) && page > 1 ? page : 1,
		raw: allowRaw && params.get("raw") === "1",
	};
}

/** The query string for these filters, leaving out defaults (used for links and the edit panel's "back"). */
export function filtersToQuery(f: Filters, thisMonth: string): string {
	const p = new URLSearchParams();
	if (f.q) p.set("q", f.q);
	if (f.month !== thisMonth) p.set("month", f.month);
	if (f.category !== null) p.set("category", String(f.category));
	if (f.account !== null) p.set("account", String(f.account));
	if (f.uncategorized) p.set("uncategorized", "1");
	if (f.show !== "all") p.set("show", f.show);
	if (f.page > 1) p.set("page", String(f.page));
	if (f.raw) p.set("raw", "1");
	return p.toString();
}

/** A LIKE pattern matching `q` anywhere, with LIKE's wildcards escaped (use with ESCAPE '\'). */
export function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
