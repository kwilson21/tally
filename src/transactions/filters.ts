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
	/** The demo's "Straight from the bank" view (`?raw=1`, spec §8.6): the list as the bank sends it. Never set outside the demo. */
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

/**
 * The month a list shows (#211). A search typed into an empty box while the month is this month looks in
 * every month; emptying the box goes back to this month; any other request shows the month it names, so a
 * month picked during a search stays while typing. `before` is the search the page showed before this
 * request, or null when the request came with no page to come from (a reload, a link, or no JavaScript),
 * and then the month is the one the address names.
 */
export function monthFor(
	f: Filters,
	before: string | null,
	thisMonth: string,
): string {
	if (before === "" && f.q !== "" && f.month === thisMonth) return "all";
	if (before !== null && before !== "" && f.q === "") return thisMonth;
	return f.month;
}

/**
 * The search the transactions page showed before a request, read from the page's address (htmx sends it as
 * HX-Current-URL). Null when there is no such address or it is another page's.
 */
export function searchBefore(address: string | undefined): string | null {
	if (!address) return null;
	try {
		const url = new URL(address);
		return url.pathname === "/transactions"
			? searchText(url.searchParams.get("q"))
			: null;
	} catch {
		return null;
	}
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
