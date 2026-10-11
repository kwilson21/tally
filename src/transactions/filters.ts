// The list's filters live in the URL, so every filtered view is a link that can be shared and reloaded.
import { toCents } from "../money";

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
	/** The demo's "Without Tally" view (`?raw=1`, spec §8.6): the list as the bank sends it. Never set outside the demo. */
	raw: boolean;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The search text as the list reads it: trimmed, and at most 100 characters. */
export const searchText = (value: string | null | undefined) =>
	(value ?? "").trim().slice(0, 100);

/**
 * What the search box's text means as an amount, in cents (decision 79, #211). A number with a decimal
 * point is exactly that many cents ("42.17", "42.1" is $42.10). A whole number, with or without "$" or a
 * comma, is every amount in that dollar ("42", "$42" and "$1,284" are $42.00 to $42.99 and so on).
 * `plain` is a bare whole number, which also searches names and notes for its digits (#211).
 * Anything else is not an amount, a minus sign included. The list matches the absolute amount, so money
 * in and money out both match.
 */
export type AmountSearch = {
	low: number;
	high: number;
	exact: boolean;
	plain: boolean;
};

/** What a search's rows matched by, over every month the count covers (#211). */
export type SearchMatch = {
	/** Some row matched by its category's name. */
	category: boolean;
	/**
	 * The search has an amount and every row matched by it. A plain number also finds names and notes, so
	 * a row may match by words alone, and then this is false.
	 */
	allByAmount: boolean;
};

export function searchAmount(q: string): AmountSearch | null {
	const text = q.trim();
	if (text.startsWith("-")) return null;
	let cents: number;
	try {
		cents = toCents(text);
	} catch {
		return null;
	}
	if (!Number.isSafeInteger(cents)) return null;
	const exact = text.includes(".");
	return exact
		? { low: cents, high: cents, exact, plain: false }
		: {
				low: cents,
				high: cents + 99,
				exact,
				plain: /^\d+$/.test(text),
			};
}

/** The transactions page a list request came from, as its address showed it (htmx sends HX-Current-URL) (#211). */
export type PageBefore = {
	/** The search the page showed. */
	search: string;
	/** Whether the page's address named a month: a month picked, or "Only October", is in it; the default is not. */
	namedMonth: boolean;
};

/** The page before a request, or null when there is no such address or it is another page's. */
export function pageBefore(address: string | undefined): PageBefore | null {
	if (!address) return null;
	try {
		const url = new URL(address);
		return url.pathname === "/transactions"
			? {
					search: searchText(url.searchParams.get("q")),
					namedMonth: url.searchParams.has("month"),
				}
			: null;
	} catch {
		return null;
	}
}

/** The request emptied the search box: it had text on the page before and has none now. */
const emptied = (f: Filters, before: PageBefore) =>
	f.q === "" && before.search !== "";

/**
 * The month a list shows (#211). A search typed into an empty box on this month looks in every month, and
 * emptying the box goes back to this month. A month the page's address named stays while typing, so a month
 * picked during a search stays, and so does one picked from an empty box, even this month. `before` is the
 * page the request came from, or null when there was none (a reload, a link, or no JavaScript), and then the
 * month is the one the request sends.
 */
export function monthFor(
	f: Filters,
	before: PageBefore | null,
	thisMonth: string,
): string {
	if (before === null) return f.month;
	if (emptied(f, before)) return thisMonth;
	if (before.namedMonth) return f.month;
	if (before.search === "" && f.q !== "" && f.month === thisMonth) return "all";
	return f.month;
}

/**
 * The `month` an address shows for a list request (#211): a month other than this one always, and this one
 * only while the page's address named a month and the box was not emptied, so a picked month stays in the
 * address. Null leaves the parameter out. htmx pushes the form's own month into the address, so the server
 * writes the address this way.
 */
export function monthParam(
	f: Filters,
	before: PageBefore | null,
	month: string,
	thisMonth: string,
): string | null {
	if (month !== thisMonth) return month;
	return before?.namedMonth && !emptied(f, before) ? month : null;
}

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
		q: searchText(params.get("q")),
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
