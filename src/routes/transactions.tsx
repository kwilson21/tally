import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { JEV_THRESHOLD } from "../ai/categorize";
import {
	type UnpaidBill,
	unpaidBillsNote,
	unpaidBillsSentence,
} from "../bills/unpaid";
import { askAgain } from "../categorize-pending";
import { dayLabel, householdToday, monthLabel, shortDay } from "../dates";
import { accountChoices } from "../db/accounts";
import { categoryNames, makeCategory, unmakeCategory } from "../db/categories";
import {
	addLikely,
	type LikelyRow,
	likelyStill,
	likelyTransactions,
} from "../db/likely-transactions";
import { refundedByOthersSql } from "../db/refunded";
import {
	correctCashSplit,
	type FirstVisit,
	firstVisitState,
	getTransaction,
	type ListRow,
	listRowsByIds,
	listTransactions,
	monthsWithTransactions,
	needsCategoryCount,
	PAGE_SIZE,
	payingBillsCount,
	type RefundPurchase,
	refundPurchases,
	removeSplit,
	saveEdit,
	saveSplit,
	selectableMatchIds,
	selectableTickIds,
	setMerchantRule,
	type TransactionDetail,
} from "../db/transactions";
import { centsToAmount, formatCents } from "../money";
import { nameForm, parseCategory } from "../settings/category-form";
import { BANK_VIEW_NOTE, bankRow } from "../transactions/bank-view";
import {
	type CashValues,
	entryKeyOf,
	parseCash,
	parseCashDateAmount,
	saveCash,
} from "../transactions/cash";
import {
	cashDeleteUndoExpiresInMs,
	holdCashDelete,
	restoreCashDelete,
} from "../transactions/cash-undo";
import {
	type Edit,
	type EditErrors,
	FOR_PERSON_ERROR,
	followsPurchaseAfterSave,
	parseEdit,
	postedCredit,
	safeBack,
} from "../transactions/edit";
import {
	type Filters,
	filtersToQuery,
	monthFor,
	monthParam,
	pageBefore,
	parseFilters,
	SHOW_LABELS,
	SHOWS,
} from "../transactions/filters";
import { refundTooBigMessage } from "../transactions/refund-guards";
import { resultCount } from "../transactions/result-count";
import {
	categoryRuleOffer,
	firstRuleOfferAmong,
	ruleOfferForTransaction,
} from "../transactions/rule-offer";
import {
	NO_SELECTION,
	type Selection,
	selectedIds,
	setIds,
	settle,
	ticksFrom,
	unticksFrom,
} from "../transactions/selection";
import { parseSplit } from "../transactions/split";
import { tidyName } from "../transactions/tidy-name";
import { Band } from "../views/band";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { CashForm } from "../views/cash-form";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { DetailRow } from "../views/detail-row";
import { EmptyState } from "../views/empty-state";
import { FilterSelect } from "../views/filter-select";
import { FormField } from "../views/form-field";
import type { HouseholdPerson } from "../views/household-people";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { Layout } from "../views/layout";
import { LikelyAdd, LikelySheet } from "../views/likely-transactions";
import {
	maybeIncomeVisible,
	SuggestedCategoryChip,
} from "../views/maybe-category";
import { MoneyInput } from "../views/money-input";
import {
	KEEP_VALUE,
	NameChoices,
	pickValue,
	SUGGESTED_NAME_CLASS,
} from "../views/name-choices";
import { ABOVE_TABS } from "../views/nav";
import {
	NEW_CATEGORY_GROUP,
	NewCategoryChip,
	NewCategoryName,
} from "../views/new-category-choice";
import { PendingNote } from "../views/pending-note";
import {
	RuleOffer,
	type RuleOfferValue,
	ruleOfferAnnouncement,
} from "../views/rule-offer";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import {
	FOCUS_FIRST_TICK,
	FOCUS_SET_CATEGORY,
	LIST_LOAD_PAUSE,
	MAX_SELECTED,
	NOT_ON_PAGE_FIELD,
	NOT_ON_PAGE_IDS_FIELD,
	NotOnPage,
	NotOnPageCount,
	SELECTION_BAR_OOB,
	SelectAllOnPage,
	SelectedCount,
	SelectionActionBar,
	SelectionActionButtons,
	SelectionFields,
	SelectionLimit,
	selectAllOffer,
	selectionQuery,
	selectModeHref,
	TICKS_INCLUDE,
	TOO_MANY,
} from "../views/selection-action-bar";
import { SplitForm, SplitLine, type SplitValue } from "../views/split-form";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { ViewLinks } from "../views/view-links";
import { WhyLink } from "../views/why-link";

type App = { Bindings: Env };
export const transactions = new Hono<App>();

type Category = { id: number; name: string; icon: string; color: string };

/** The demo, where "Without Tally" (`?raw=1`) lives; the family app has no such view (spec §8.6). */
const isDemo = (c: Context<App>) => c.env.DEMO === "true";

/** Consecutive rows that share a date, in list order. */
function byDay(rows: ListRow[]): [string, ListRow[]][] {
	const groups: [string, ListRow[]][] = [];
	for (const row of rows) {
		const last = groups.at(-1);
		if (last && last[0] === row.date) last[1].push(row);
		else groups.push([row.date, [row]]);
	}
	return groups;
}

type ListOptions = {
	/** The edit sheet to show over the list, given the active categories and the household's date. */
	sheet?: (categories: Category[], today: string) => unknown;
	/** After a save: focus this row, or the result count if it left the list. */
	focusId?: number;
	/** After Undo restores a cash entry: focus its row when this list shows it. Nothing else is focused here; toast.js moves focus when the Undo toast ends (#397). */
	restoredId?: number;
	/** "Only October" asked for focus on the result count, since its link goes (#211). */
	countFocus?: boolean;
	status?: 200 | 404 | 422;
	pageTitle?: string;
	selecting?: boolean;
	/**
	 * In select mode: the selection to show (back from the Set category sheet, or kept across a list change), as
	 * the request carries it. It is settled against the filters the list shows (#321).
	 */
	selection?: Selection;
	/** In select mode on an htmx request: the address the reply pushes, which carries the selection (#350). */
	selectPushBase?: string;
	selectionError?: string;
	focusHeading?: boolean;
	/** The reply to Select all: focus Set category (the link leaves with the reply), when rows are ticked. */
	focusSetCategory?: boolean;
	/** The reply to Older or Newer in select mode: focus the first row's tick (FOCUS_FIRST_TICK). */
	focusFirstTick?: boolean;
};

/** The list URL for these filters (the edit sheet's "back"). */
function listHref(filters: Filters, thisMonth: string) {
	const query = filtersToQuery(filters, thisMonth);
	return `/transactions${query ? `?${query}` : ""}`;
}
/** The list URL for these filters with the month always named, even this month: the month on screen (#321). */
function pinnedListHref(filters: Filters, thisMonth: string) {
	const query = new URLSearchParams(filtersToQuery(filters, thisMonth));
	query.set("month", filters.month);
	return `/transactions?${query}`;
}
/**
 * Whether the household has nothing at all yet, and what it is waiting for (spec §8.5). The demo
 * always has its seeded household and no Plaid, so it never shows the first visit's lists.
 */
async function firstVisitFor(c: Context<App>): Promise<FirstVisit | null> {
	return isDemo(c) ? null : firstVisitState(c.env.DB);
}

/**
 * The first visit's list (P40 A, decision 72): before a bank is linked, the add sign and a link to
 * Accounts (Plaid Link loads only there); once one is, the magnifier, because Tally is looking.
 */
function FirstVisitList({ state }: { state: FirstVisit }) {
	return state === "no-bank" ? (
		<EmptyState
			kind="add"
			sentence="Link a bank to see transactions."
			hint="Tally can only read them; it can't move money."
			action={{ href: "/accounts", label: "Link a bank" }}
		/>
	) : (
		<EmptyState
			kind="search"
			sentence="Importing your transactions…"
			hint="Your bank sends about 90 days of them. It usually takes a few minutes."
		/>
	);
}

/**
 * The first visit's page has no search, filters or Select, and those sit outside #page. So a change
 * that ends it (the first cash entry) or brings it back (deleting the last transaction) swaps all of
 * <main>, not only #page.
 */
function swapWholePage(c: Context<App>) {
	c.header("HX-Retarget", "#main");
	c.header("HX-Reswap", "innerHTML");
	c.header("HX-Reselect", "#main > *");
}

/**
 * The whole Transactions page for these filters. Every htmx swap selects a part of this same page.
 * `today` is the household's date, read once by the handler, so the whole request uses one month.
 */
async function renderList(
	c: Context<App>,
	today: string,
	filters: Filters,
	{
		sheet,
		focusId,
		restoredId,
		countFocus = false,
		status = 200,
		pageTitle,
		selecting: selectRequested = false,
		selection = NO_SELECTION,
		selectPushBase,
		selectionError,
		focusHeading = false,
		focusSetCategory = false,
		focusFirstTick = false,
	}: ListOptions = {},
) {
	const [
		{ rows, total, page, pages, matched },
		months,
		needs,
		categories,
		accounts,
	] = await Promise.all([
		listTransactions(c.env.DB, filters),
		monthsWithTransactions(c.env.DB),
		needsCategoryCount(c.env.DB, filters.month, filters.raw),
		c.env.DB.prepare(
			"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		).all<Category>(),
		accountChoices(c.env.DB),
	]);
	const peoplePrompt = filters.raw
		? false
		: await c.env.DB.prepare(
				"SELECT EXISTS(SELECT 1 FROM transactions WHERE for_person_guessed = 1) AS guessed, (SELECT COUNT(*) FROM household_people) AS people",
			)
				.first<{ guessed: number; people: number }>()
				.then((result) => result?.guessed === 1 && result.people === 1);

	// Only an empty list asks whether it is the first visit's (one cheap statement).
	const firstVisit = rows.length === 0 ? await firstVisitFor(c) : null;
	// With nothing at all to select, the page is the first visit's whatever the address says.
	const selecting = selectRequested && firstVisit === null && !filters.raw;

	// Keep the active month in the picker even when it has no transactions.
	if (filters.month !== "all" && !months.includes(filters.month)) {
		months.push(filters.month);
		months.sort().reverse();
	}
	const first = (page - 1) * PAGE_SIZE + 1;
	// Named even when archived (a bookmarked link can still filter by it), so the count always
	// says which category it is and every change is announced (#56). Only an archived or
	// unknown id needs the extra lookup.
	let categoryName: string | null = null;
	if (filters.category !== null) {
		categoryName =
			categories.results.find((cat) => cat.id === filters.category)?.name ??
			(
				await c.env.DB.prepare("SELECT name FROM categories WHERE id = ?")
					.bind(filters.category)
					.first<{ name: string }>()
			)?.name ??
			`category ${filters.category}`;
	}
	// Named like the category, so the count always says which account; one that's gone reads by its id.
	const accountName =
		filters.account === null
			? null
			: (accounts.find((a) => a.id === filters.account)?.label ??
				`account ${filters.account}`);
	// A saved link can name an account that's since been deleted: keep it in the choice, as the month
	// picker keeps its month, so the choice shows the filter the list is using rather than "All accounts".
	if (
		filters.account !== null &&
		!accounts.some((a) => a.id === filters.account)
	)
		accounts.push({
			id: filters.account,
			label: `account ${filters.account}`,
			disconnected: false,
		});
	const count = resultCount(
		{ total, first, shown: rows.length, pages },
		filters,
		categoryName,
		today,
		accountName,
		matched,
	);
	const listQuery = filtersToQuery({ ...filters, page }, today.slice(0, 7));
	// The count takes focus when the row a save was about has left the list, or when "Only October" asked (#211).
	const focusCount =
		firstVisit === null &&
		(countFocus ||
			(focusId !== undefined && !rows.some((r) => r.id === focusId)));
	const allCategorized =
		filters.uncategorized &&
		filters.q === "" &&
		filters.category === null &&
		filters.account === null &&
		filters.show === "all";
	// The address of this list with other filters: select mode is kept.
	const listUrl = (next: Filters) => {
		const params = new URLSearchParams(filtersToQuery(next, today.slice(0, 7)));
		if (selecting) params.set("select", "1");
		return `/transactions${params.size ? `?${params}` : ""}`;
	};
	// The page's selectable rows (a split parent has no checkbox), which Select all ticks.
	const pageIds = rows.filter((row) => !row.isSplit).map((row) => row.id);
	const onPage = new Set(pageIds);
	// The rows the filters match (no split parent): what Select all selects, and what the selection settles against (#321).
	const selectable = selecting
		? await selectableMatchIds(c.env.DB, filters)
		: [];
	const settled = settle(selection, new Set(selectable));
	// A tick stays until it is unticked, Done or acted on, so a tick that isn't on this page is drawn in
	// the bar's "not on this page" line, still ticked (#350). Only rows that still exist are counted.
	const offPage = selecting
		? await listRowsByIds(
				c.env.DB,
				settled.ticks.filter((id) => !onPage.has(id)),
			)
		: [];
	// Every tick the list keeps, on this page or not: the address, the links, the bar and the limit all read these.
	// A tick to a row that is gone, or is now a split, drops out here, whichever caller drew the list (#350).
	const offIds = new Set(offPage.map((row) => row.id));
	const ticks = settled.ticks.filter((id) => onPage.has(id) || offIds.has(id));
	// Held ticks are rows the filters match, so they exist: they are not filtered by the gone-row rule above.
	const current: Selection = {
		ticks,
		held: settled.held,
		all: settled.all,
		unticked: settled.unticked,
	};
	// What the actions act on, and the matched rows the bar doesn't select yet: the whole-set link's count (#321).
	const picked = selecting ? selectedIds(current, selectable) : [];
	const pickedSet = new Set(picked);
	const unselected = selectable.filter((id) => !pickedSet.has(id)).length;
	const tickCount = picked.length;
	const tickedSet = new Set(current.ticks);
	const unticked = new Set(current.unticked);
	// The month the whole-set link names: "September", or "all months" (#321).
	const monthWords = monthWordsFor(filters.month, today);
	// A row's box: all mode checks every row the set holds, except the rows unticked from it.
	const checkedOn = (id: number) =>
		current.all ? !unticked.has(id) : tickedSet.has(id);
	const pageHref = (n: number) => listUrl({ ...filters, page: n });
	// "Only October" narrows a search that runs in every month to this month, and keeps the search (#211).
	const onlyMonthHref = listUrl({
		...filters,
		month: today.slice(0, 7),
		page: 1,
	});
	// Its request asks for focus on the count, since the link goes with its focus; the address it pushes stays clean.
	const onlyMonthRequest = `${onlyMonthHref}${onlyMonthHref.includes("?") ? "&" : "?"}focus=count`;
	// In select mode a list change carries the ticked rows, so the ones still listed stay ticked, and
	// its controls pause while it loads (LIST_LOAD_PAUSE).
	const includeTicked = selecting
		? {
				...TICKS_INCLUDE,
				...LIST_LOAD_PAUSE,
			}
		: {};
	// Without JavaScript a page link's address carries the ticks, so the next page keeps them (#350). The
	// htmx request doesn't use this address: it sends the ticks as they are when clicked, not as drawn.
	const pageLinkHref = (n: number) =>
		selecting ? `${pageHref(n)}${selectionQuery(current)}` : pageHref(n);
	// Page links swap only the list's contents and scroll back to its top; the live count says where you are.
	const pageLink = (n: number, rel: "prev" | "next", label: string) => (
		<a
			href={pageLinkHref(n)}
			rel={rel}
			class="inline-flex min-h-11 items-center px-2 -mx-2"
			// In select mode the reply focuses the first tick. pageHref always has a query there (select=1), so the marker joins with &.
			hx-get={
				selecting ? `${pageHref(n)}&focus=${FOCUS_FIRST_TICK}` : pageHref(n)
			}
			hx-sync="#filters:replace"
			hx-target="#results"
			hx-select="#results > *"
			hx-select-oob={LIST_OOB}
			hx-swap="innerHTML show:top"
			// In Select mode the reply's HX-Push-Url (the ticks, without the focus marker) replaces this.
			hx-push-url={selecting ? pageHref(n) : "true"}
			{...includeTicked}
		>
			{label}
		</a>
	);
	const pageNav = pages > 1 && (
		<nav
			aria-label="Pages"
			class="mt-4 grid grid-cols-[1fr_auto_1fr] items-center border-t border-rule pt-2"
		>
			<span>{page > 1 && pageLink(page - 1, "prev", "Newer")}</span>
			<span class="text-sm text-muted">
				Page {page} of {pages}
			</span>
			<span class="justify-self-end">
				{page < pages && pageLink(page + 1, "next", "Older")}
			</span>
		</nav>
	);
	const back = listHref(filters, today.slice(0, 7));
	// The select bar's back always names the month on screen, even this month, so a Select all list that
	// outlives the month turning over keeps acting on the month it shows (#321).
	const selectionBack = pinnedListHref(filters, today.slice(0, 7));
	const clearFiltersHref = listHref(
		{
			...filters,
			q: "",
			month: today.slice(0, 7),
			category: null,
			account: null,
			show: "all",
			uncategorized: false,
			page: 1,
		},
		today.slice(0, 7),
	);
	// Select and Done keep every filter and the page; Done drops only select mode.
	const doneHref = `/transactions${listQuery ? `?${listQuery}` : ""}`;
	const selectHref = `/transactions?${listQuery ? `${listQuery}&` : ""}select=1`;
	// The demo's raw view draws each row as the bank sends it; which rows are listed, and what a tap does, don't change.
	const shown = (row: ListRow) => (filters.raw ? bankRow(row) : row);
	const suggestedNameNote = rows.some((row) => shown(row).nameSuggested) ? (
		<p class="mb-2 flex flex-wrap items-center gap-x-1 text-sm text-muted">
			Dashed names are suggestions.
			<WhyLink section="names" topic="suggested name" />
		</p>
	) : null;
	// The page's first tick takes focus after Older or Newer (FOCUS_FIRST_TICK), so focus isn't left on a removed link.
	const firstTickId = focusFirstTick ? pageIds[0] : undefined;
	// The ticks not on this page, under their day headings, in the disclosure (ticked).
	const offPageRows = byDay(offPage).map(([date, dayRows]) => (
		<>
			<h2 class="mt-3 text-sm text-muted">{dayLabel(date, today)}</h2>
			<ul class="divide-y divide-rule">
				{dayRows.map((row) => (
					<SelectableTransactionRow row={shown(row)} checked today={today} />
				))}
			</ul>
		</>
	));
	const htmx = c.req.header("HX-Request") === "true";
	// In Select mode the Add cash sheet's close link and Cancel keep the ticks (#350). The link carries them as
	// drawn, for a browser without JavaScript; with it, the request sends them as they are when the link is tapped.
	const cashPath = `/transactions/cash/new?back=${encodeURIComponent(back)}`;
	const cashHref = selecting ? selectModeHref(cashPath, current) : cashPath;
	const cashGet = selecting ? selectModeHref(cashPath, NO_SELECTION) : cashPath;
	// A list reply in Select mode pushes the address with the settled selection in it, so a reload keeps it (#350, #321).
	if (selecting && htmx && selectPushBase !== undefined)
		c.header("HX-Push-Url", selectModeHref(selectPushBase, current));

	return c.html(
		<Layout
			title={
				pageTitle ??
				(sheet ? "Edit transaction · Tally" : "Transactions · Tally")
			}
			active="transactions"
			currentPath={c.req.path + new URL(c.req.url).search}
			demo={isDemo(c)}
		>
			<div class="flex items-center justify-between gap-3 lg:max-w-3xl">
				<h1
					id="transactions-title"
					tabindex={focusHeading ? -1 : undefined}
					autofocus={focusHeading}
					class="min-w-0 max-w-full wrap-anywhere font-serif text-5xl font-semibold tracking-tight outline-none"
				>
					Transactions
				</h1>
				{/* Swapped out-of-band on filter and page changes, so it keeps the current filters. Select
				    waits for the first transaction (P40 A). */}
				{firstVisit === null && !filters.raw && (
					<Button
						id="select-toggle"
						kind="text"
						class="-mr-2"
						href={selecting ? doneHref : selectHref}
					>
						{selecting ? "Done" : "Select"}
					</Button>
				)}
			</div>
			{firstVisit === null && peoplePrompt && (
				<Band
					href="/settings#household"
					detail="Add names Tally can suggest for who a purchase was for."
				>
					Add the people in your household
				</Band>
			)}
			{/* The demo's "See it without AI" (spec §8.6): plain links to the other view of this list, keeping the
			    filters but starting at the first page. Swapped out of band on filter and page changes, so they never
			    name a stale filter. */}
			{isDemo(c) && (
				<ViewLinks
					current={filters.raw ? "bank" : "made"}
					madeHref={listHref(
						{ ...filters, page: 1, raw: false },
						today.slice(0, 7),
					)}
					bankHref={listHref(
						{ ...filters, page: 1, raw: true },
						today.slice(0, 7),
					)}
				/>
			)}
			{selecting && (
				<p class="mt-2 text-sm text-muted">Tap rows to select them.</p>
			)}
			<div class="mt-3">
				{/* Swapped out-of-band on filter and page changes, so its back URL keeps the current filters. */}
				<Button
					id="add-cash"
					kind="secondary"
					href={cashHref}
					class="gap-2"
					hx-get={cashGet}
					// htmx sends the ticks as they are when tapped, and the URL it pushes carries them (#350).
					{...(selecting ? TICKS_INCLUDE : {})}
					hx-target="#sheet"
					hx-select="#sheet"
					hx-swap="outerHTML"
					hx-push-url="true"
				>
					<Icon name="plus" class="size-5" /> Add cash
				</Button>
			</div>
			<HowLink section="transactions" />

			{/* Works as a plain GET form; htmx re-requests the same URL and swaps in only the results.
			    Like the result count and Select, it waits for the first transaction (P40 A). */}
			{firstVisit === null && (
				<form
					id="filters"
					method="get"
					action="/transactions"
					class="mt-4 flex flex-col gap-3 lg:max-w-3xl"
					hx-get="/transactions"
					hx-trigger="input delay:300ms, submit"
					// The newest request replaces any in flight, so results always match the controls.
					hx-sync="replace"
					hx-target="#results"
					hx-select="#results > *"
					hx-select-oob={`#needs-count:innerHTML, ${LIST_OOB}`}
					hx-swap="innerHTML"
					hx-push-url="true"
					{...includeTicked}
				>
					{selecting && <input type="hidden" name="select" value="1" />}
					{/* The demo's raw view stays on while filtering, with or without htmx. */}
					{filters.raw && <input type="hidden" name="raw" value="1" />}
					<FormField id="q" label="Search transactions" hideLabel>
						{(a11y) => (
							<div class="relative">
								<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
									<Icon name="search" class="size-5" />
								</span>
								<input
									id="q"
									name="q"
									type="search"
									value={filters.q}
									placeholder="Search transactions"
									autocomplete="off"
									class="min-h-11 w-full rounded-control border border-rule bg-band py-2 pl-10 pr-3 text-lg"
									{...a11y}
								/>
							</div>
						)}
					</FormField>
					<div class="flex flex-wrap gap-2">
						<FilterSelect
							id="month"
							name="month"
							label="Month"
							options={[
								...months.map((m) => ({
									value: m,
									label: monthLabel(m, today),
								})),
								{ value: "all", label: "All months" },
							]}
							selected={filters.month}
						/>
						<FilterSelect
							id="category"
							name="category"
							label="Category"
							options={[
								{ value: "", label: "All categories" },
								...categories.results.map((cat) => ({
									value: cat.id,
									label: cat.name,
								})),
							]}
							selected={filters.category}
						/>
						<FilterSelect
							id="account"
							name="account"
							label="Account"
							options={[
								{ value: "", label: "All accounts" },
								...accounts.map((a) => ({
									value: a.id,
									label: a.disconnected ? `${a.label} · Disconnected` : a.label,
								})),
							]}
							selected={filters.account}
						/>
						<FilterSelect
							id="show"
							name="show"
							label="Show"
							options={SHOWS.map((s) => ({ value: s, label: SHOW_LABELS[s] }))}
							selected={filters.show}
						/>
					</div>
					<div class="flex flex-wrap gap-2">
						<Chip
							type="checkbox"
							name="uncategorized"
							value="1"
							checked={filters.uncategorized}
						>
							{/* One span, so the chip's flex gap doesn't split the text around the count. */}
							<span>
								Needs category (<span id="needs-count">{needs}</span>)
							</span>
						</Chip>
					</div>
					{/* With JavaScript, filters apply as you type or pick; without it, this button submits the form. The
					    ticks ride along only in the noscript block, which a browser with JavaScript never reads: htmx
					    sends the current ticks itself (TICKS_INCLUDE), so a stale render can't resend them (#350). */}
					<noscript>
						{selecting &&
							ticks.map((id) => <input type="hidden" name="ids" value={id} />)}
						{selecting && <SelectionFields selection={current} />}
						<Button type="submit" class="self-start px-4">
							Apply filters
						</Button>
					</noscript>
				</form>
			)}

			<div id="page" class="lg:max-w-3xl">
				{/* Stays in place while htmx replaces its text, so screen readers announce each new count (spec §8). */}
				{firstVisit === null && (
					<p
						id="result-count"
						aria-live="polite"
						tabindex={focusCount ? -1 : undefined}
						autofocus={focusCount}
						class="mt-4 text-sm text-muted"
					>
						{count}
					</p>
				)}
				{/* Always drawn on a list, so a search that runs in every month can add or remove its link (LIST_OOB). */}
				{firstVisit === null && (
					<div id="only-month">
						{filters.q !== "" && filters.month === "all" && (
							<Button
								kind="text"
								href={onlyMonthHref}
								class="-ml-2"
								hx-get={onlyMonthRequest}
								hx-sync="#filters:replace"
								hx-target="#results"
								hx-select="#results > *"
								// The count is swapped whole, so htmx can focus it: the link goes, and its focus with it.
								hx-select-oob={`#result-count:outerHTML, ${LIST_OOB}`}
								hx-swap="innerHTML show:top"
								hx-push-url={onlyMonthHref}
								{...includeTicked}
							>
								Only {monthLabel(today.slice(0, 7), today)}
							</Button>
						)}
					</div>
				)}
				{/* Under the count, not in it: what the raw view leaves out stays put as filters change. */}
				{filters.raw && <p class="mt-1 text-muted">{BANK_VIEW_NOTE}</p>}
				{/* Always drawn on a list, so a filter change can add or remove the link inside it (LIST_OOB). */}
				{firstVisit === null && (
					<div id="organize-link">
						{filters.uncategorized && (
							<Button kind="text" href="/transactions/organize" class="-ml-2">
								Organize by merchant
							</Button>
						)}
					</div>
				)}
				{selecting ? (
					<form
						id="selection-form"
						aria-label="Select transactions"
						method="post"
						class="selection-list pb-40"
						hx-get="/transactions/select/count"
						hx-trigger="load, change"
						// A list change (filter, page or Select all) replaces any count in flight, so an older count can't overwrite the newer list's bar. A list load pauses the ticks, so no count can start from a page that is leaving.
						hx-sync="#filters:queue last"
						// The count's own indicator: marking the form would pause the ticks during every count.
						hx-indicator="#selected-count"
						hx-target="#selected-count"
						hx-swap="innerHTML"
					>
						<input
							id="selection-back"
							type="hidden"
							name="back"
							value={selectionBack}
						/>
						<section id="results" class="mt-2" aria-label="Results">
							{suggestedNameNote}
							{/* The limit's words are the bar's alone (SelectionLimit), so a refusal over 100 says them once. */}
							{selectionError && selectionError !== TOO_MANY && (
								<p role="alert" class="my-3 text-sm text-over">
									{selectionError}
								</p>
							)}
							{rows.length === 0 ? (
								<EmptyState
									kind="search"
									sentence="No transactions match these filters."
									hint="Try a wider month, or clear the search."
									// The filters' link keeps select mode and every tick, as a filter change does (#350).
									action={{
										href: selectModeHref(clearFiltersHref, current),
										label: "Clear filters",
									}}
								/>
							) : (
								byDay(rows).map(([date, dayRows]) => (
									<>
										<h2 class="mt-3 text-sm text-muted">
											{dayLabel(date, today)}
										</h2>
										<ul class="divide-y divide-rule">
											{dayRows.map((row) =>
												row.isSplit ? (
													<TransactionRow row={shown(row)} />
												) : (
													<SelectableTransactionRow
														row={shown(row)}
														checked={checkedOn(row.id)}
														today={today}
														autofocus={row.id === firstTickId}
													/>
												),
											)}
										</ul>
									</>
								))
							)}
							{pageNav}
						</section>
						{/* On phones it sits on the tab bar. On desktop it pins to the bottom of the content column:
						    left comes from its place in the page, and the width is the column's (the layout's
						    max-w-6xl less its px-8 sides, w-56 sidebar and gap-10 = 20.5rem, up to max-w-3xl). */}
						<div
							id="selection-bar"
							class={`fixed inset-x-0 ${ABOVE_TABS} z-30 border-t border-ink bg-paper px-5 py-3 pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-x-auto lg:bottom-0 lg:w-[min(48rem,calc(min(100%,72rem)-20.5rem))] lg:px-0`}
						>
							<SelectionActionBar
								// Without JavaScript, the ticks in the address are counted in words once there are any (#350).
								label={
									htmx || tickCount > 0
										? undefined
										: "Choose rows, then an action"
								}
								count={tickCount}
								notOnPage={offPage.length}
								rows={offPageRows}
								notOnPageIds={offPage.map((row) => row.id)}
								back={selectionBack}
								pageIds={pageIds}
								selection={current}
								unselected={unselected}
								total={selectable.length}
								words={monthWords}
								// Both actions wait on every tick the list keeps, as the limit does, not only the rows it shows.
								disabled={
									htmx && (tickCount === 0 || ticks.length > MAX_SELECTED)
								}
								focusSetCategory={focusSetCategory && tickCount > 0}
							/>
						</div>
					</form>
				) : (
					<section id="results" class="mt-2" aria-label="Results">
						{suggestedNameNote}
						{rows.length === 0 ? (
							firstVisit !== null ? (
								<FirstVisitList state={firstVisit} />
							) : allCategorized ? (
								<EmptyState
									kind="done"
									sentence="Every transaction has a category."
									hint="New ones appear here as they come in."
								/>
							) : (
								<EmptyState
									kind="search"
									sentence="No transactions match these filters."
									hint="Try a wider month, or clear the search."
									action={{ href: clearFiltersHref, label: "Clear filters" }}
								/>
							)
						) : (
							byDay(rows).map(([date, dayRows]) => (
								<>
									<h2 class="mt-3 text-sm text-muted">
										{dayLabel(date, today)}
									</h2>
									<ul class="divide-y divide-rule">
										{dayRows.map((row) => {
											const href = `/transactions/${row.id}${listQuery ? `?${listQuery}` : ""}`;
											return (
												<TransactionRow
													row={shown(row)}
													href={href}
													autofocus={
														row.id === focusId || row.id === restoredId
													}
													// Opening swaps in only the sheet, so the list keeps its place.
													attrs={{
														"hx-get": href,
														"hx-target": "#sheet",
														"hx-select": "#sheet",
														"hx-swap": "outerHTML",
														"hx-push-url": "true",
													}}
												/>
											);
										})}
									</ul>
								</>
							))
						)}
						{pageNav}
					</section>
				)}
				<div id="sheet">{sheet?.(categories.results, today)}</div>
			</div>
		</Layout>,
		status,
	);
}

// Transactions: search and filter every transaction (spec §8, feature 3).
// Cancelling the edit panel asks for ?focus=<id> so focus returns to that row (the pushed URL stays clean).
transactions.get("/transactions", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const focus = Number(params.get("focus"));
	const selecting = params.get("select") === "1";
	const today = await householdToday(c.env.DB);
	const thisMonth = today.slice(0, 7);
	const asked = parseFilters(params, thisMonth, isDemo(c));
	// A search typed into an empty box looks in every month, and emptying the box goes back to this month (#211).
	const before = pageBefore(c.req.header("HX-Current-URL"));
	const month = monthFor(asked, before, thisMonth);
	// Select all's reply ticks the page's rows too: they come as page-ids, since htmx would replace the
	// ids in its own address with the ticks it includes (SelectAllOnPage).
	const selectAll = params.get("focus") === FOCUS_SET_CATEGORY;
	// Every tick is kept, past 100 too: the bar refuses to act on more than 100, but never trims them (#350).
	// A tick to a row that is gone, or is now a split, drops out here, before the address and the list read it (#350).
	// The whole-set link ticks every match again, so its request clears the unticked rows (#321).
	const read = selectionFields(params);
	const selection = selecting
		? await requestedSelection(c.env.DB, read, {
				pageLink: selectAll && !read.all,
				wholeAgain: selectAll && read.all,
			})
		: NO_SELECTION;
	const filters = { ...asked, month };
	let selectPushBase: string | undefined;
	if (c.req.header("HX-Request") === "true") {
		const named = monthParam(asked, before, month, thisMonth);
		if (selecting) {
			// In Select mode the address is written clean (#350): the filters, and the month it names (set even when that
			// is this month, which filtersToQuery leaves out). renderList adds the settled selection to it (#321).
			const query = new URLSearchParams(filtersToQuery(filters, thisMonth));
			if (named !== null) query.set("month", named);
			selectPushBase = `/transactions${query.size ? `?${query}` : ""}`;
		} else {
			// htmx shows this address, so a reload shows the list it shows: the month it names, and no focus marker.
			// It is written only when the request's own address names a different month (htmx sends the form's month).
			const address = new URL(c.req.url);
			if (named !== address.searchParams.get("month")) {
				address.searchParams.delete("focus");
				if (named === null) address.searchParams.delete("month");
				else address.searchParams.set("month", named);
				c.header("HX-Push-Url", `${address.pathname}${address.search}`);
			}
		}
	}
	return renderList(c, today, filters, {
		focusId: Number.isInteger(focus) && focus > 0 ? focus : undefined,
		countFocus: params.get("focus") === "count",
		selecting,
		focusSetCategory: selecting && selectAll,
		focusFirstTick: selecting && params.get("focus") === FOCUS_FIRST_TICK,
		selection,
		selectPushBase,
	});
});

/** What a list change refreshes outside the results, so nothing shows stale filters or ticks. */
const LIST_OOB = [
	"#result-count:innerHTML",
	"#organize-link:innerHTML",
	"#add-cash:outerHTML",
	"#select-toggle:outerHTML",
	"#selection-back:outerHTML",
	SELECTION_BAR_OOB,
	"#view-links:outerHTML",
	// The Month choice follows the month a search resolves (#211). It is replaced whole: innerHTML left
	// its old selection showing (Chrome kept "All months" after the options changed). htmx puts focus
	// back on the new element by its id, so a keyboard user stays in it.
	"#month:outerHTML",
	"#only-month:innerHTML",
].join(", ");

const NONE_SELECTED = "Select at least one transaction.";

/** Positive whole-number ids, once each; each value may be one id or "1,2,3". */
function parseIds(values: (string | File)[]) {
	const ids = new Set<number>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const part of value.split(",")) {
			const id = /^\d{1,15}$/.test(part.trim()) ? Number(part) : 0;
			if (id > 0) ids.add(id);
		}
	}
	return [...ids];
}

/** The bar's count (swapped into the live region's text) and its buttons, out of band. */
transactions.get("/transactions/select/count", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const read = selectionFields(params);
	const pageIds = read.pageIds ?? [];
	const onPage = new Set(pageIds);
	const back = safeBack(params.get("back"));
	const today = await householdToday(c.env.DB);
	const filters = filtersFrom(c, today, back);
	const matched = await selectableMatchIds(c.env.DB, filters);
	// The count counts the ticks the form posts, as it always has: an action is what drops a gone row (#350).
	const selection = settle(
		{
			ticks: read.ticks,
			held: read.held,
			all: read.all,
			unticked: read.unticked,
		},
		new Set(matched),
	);
	// What the actions act on, and the matched rows the bar doesn't select yet (the whole-set link's count, #321).
	const picked = selectedIds(selection, matched);
	const pickedSet = new Set(picked);
	const unselected = matched.filter((id) => !pickedSet.has(id)).length;
	const notOnPage = selection.ticks.filter((id) => !onPage.has(id)).length;
	// Each tap keeps the selection in the address, replacing its entry rather than adding one, so a reload keeps it (#350).
	c.header(
		"HX-Replace-Url",
		selectModeHref(listAddress(c, today, back), selection),
	);
	// The last tick off the page was unticked in its disclosure, so its line goes with the tick. Focus moves
	// into the bar then: Select all if it is drawn, else the count. Any other count keeps focus where it is.
	const lineGone = params.has(NOT_ON_PAGE_FIELD) && notOnPage === 0;
	const focusSelectAll =
		lineGone &&
		selectAllOffer({
			pageIds,
			ticked: new Set(selection.ticks),
			all: selection.all,
			unselected,
		}) !== null;
	const focusCount = lineGone && !focusSelectAll;
	return c.html(
		<>
			<SelectedCount
				count={picked.length}
				notOnPage={notOnPage}
				focus={focusCount}
			/>
			<SelectionActionButtons
				disabled={picked.length === 0 || selection.ticks.length > MAX_SELECTED}
				oob
			/>
			<SelectAllOnPage
				back={back}
				pageIds={pageIds}
				selection={selection}
				unselected={unselected}
				total={matched.length}
				words={monthWordsFor(filters.month, today)}
				autofocus={focusSelectAll}
				oob
			/>
			<SelectionLimit count={selection.ticks.length} oob />
			{notOnPage > 0 ? (
				<NotOnPageCount count={notOnPage} oob />
			) : (
				// With none left off the page, the whole line goes, not just its words (#350).
				<NotOnPage count={0} oob />
			)}
		</>,
	);
});

/** A request's selection fields, as a form posts them or an address carries them (#321). */
type SelectionReadable = {
	get(name: string): string | File | null;
	getAll(name: string): (string | File)[];
};
function selectionFields(fields: SelectionReadable) {
	const pageIds = fields.getAll("page-ids");
	const ids = parseIds(fields.getAll("ids"));
	const all = fields.get("all") === "1";
	const onPage = pageIds.length > 0 ? parseIds(pageIds) : undefined;
	// The rows the not-on-this-page line lists, ticked or not: an unticked one is a box the request drew (#321).
	const lineIds = parseIds(fields.getAll(NOT_ON_PAGE_IDS_FIELD));
	const drawn = [...(onPage ?? []), ...lineIds];
	return {
		/** The ticked boxes, on this page or not (the form's checkboxes, or the address's ids). */
		ids,
		/** The rows the page drew, when the request names them (page-ids): their boxes say which are unticked. */
		pageIds: onPage,
		all,
		/** The ticks the request means: in all mode the page's own boxes are the set's, not ticks (ticksFrom, #321). */
		ticks: ticksFrom(ids, all, onPage),
		/** The rows unticked from the whole set: the unchecked boxes the page and the line drew, and the hidden fields (#321). */
		unticked: unticksFrom(parseIds(fields.getAll("unticked")), ids, drawn),
		/** The ticks the whole set also holds, as the hidden fields and the address carry them (#350). */
		held: parseIds(fields.getAll("held")),
	};
}

/**
 * The selection a request means, before the filters settle it (#321): its ticks and held ticks, as selectable rows
 * (a tick to a gone or split row drops out, #350), and in all mode the rows unticked from the set. `pageLink` also
 * ticks the page's rows (Select all's page link); `wholeAgain` ticks the whole set again, clearing the unticks.
 */
async function requestedSelection(
	db: D1Database,
	read: ReturnType<typeof selectionFields>,
	{ pageLink, wholeAgain }: { pageLink: boolean; wholeAgain: boolean },
): Promise<Selection> {
	const ids = [...read.ticks, ...(pageLink ? (read.pageIds ?? []) : [])];
	const ticks = await selectableTickIds(db, [...new Set(ids)]);
	const held = await selectableTickIds(db, read.held);
	if (!read.all)
		return {
			ticks: [...new Set([...ticks, ...held])],
			held: [],
			all: false,
			unticked: [],
		};
	return {
		ticks,
		held,
		all: true,
		unticked: wholeAgain ? [] : read.unticked,
	};
}

/** "September", or "all months": the month the whole-set link names (#321). */
function monthWordsFor(month: string, today: string) {
	return month === "all" ? "all months" : monthLabel(month, today);
}

/**
 * What a bar action acts on (#321): the selection the form posts, settled against the filters `back` lists, as
 * the rows the action changes. A tick to a gone or split row drops out first, and a refusal over 100 ticks keeps
 * every one and trims none (#350). The matches are read now, so the action changes what they are at this moment.
 * `set` is the rows the whole set holds (setIds), empty outside "all" mode: an all-mode Exclude changes those one by one.
 */
async function postedSelection(
	c: Context<App>,
	form: FormData,
	back: string,
	today: string,
) {
	const matched = await selectableMatchIds(
		c.env.DB,
		filtersFrom(c, today, back),
	);
	const selection = settle(
		await requestedSelection(c.env.DB, selectionFields(form), {
			pageLink: false,
			wholeAgain: false,
		}),
		new Set(matched),
	);
	const ids = selectedIds(selection, matched);
	if (selection.ticks.length > MAX_SELECTED)
		return { ids: [], set: [], selection, error: TOO_MANY };
	return {
		ids,
		set: setIds(selection, matched),
		selection,
		error: ids.length === 0 ? NONE_SELECTED : undefined,
	};
}

function SelectCategorySheet({
	ids,
	selection,
	back,
	categories,
	error,
	still,
}: {
	/** The rows the sheet's Save changes; the title counts them. */
	ids: number[];
	/** What Save posts back: the ticks, and in all mode the whole set and the rows unticked from it (#321). */
	selection: Selection;
	back: string;
	categories: Category[];
	error?: string;
	/** Its Save was refused, so the open sheet is drawn again where it is. */
	still?: boolean;
}) {
	const cancelHref = selectModeHref(back, selection);
	const alert = error && (
		<p id="select-category-error" role="alert" class="text-sm text-over">
			{error}
		</p>
	);
	return (
		<BottomSheet
			labelledBy="select-category-title"
			closeHref={cancelHref}
			still={still}
		>
			<h2
				id="select-category-title"
				tabindex={-1}
				autofocus
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				{ids.length ? `Set category for ${ids.length}` : "Set category"}
			</h2>
			{ids.length === 0 ? (
				// Nothing to save: say why, and go back to choosing rows.
				<div class="mt-4 flex flex-col gap-4">
					{alert}
					<Button kind="secondary" href={cancelHref} class="w-full">
						Cancel
					</Button>
				</div>
			) : (
				<form
					method="post"
					action="/transactions/select/category/save"
					class="mt-4 flex flex-col gap-4"
					hx-post="/transactions/select/category/save"
					hx-target="#main"
					hx-select="#main > *"
					hx-swap="innerHTML"
				>
					{selection.ticks.map((id) => (
						<input type="hidden" name="ids" value={id} />
					))}
					<SelectionFields selection={selection} />
					<input type="hidden" name="back" value={back} />
					<fieldset
						aria-describedby={error ? "select-category-error" : undefined}
					>
						<legend class="mb-2">Category</legend>
						<div class="flex flex-wrap gap-2">
							{categories.map((cat, index) => (
								<Chip
									type="radio"
									name="category"
									value={String(cat.id)}
									required={index === 0}
									icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
								>
									{cat.name}
								</Chip>
							))}
						</div>
						{alert && <div class="mt-2">{alert}</div>}
					</fieldset>
					<div class="grid grid-cols-2 gap-3">
						<Button kind="secondary" href={cancelHref} class="w-full">
							Cancel
						</Button>
						<Button type="submit" class="w-full">
							Save
						</Button>
					</div>
				</form>
			)}
		</BottomSheet>
	);
}

/** The select-mode list with the Set category sheet over it; a problem shows inside the sheet. */
async function categorySheet(
	c: Context<App>,
	today: string,
	back: string,
	{
		ids,
		selection,
		error,
		still = false,
	}: {
		/** The rows the sheet's Save changes (see postedSelection). */
		ids: number[];
		/** Every tick and the all-mode fields the list keeps (see postedSelection). */
		selection: Selection;
		error?: string;
		/** Its Save was refused: the sheet is already open, so it isn't drawn arriving again. */
		still?: boolean;
	},
) {
	return renderList(c, today, filtersFrom(c, today, back), {
		selecting: true,
		selection,
		status: error ? 422 : 200,
		pageTitle: "Set category · Tally",
		sheet: (categories) => (
			<SelectCategorySheet
				ids={ids}
				selection={selection}
				back={back}
				categories={categories}
				error={error}
				still={still}
			/>
		),
	});
}

transactions.post("/transactions/select/category", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const { ids, selection, error } = await postedSelection(c, form, back, today);
	return categorySheet(c, today, back, { ids, selection, error });
});

async function finishSelection(
	c: Context<App>,
	today: string,
	back: string,
	message: string,
) {
	const address = listAddress(c, today, back);
	if (!c.req.header("HX-Request")) return c.redirect(address, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	// The list is out of select mode, so the address bar is too.
	c.header("HX-Push-Url", address);
	return renderList(c, today, filtersFrom(c, today, address), {
		focusHeading: true,
	});
}

transactions.post("/transactions/select/category/save", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const { ids, selection, error } = await postedSelection(c, form, back, today);
	if (error)
		return categorySheet(c, today, back, {
			ids,
			selection,
			error,
			still: true,
		});
	const category = Number(form.get("category"));
	const cat = Number.isInteger(category)
		? await c.env.DB.prepare(
				"SELECT id,name FROM categories WHERE id=? AND archived=0",
			)
				.bind(category)
				.first<{ id: number; name: string }>()
		: null;
	if (!cat)
		return categorySheet(c, today, back, {
			ids,
			selection,
			error: "Pick a category from the list.",
			still: true,
		});
	// The same write as the edit panel's category change (saveEdit), once for every row the selection holds.
	await c.env.DB.prepare(
		"UPDATE transactions SET category_id=?, category_source='user', category_confidence=NULL, split_removed_from_cents=NULL, split_removed_bills=NULL, updated_by=?, updated_at=datetime('now') WHERE id IN (SELECT value FROM json_each(?))",
	)
		.bind(cat.id, actor(c), JSON.stringify(ids))
		.run();
	const message = `Set ${ids.length} ${ids.length === 1 ? "transaction" : "transactions"} to ${cat.name}.`;
	// The first merchant in the selection to reach three picks of this category is asked (decision 79).
	const found = await firstRuleOfferAmong(c.env.DB, ids, cat.id);
	const tx = found ? await getTransaction(c.env.DB, found.transactionId) : null;
	if (!found || !tx) return finishSelection(c, today, back, message);
	// The rule offer's address leaves this month out, as the list's does (listAddress).
	const address = listAddress(c, today, back);
	const value: RuleOfferValue = {
		merchantKey: found.merchantKey,
		categoryId: found.categoryId,
		count: found.count,
		merchant: tx.displayName || tidyName(tx.rawName),
		category: cat.name,
		back: address,
	};
	const announce = ruleOfferAnnouncement(value, message);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce }),
	);
	c.header("HX-Push-Url", address);
	return renderRuleOffer(c, today, address, value);
});

/** Excludes the rows named by id, each on its own (`?1` the JSON ids, `?2` the actor), and returns the ones it changed. */
const EXCLUDE_ROWS = `UPDATE transactions SET excluded=1, excluded_source='user', updated_by=?2, updated_at=datetime('now')
		WHERE excluded=0 AND id IN (SELECT value FROM json_each(?1)) RETURNING id`;
/** The edit panel's exclude for a tick: a part excludes its whole purchase, its parent and every sibling (`?1`, `?2` as above). */
const EXCLUDE_PURCHASE = `UPDATE transactions SET excluded=1, excluded_source='user', updated_by=?2, updated_at=datetime('now')
		WHERE excluded=0 AND (
			id IN (SELECT value FROM json_each(?1))
			OR parent_id IN (SELECT value FROM json_each(?1))
			OR id IN (SELECT parent_id FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) AND parent_id IS NOT NULL)
			OR parent_id IN (SELECT parent_id FROM transactions WHERE id IN (SELECT value FROM json_each(?1)) AND parent_id IS NOT NULL)
		)`;

transactions.post("/transactions/select/exclude", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const { ids, set, selection, error } = await postedSelection(
		c,
		form,
		back,
		today,
	);
	if (error)
		return renderList(c, today, filtersFrom(c, today, back), {
			selecting: true,
			selection,
			status: 422,
			selectionError: error,
		});
	// With Select all, the set's rows (held ticks included) are excluded one by one, and RETURNING names the ones
	// this changes, so a matched split part is excluded on its own (P81 A). The ticks are rows the filters no longer
	// match, so each takes its whole purchase, as the edit panel does. That statement runs second: run first, it
	// could exclude a matched sibling before RETURNING reads it.
	let excluded: number[];
	if (selection.all) {
		const statements = [
			c.env.DB.prepare(EXCLUDE_ROWS).bind(JSON.stringify(set), actor(c)),
		];
		if (selection.ticks.length > 0)
			statements.push(
				c.env.DB.prepare(EXCLUDE_PURCHASE).bind(
					JSON.stringify(selection.ticks),
					actor(c),
				),
			);
		const [changed] = await c.env.DB.batch<{ id: number }>(statements);
		const setExcluded = changed?.results.map((row) => row.id) ?? [];
		// The toast and the bill note count what this Exclude excluded: a match that was excluded already is not
		// counted again, and ticks count as the bar counts them.
		excluded = [...setExcluded, ...selection.ticks];
	} else {
		await c.env.DB.prepare(EXCLUDE_PURCHASE)
			.bind(JSON.stringify(ids), actor(c))
			.run();
		excluded = ids;
	}
	// A payment linked to a bill counts whatever its exclusion (spec §8.5), so the message says so, as
	// the edit panel's does.
	const paying = await payingBillsCount(c.env.DB, excluded);
	const stillCounts =
		paying === 0
			? ""
			: excluded.length === 1
				? " It still counts while it pays a bill."
				: paying === 1
					? " 1 still counts while it pays a bill."
					: ` ${paying} still count while they pay a bill.`;
	return finishSelection(
		c,
		today,
		back,
		`Excluded ${excluded.length} ${excluded.length === 1 ? "transaction" : "transactions"}.${stillCounts}`,
	);
});

type SheetProps = {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	people: HouseholdPerson[];
	values: Edit;
	errors?: EditErrors;
	cashValues?: { date: string; amount: string };
	/**
	 * A cash amount that broke its parts: the amount it was refused at, which "Change the parts" opens
	 * the split with (spec §8.4). Set only for that refusal.
	 */
	changePartsTotalCents?: number;
	deleteConfirm?: boolean;
	refunds?: RefundPurchase[];
	/** The household's date, for the transaction's "Today" label. */
	today: string;
	/** The name chip that was chosen when the form was posted, shown again after an error. */
	namePick?: string | null;
	/**
	 * What the name field held when the panel was first drawn, which a redraw after an error carries
	 * through from the posted form, unchanged. Without it the panel is first drawn: the merchant's name now.
	 */
	nameWas?: string | null;
	/**
	 * The panel is already open and is drawn again where it is, so it isn't drawn arriving: Keep it,
	 * after the delete question. A field's error and the question itself are known from the props.
	 */
	still?: boolean;
};

function showEditIncomeGuess(tx: TransactionDetail, posted: Edit) {
	return (
		posted.income === tx.income &&
		posted.creditReviewed === tx.creditReviewedByUser &&
		maybeIncomeVisible(tx)
	);
}

/**
 * Closing a sheet swaps the list back in and returns focus to this transaction's row; the pushed URL
 * stays clean.
 */
function listCloseAttrs(back: string, id: number): Record<string, string> {
	return {
		"hx-get": `${back}${back.includes("?") ? "&" : "?"}focus=${id}`,
		"hx-target": "#page",
		"hx-select": "#page",
		"hx-swap": "outerHTML",
		"hx-push-url": back,
	};
}

/** The edit panel for one transaction (spec §8): category, merchant rule, name, note. */
function EditSheet({
	tx,
	back,
	categories,
	people,
	values,
	errors = {},
	cashValues,
	changePartsTotalCents,
	deleteConfirm = false,
	refunds = [],
	today,
	namePick = null,
	nameWas = null,
	still = false,
}: SheetProps) {
	const editHref = `/transactions/${tx.id}${back.includes("?") ? back.slice(back.indexOf("?")) : ""}`;
	const closeAttrs = listCloseAttrs(back, tx.id);
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	// A refund that follows its purchase counts in that purchase's category, so its own can't be picked
	// while it does. Whether it follows is the counting rule on what a save would hold, so the lock and the
	// "Counts in" line say how the row really counts.
	const linkedPurchase = refunds.find(
		(p) => p.id === values.refundOfId && !p.excluded,
	);
	const purchase =
		linkedPurchase && followsPurchaseAfterSave(tx, values)
			? linkedPurchase
			: undefined;
	const purchaseCategory = categories.find(
		(cat) => cat.id === purchase?.categoryId,
	);
	const showIncomeGuess = showEditIncomeGuess(tx, values);
	const ruleCategory = categories.find(
		(cat) => cat.id === tx.merchantRuleCategoryId,
	);
	return (
		<BottomSheet
			labelledBy="edit-title"
			closeHref={back}
			closeAttrs={closeAttrs}
			// A field's error and the delete question draw the open panel again.
			still={still || deleteConfirm || Object.keys(errors).length > 0}
		>
			{tx.rawName !== tx.displayName && (
				<p class="min-w-0 max-w-full wrap-anywhere text-sm text-muted">
					{tx.rawName}
				</p>
			)}
			<h2
				id="edit-title"
				tabindex={-1}
				// Focused only so screen readers start here; it isn't a control, so no ring. While the sheet
				// asks about a delete, the question takes the focus instead (one autofocus, or htmx picks the first).
				autofocus={!deleteConfirm}
				class={`min-w-0 max-w-full wrap-anywhere font-serif text-4xl font-semibold tracking-tight outline-none ${tx.nameSuggested ? SUGGESTED_NAME_CLASS : ""}`}
			>
				{tx.displayName}
				{tx.nameSuggested && <span class="sr-only">, suggested name</span>}
			</h2>
			{tx.accountType === "cash" && tx.parentId === null ? (
				<p class="text-muted">Cash · you entered this</p>
			) : (
				<>
					<p class="font-serif text-4xl font-semibold">
						{formatCents(tx.amountCents, { signed: true })}
					</p>
					<p class="text-muted">
						{dayLabel(tx.date, today)} · {account}
					</p>
				</>
			)}
			{tx.pending && <PendingNote />}
			{tx.accountType !== "cash" && tx.parentId === null && (
				<p class="mt-2 text-sm text-muted">
					From {tx.bankName ?? tx.accountName}. Its date and amount stay as the
					bank sent them. If something's off, you can split it, exclude it, or
					count it in another month.
				</p>
			)}
			{tx.splitRemovedFromCents != null && (
				<p role="status" class="text-sm text-over">
					The bank changed this from{" "}
					{formatCents(tx.splitRemovedFromCents, { signed: true })}, so its
					split was removed.
					{unpaidBillsNote(tx.splitRemovedBills)}
				</p>
			)}
			{tx.countsInMonth && (!tx.excluded || tx.paysBill) && (
				<p class="text-muted">
					Counts in{" "}
					{new Intl.DateTimeFormat("en-US", {
						month: "long",
						timeZone: "UTC",
					}).format(new Date(`${tx.countsInMonth}-01T00:00:00Z`))}
				</p>
			)}
			{/* The saved state, near the top, so an excluded transaction says so before any options. */}
			{tx.excluded && !tx.paysBill && (
				<p class="flex items-center gap-2 text-muted">
					<Icon name="transfer" class="size-5" />
					Excluded from the budget
				</p>
			)}
			{/* A payment linked to a bill counts whatever its exclusion (spec §8.5), so the panel says so. */}
			{tx.excluded && tx.paysBill && (
				<p class="text-muted">It pays a bill, so it counts in the budget.</p>
			)}
			{/* Outside the form, so following it never happens by accident mid-edit. */}
			<p>
				<HowLink section="categorization" />
			</p>
			{tx.parentId === null && !tx.isSplit && !tx.income && (
				<Button
					kind="secondary"
					href={`/transactions/${tx.id}/split?back=${encodeURIComponent(back)}`}
					class="mt-4 w-full"
				>
					Split
				</Button>
			)}
			{tx.isSplit && (
				<form
					method="post"
					action={`/transactions/${tx.id}/split/remove`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/split/remove`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
					hx-select-oob="#needs-count:innerHTML"
				>
					<input type="hidden" name="back" value={back} />
					<Button kind="secondary" type="submit" class="w-full">
						Remove split
					</Button>
				</form>
			)}
			<form
				method="post"
				action={`/transactions/${tx.id}`}
				class="mt-4 flex flex-col gap-3 border-t border-rule pt-4"
				hx-post={`/transactions/${tx.id}`}
				hx-disable="findAll button[type=submit]"
				hx-indicator="#edit-save"
				// The Needs category count sits in the filter form, outside #page, so update it too.
				hx-select-oob="#needs-count:innerHTML"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="back" value={back} />
				<input
					type="hidden"
					name="details_visible"
					value={tx.detailsVisible ? "1" : "0"}
				/>
				<input
					type="hidden"
					name="note_was"
					value={values.noteWas ?? values.note ?? ""}
				/>
				<input
					type="hidden"
					name="kind_was"
					value={values.kindWas ?? values.kind ?? ""}
				/>
				<input
					type="hidden"
					name="for_person_id_was"
					value={values.forPersonIdWas ?? values.forPersonId ?? ""}
				/>
				<input
					type="hidden"
					name="displayed_name_guess"
					value={tx.nameSuggested ? tx.displayName : ""}
				/>
				{cashValues && (
					<>
						<MoneyInput
							id="cash-edit-amount"
							name="amount"
							label="Amount"
							value={cashValues.amount}
							error={errors.amount}
						/>
						{/* Its own request, with its own indicator (not Save's), and the panel's fields go with it. htmx 4
						    sends a button's name and value only with a submit event, so hx-vals carries change_parts. */}
						{changePartsTotalCents !== undefined && (
							<Button
								kind="secondary"
								type="submit"
								name="change_parts"
								value="1"
								class="w-full"
								hx-post={`/transactions/${tx.id}`}
								hx-vals={JSON.stringify({ change_parts: "1" })}
								hx-target="#page"
								hx-select="#page"
								hx-swap="outerHTML"
								hx-select-oob="#needs-count:innerHTML"
							>
								Change the parts
							</Button>
						)}
						<TextInput
							id="cash-edit-date"
							name="date"
							label="Date"
							type="date"
							value={cashValues.date}
							max={today}
							surface="paper"
							error={errors.date}
						/>
					</>
				)}
				<input
					type="hidden"
					name="income_was"
					value={(values.incomeWas ?? values.income) ? "1" : "0"}
				/>
				{/* The merchant rule is offered only for an unlinked row (the chip above), so a linked row posts
				    no rule answer and a save leaves the rule alone, whatever its purchase or counting. */}
				{tx.refundOfId == null && (
					<>
						<input
							type="hidden"
							name="always_was"
							value={values.alwaysWas ? "1" : "0"}
						/>
						<input
							type="hidden"
							name="rule_category_was"
							value={values.merchantRuleWas ?? ""}
						/>
					</>
				)}
				{/* While the delete question is open there's no Save, so Enter in the name field would save the
				    form anyway; a disabled first submit button makes Enter do nothing (HTML implicit submission). */}
				{deleteConfirm && <button type="submit" disabled hidden />}
				{/* What the name field held when this panel was first drawn, so a save can tell a rename from a panel that
				    is only out of date: another tab may have named the merchant since (src/transactions/edit.ts). After
				    an error the panel is drawn again with the posted value, never the merchant's name as it is now. */}
				<input
					type="hidden"
					name="merchant_was"
					value={nameWas ?? tx.merchantName ?? ""}
				/>
				<div class="border-t border-rule">
					<DetailRow
						id="detail-name"
						label="Name"
						value={tx.displayName}
						source={
							tx.nameFromBank ? "bank" : tx.nameSuggested ? "guess" : "person"
						}
						guessed={tx.nameSuggested || tx.nameFromBank}
						open={Boolean(
							errors.merchant ||
								namePick ||
								values.displayName !== tx.merchantName,
						)}
					>
						{tx.nameChoices ? (
							<NameChoices
								id="name"
								names={tx.nameChoices.names}
								source={tx.nameChoices.source}
								tidied={tx.nameChoices.tidied}
								count={tx.nameChoices.count}
								picked={namePick}
								own={values.displayName ?? ""}
								error={errors.merchant}
							/>
						) : (
							<TextInput
								id="merchant"
								label="Name"
								name="merchant"
								value={values.displayName ?? ""}
								placeholder={tx.rawName}
								autocomplete="off"
								surface="paper"
								hint="Renames every transaction from this merchant."
								error={errors.merchant}
							/>
						)}
					</DetailRow>
					<DetailRow
						id="detail-note"
						label="What it was"
						value={values.note}
						source={tx.noteGuessed ? "guess" : "person"}
						guessed={tx.noteGuessed}
						open={Boolean(errors.note)}
					>
						<FormField id="note" label="What it was" error={errors.note}>
							{({ class: errorClass, ...a11y }) => (
								<>
									<input
										type="hidden"
										name="note_was"
										value={values.noteWas ?? values.note ?? ""}
									/>
									<textarea
										id="note"
										name="note"
										rows={2}
										class={`w-full rounded-control border border-rule bg-paper px-3 py-2 text-lg ${errorClass ?? ""}`}
										{...a11y}
									>
										{values.note ?? ""}
									</textarea>
								</>
							)}
						</FormField>
					</DetailRow>
					<DetailRow
						id="detail-kind"
						label="Kind"
						value={
							values.kind
								? (
										{
											subscription: "Subscription",
											one_off: "One-off",
											bill: "Bill",
											transfer: "Transfer",
										} as const
									)[values.kind]
								: null
						}
						source={tx.kindGuessed ? "guess" : "person"}
						guessed={tx.kindGuessed}
						open={Boolean(errors.kind)}
					>
						<fieldset
							class="flex flex-wrap gap-2"
							aria-describedby={errors.kind ? "kind-error" : undefined}
						>
							<legend class="sr-only">Kind</legend>
							<input
								type="hidden"
								name="kind_was"
								value={values.kindWas ?? values.kind ?? ""}
							/>
							{(["subscription", "one_off", "bill", "transfer"] as const).map(
								(kind) => (
									<Chip
										type="radio"
										name="kind"
										value={kind}
										checked={values.kind === kind}
									>
										{kind === "one_off"
											? "One-off"
											: kind[0]?.toUpperCase() + kind.slice(1)}
									</Chip>
								),
							)}
							<Chip
								type="radio"
								name="kind"
								value=""
								checked={values.kind === null}
							>
								Not known
							</Chip>
						</fieldset>
						{errors.kind && (
							<p id="kind-error" role="alert" class="text-sm text-over">
								{errors.kind}
							</p>
						)}
					</DetailRow>
					<DetailRow
						id="detail-for"
						label="For"
						value={
							values.forPersonId == null
								? people.length < 2
									? "Add the people in your household"
									: null
								: (people.find((person) => person.id === values.forPersonId)
										?.name ?? null)
						}
						source={tx.forPersonGuessed ? "guess" : "person"}
						guessed={tx.forPersonGuessed}
						open={Boolean(errors.forPerson)}
					>
						<fieldset
							class="flex flex-wrap gap-2"
							aria-describedby={
								errors.forPerson ? "for-person-error" : undefined
							}
						>
							<legend class="sr-only">For</legend>
							<input
								type="hidden"
								name="for_person_id_was"
								value={values.forPersonIdWas ?? values.forPersonId ?? ""}
							/>
							{people.map((person) => (
								<Chip
									type="radio"
									name="for_person_id"
									value={String(person.id)}
									checked={values.forPersonId === person.id}
								>
									{person.name}
								</Chip>
							))}
							<Chip
								type="radio"
								name="for_person_id"
								value=""
								checked={values.forPersonId === null}
							>
								No one
							</Chip>
						</fieldset>
						{people.length < 2 && (
							<p class="text-sm text-muted">
								Add the people in your household.
							</p>
						)}
						{errors.forPerson && (
							<p id="for-person-error" role="alert" class="text-sm text-over">
								{errors.forPerson}
							</p>
						)}
					</DetailRow>
				</div>
				{!deleteConfirm && (
					<div class="flex flex-col items-start">
						<Button
							name="details_action"
							value="keep"
							type="submit"
							kind="secondary"
						>
							Looks right
							<span class="sr-only">, keep these details</span>
						</Button>
						<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
							Tally uses these when it picks a category.
							<WhyLink section="categorization" topic="Tally's guess" />
						</p>
					</div>
				)}
				<fieldset
					class={`flex flex-col gap-2 ${NEW_CATEGORY_GROUP}`}
					disabled={purchase !== undefined}
					aria-describedby={errors.category ? "category-error" : undefined}
				>
					<legend class="flex items-center gap-1 text-base text-ink">
						Category
						{tx.categorySource === "bill" && (
							<>
								<span aria-hidden="true">·</span>
								<WhyLink section="categorization" topic="this category" />
							</>
						)}
					</legend>
					<div class="flex flex-wrap items-start gap-2">
						{!purchase &&
							tx.categorySource !== "jev" &&
							tx.maybeCategoryName &&
							!tx.maybeCategoryNew &&
							tx.suggestedCategoryId !== null &&
							tx.suggestedCategoryName &&
							tx.categoryConfidence !== null &&
							tx.categoryConfidence < JEV_THRESHOLD && (
								<SuggestedCategoryChip
									name={tx.suggestedCategoryName}
									value={String(tx.suggestedCategoryId)}
									sure={Math.round(tx.categoryConfidence * 100)}
									transactionId={tx.id}
								/>
							)}
						{categories.map((cat) => (
							<Chip
								type="radio"
								name="category"
								value={String(cat.id)}
								checked={
									purchase
										? purchase.categoryId === cat.id
										: values.categoryId === cat.id
								}
								icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
							>
								{cat.name}
							</Chip>
						))}
						<NewCategoryChip
							checked={!purchase && values.newCategory === true}
						/>
					</div>
					{/* Opens under the chips while New category is chosen (CSS, decision 101). */}
					<NewCategoryName
						id="new-category-name"
						value={values.newCategoryName ?? ""}
						hint="Added to your categories and used for this transaction."
						error={errors.newCategory}
					/>
					{purchase && (
						<p class="text-sm text-muted">
							{purchaseCategory
								? `Counts in ${purchaseCategory.name} with the ${shortDay(purchase.date, tx.date)} purchase.`
								: `Counts with the ${shortDay(purchase.date, tx.date)} purchase.`}
						</p>
					)}
					{!purchase &&
						tx.categorySource === "jev" &&
						tx.categoryConfidence !== null && (
							<p class="text-sm text-muted">
								Picked by Tally · {Math.round(tx.categoryConfidence * 100)}%
								sure
							</p>
						)}
					{!purchase &&
						tx.categorySource !== "jev" &&
						tx.maybeCategoryName &&
						!tx.maybeCategoryNew &&
						tx.suggestedCategoryName &&
						tx.categoryConfidence !== null &&
						tx.categoryConfidence < JEV_THRESHOLD && (
							<p class="text-sm text-muted">
								Tally's guess · {Math.round(tx.categoryConfidence * 100)}% sure
							</p>
						)}
					{errors.category && (
						<p id="category-error" role="alert" class="text-sm text-over">
							{errors.category}
						</p>
					)}
				</fieldset>
				{/* An error keeps the section, even when no purchase is offered any more. */}
				{(refunds.length > 0 || tx.refundOfId != null || errors.refund) && (
					<details
						class="group border-t border-rule"
						open={Boolean(errors.refund)}
					>
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
							<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
								<Icon name="chevron-right" class="size-5" />
							</span>
							This refunds…
						</summary>
						<div class="flex flex-col gap-3 pt-1">
							<p class="text-sm text-muted">
								{tx.displayName} purchases in the last 90 days
							</p>
							<fieldset
								class="flex flex-col gap-3"
								aria-describedby={errors.refund ? "refund-error" : undefined}
							>
								<legend class="sr-only">Purchase this refunds</legend>
								<Chip
									type="radio"
									name="refund_of"
									value=""
									checked={values.refundOfId == null}
								>
									Not linked
								</Chip>
								{refunds.map((p) => (
									<Chip
										type="radio"
										name="refund_of"
										value={String(p.id)}
										checked={values.refundOfId === p.id}
									>
										{shortDay(p.date, tx.date)} · {formatCents(p.amountCents)} ·{" "}
										{p.categoryName ?? "No category"}
									</Chip>
								))}
							</fieldset>
							{errors.refund && (
								<p id="refund-error" role="alert" class="text-sm text-over">
									{errors.refund}
								</p>
							)}
						</div>
					</details>
				)}
				{/* The two things people change most after the category, one tap each (owner's pick C). */}
				<div class="flex flex-wrap gap-2">
					{/* A linked refund has no category of its own to make a rule from. */}
					{tx.refundOfId == null && (
						<Chip
							type="checkbox"
							name="always"
							value="1"
							checked={values.alwaysForMerchant}
						>
							Always for this merchant
						</Chip>
					)}
					<Chip
						type="checkbox"
						name="excluded"
						value="1"
						checked={values.excluded}
					>
						Exclude from budget
					</Chip>
				</div>
				{tx.refundOfId == null && (
					<p class="text-sm text-muted">
						Ticking this for a transaction that doesn't match the rule changes
						it for this merchant. To change a rule this transaction already
						matches, remove it in Settings first.
					</p>
				)}
				{ruleCategory && values.alwaysForMerchant && tx.refundOfId != null ? (
					<p class="text-sm text-muted">
						Remove it in Settings, under{" "}
						<a href="/settings#merchant-rules">Tally's rules</a>.
					</p>
				) : ruleCategory && values.alwaysForMerchant ? (
					<p class="text-sm text-muted">
						{tx.displayName} is always {ruleCategory.name}. Untick it and save
						to remove the rule.
					</p>
				) : null}
				<div class="flex flex-col gap-2 border-t border-rule pt-3">
					<p class="text-base text-ink">Income</p>
					<div class="flex flex-wrap gap-2">
						<Chip
							type="checkbox"
							name="income"
							value="1"
							checked={values.income}
							dashed={showIncomeGuess}
							describedBy={
								showIncomeGuess
									? `income-suggestion-confidence-${tx.id}`
									: undefined
							}
						>
							Count as income
						</Chip>
					</div>
					{showIncomeGuess && (
						<p
							id={`income-suggestion-confidence-${tx.id}`}
							class="flex flex-wrap items-center gap-x-2 text-sm text-muted"
						>
							Tally's guess · {Math.round((tx.incomeConfidence ?? 0) * 100)}%
							sure
							<WhyLink section="categorization" topic="income" />
						</p>
					)}
				</div>
				{tx.amountCents < 0 && (
					<div class="flex flex-col gap-2 border-t border-rule pt-3">
						<input type="hidden" name="creditReviewedVisible" value="1" />
						<input
							type="hidden"
							name="creditReviewed_was"
							value={
								(values.creditReviewedWas ?? values.creditReviewed) ? "1" : "0"
							}
						/>
						{!tx.creditReviewed && !values.income && (
							<p class="text-sm text-muted">
								This bank credit is held out of spending until you identify it.
							</p>
						)}
						<Chip
							type="checkbox"
							name="creditReviewed"
							value="1"
							checked={values.creditReviewed}
						>
							Reviewed as a refund or other non-income credit
						</Chip>
					</div>
				)}
				{/* Asking about a delete takes this row's place (below, in the delete form), so the sheet never
				    has two ways to leave it side by side (decision 84). */}
				{!deleteConfirm && (
					<div class="mt-2 grid grid-cols-2 gap-3">
						<Button href={back} kind="secondary" class="w-full" {...closeAttrs}>
							Cancel
						</Button>
						<Button
							id="edit-save"
							type="submit"
							class="w-full"
							busyLabel="Saving…"
						>
							Save
						</Button>
					</div>
				)}
			</form>
			{tx.accountType === "cash" && tx.parentId === null && (
				<form
					method="post"
					action={`/transactions/${tx.id}/delete`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/delete`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="back" value={back} />
					{deleteConfirm ? (
						<>
							<input type="hidden" name="confirm" value="1" />
							<p
								id="delete-question"
								tabindex={-1}
								autofocus
								// Focused so the swap is announced with the question; it isn't a control, so no ring.
								// The bottom scroll margin brings Delete and Keep it into view with it on a phone.
								class="scroll-mb-24 text-lg outline-none"
							>
								{`Delete ${tx.displayName}, ${formatCents(tx.amountCents)}?`}
							</p>
							<div class="mt-3 grid grid-cols-2 gap-3">
								<Button type="submit" class="w-full">
									Delete
								</Button>
								{/* Keep it goes back to this entry's edit sheet, not the list. */}
								<Button
									href={editHref}
									kind="secondary"
									class="w-full"
									hx-get={editHref}
									hx-target="#page"
									hx-select="#page"
									hx-swap="outerHTML"
								>
									Keep it
								</Button>
							</div>
						</>
					) : (
						<Button kind="text" type="submit">
							Delete cash transaction
						</Button>
					)}
				</form>
			)}
		</BottomSheet>
	);
}

const filtersFrom = (c: Context<App>, today: string, url: string) =>
	parseFilters(
		new URL(url, "http://tally").searchParams,
		today.slice(0, 7),
		isDemo(c),
	);

/**
 * The address a select-mode action writes to the browser, from its `back`: the list's own address, which leaves
 * this month out as list addresses do (#211). A month that has turned over stays named, so the list after the
 * action shows the month it acted on (#321).
 */
const listAddress = (c: Context<App>, today: string, back: string) =>
	listHref(filtersFrom(c, today, back), today.slice(0, 7));

const cashValues = (today: string, form?: FormData): CashValues => ({
	date: form?.get("date")?.toString() ?? today,
	// Opens blank, as Add a bill does: a missing amount is refused with its error, not saved as $20.00 (#342).
	amount: form?.get("amount")?.toString() ?? "",
	merchant: form?.get("merchant")?.toString() ?? "",
	category: form?.get("category")?.toString() ?? "",
	note: form?.get("note")?.toString() ?? "",
});

function CashSheet({
	categories,
	values,
	errors,
	back,
	selection,
	today,
}: {
	categories: Category[];
	values: CashValues;
	errors?: import("../transactions/cash").CashErrors;
	back: string;
	/** The selection, when the sheet is open over Select mode (#350, #321): Cancel and the backdrop go back with it. */
	selection?: Selection;
	today: string;
}) {
	// Closing (the backdrop or Cancel) returns to the list the sheet was opened from, with Select mode's selection.
	const closeHref = selection ? selectModeHref(back, selection) : back;
	return (
		// A field's error draws the open sheet again.
		<BottomSheet
			labelledBy="cash-title"
			closeHref={closeHref}
			still={errors !== undefined && Object.keys(errors).length > 0}
		>
			<h2
				id="cash-title"
				tabindex={-1}
				autofocus
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				Add cash spending
			</h2>
			<CashForm
				categories={categories}
				values={values}
				errors={errors}
				today={today}
				back={back}
				cancelHref={closeHref}
				selection={selection}
				// Made each time the form is drawn: posting this form again records one transaction.
				entryKey={crypto.randomUUID()}
			/>
		</BottomSheet>
	);
}

transactions.get("/transactions/cash/new", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const back = safeBack(params.get("back") ?? undefined);
	// In Select mode the selection rides in the address (or, from a tap, in the request), and the sheet's close link
	// and Cancel keep it, so closing the sheet leaves the selection as it was (#350, #321).
	const selecting = params.get("select") === "1";
	const selection = selecting
		? await requestedSelection(c.env.DB, selectionFields(params), {
				pageLink: false,
				wholeAgain: false,
			})
		: undefined;
	const today = await householdToday(c.env.DB);
	return renderList(c, today, filtersFrom(c, today, back), {
		pageTitle: "Add cash · Tally",
		selecting,
		selection,
		sheet: (categories, today) => (
			<CashSheet
				categories={categories}
				values={cashValues(today)}
				back={back}
				selection={selection}
				today={today}
			/>
		),
	});
});

transactions.post("/transactions/cash", async (c) => {
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	// A form drawn in Select mode posts its selection back, so a refused form keeps it (#350, #321).
	const selecting = form.get("select") === "1";
	const selection = selecting
		? await requestedSelection(c.env.DB, selectionFields(form), {
				pageLink: false,
				wholeAgain: false,
			})
		: undefined;
	const today = await householdToday(c.env.DB);
	const values = cashValues(today, form);
	const { results: categories } = await c.env.DB.prepare(
		"SELECT id,name,icon,color FROM categories WHERE archived=0 ORDER BY sort_order,name",
	).all<Category>();
	const parsed = parseCash(
		values,
		today,
		categories.map((x) => x.id),
	);
	if (!parsed.ok)
		return renderList(c, today, filtersFrom(c, today, back), {
			pageTitle: "Add cash · Tally",
			status: 422,
			selecting,
			selection,
			sheet: () => (
				<CashSheet
					categories={categories}
					values={values}
					errors={parsed.errors}
					back={back}
					selection={selection}
					today={today}
				/>
			),
		});
	const wasFirstVisit = (await firstVisitFor(c)) !== null;
	// The same form posted again (a lost reply, a failed render) changes nothing and saves once. The
	// reply names the entry as stored, not as the form now says, so it tells the truth about it.
	const saved = await saveCash(
		c.env.DB,
		parsed.value,
		actor(c),
		entryKeyOf(form.get("entry_key")),
	);
	const offerRecord = await categoryRuleOffer(
		c.env.DB,
		saved.merchant,
		saved.categoryId,
	);
	const categoryName = categories.find(
		(category) => category.id === saved.categoryId,
	)?.name;
	// The question names the merchant as the family named it, as the Select save does: the name the list
	// shows for the saved entry, or its tidied bank text when no name is chosen.
	const savedTx = offerRecord ? await getTransaction(c.env.DB, saved.id) : null;
	const offer: RuleOfferValue | null =
		offerRecord && categoryName
			? {
					...offerRecord,
					merchant: savedTx?.displayName || tidyName(saved.merchant),
					category: categoryName,
					back,
				}
			: null;
	// With JavaScript off the reply is a whole page, so the question is drawn as one; a save with no question redirects.
	if (!c.req.header("HX-Request"))
		return offer
			? renderRuleOffer(c, today, back, offer)
			: c.redirect(back, 303);
	// The save's own words come first in the announcement, with or without the question after them.
	const savedWords = `Added ${formatCents(saved.amountCents)} cash spending at ${saved.merchant}.`;
	if (offer) {
		c.header(
			"HX-Trigger",
			JSON.stringify({
				toast: { message: `Added ${saved.merchant}`, type: "success" },
				announce: ruleOfferAnnouncement(offer, savedWords),
			}),
		);
		c.header("HX-Push-Url", back);
		return renderRuleOffer(c, today, back, offer);
	}
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Added ${saved.merchant}`, type: "success" },
			announce: savedWords,
		}),
	);
	c.header("HX-Push-Url", back);
	// The pressed button leaves with the swap, so focus goes to the title instead.
	if (wasFirstVisit) swapWholePage(c);
	return renderList(c, today, filtersFrom(c, today, back), {
		focusHeading: wasFirstVisit,
	});
});

/**
 * Whether this htmx request is made from the page that already shows this address, so the sheet it
 * opens is open already: Keep it asks for the panel's own address while the panel is showing the
 * delete question. A tap on a row asks from the list, and a link or a reload sends no such header.
 * It only decides whether the panel is drawn arriving, so a made-up header changes nothing else.
 */
function asksFromThisPage(c: Context<App>) {
	const from = c.req.header("HX-Current-URL");
	if (!c.req.header("HX-Request") || !from) return false;
	try {
		return new URL(from).pathname === new URL(c.req.url).pathname;
	} catch {
		return false;
	}
}

// The edit panel over the list. A real URL: reloading or sharing it keeps the list's filters.
transactions.get("/transactions/:id{[0-9]+}", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	const today = await householdToday(c.env.DB);
	const thisMonth = today.slice(0, 7);
	const filters = parseFilters(
		new URL(c.req.url).searchParams,
		thisMonth,
		isDemo(c),
	);
	const back = listHref(filters, thisMonth);
	const values: Edit = {
		categoryId: tx.categoryId,
		alwaysForMerchant:
			tx.merchantRuleCategoryId !== null &&
			tx.merchantRuleCategoryId === tx.categoryId,
		alwaysWas:
			tx.merchantRuleCategoryId !== null &&
			tx.merchantRuleCategoryId === tx.categoryId,
		merchantRuleWas: tx.merchantRuleCategoryId,
		displayName: tx.merchantName,
		note: tx.note,
		excluded: tx.excluded,
		income: tx.income,
		incomeWas: tx.income,
		creditReviewed: tx.creditReviewedByUser,
		creditReviewedWas: tx.creditReviewedByUser,
		refundOfId: tx.refundOfId ?? null,
		kind: tx.kind,
		forPersonId: tx.forPersonId,
	};
	const people = (
		await c.env.DB.prepare(
			"SELECT id, name FROM household_people ORDER BY id",
		).all<HouseholdPerson>()
	).results;
	const refunds = await refundPurchases(c.env.DB, tx);
	return renderList(c, today, filters, {
		sheet: (categories, today) => (
			<EditSheet
				tx={tx}
				back={back}
				categories={categories}
				people={people}
				values={values}
				cashValues={
					tx.accountType === "cash" && tx.parentId === null
						? { date: tx.date, amount: centsToAmount(tx.amountCents) }
						: undefined
				}
				refunds={refunds}
				today={today}
				still={asksFromThisPage(c)}
			/>
		),
	});
});

/**
 * Change the parts (spec §8.4): the sheet's new total, the amount the saved parts were drawn with, and the
 * panel's other unsaved changes (pendingEdit), which the corrected parts are saved with.
 */
type Correction = {
	totalCents: number;
	amountWas: number;
	pendingEdit?: string;
};

function SplitSheet({
	tx,
	back,
	categories,
	values,
	error,
	today,
	still,
	correction,
}: {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	values: SplitValue[];
	error?: string;
	today: string;
	/** Add a part, or an error, draws the open sheet again, so it isn't drawn arriving. */
	still?: boolean;
	correction?: Correction;
}) {
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	return (
		<BottomSheet labelledBy="split-title" closeHref={back} still={still}>
			<p class="text-sm text-muted">{tx.rawName}</p>
			<h2
				id="split-title"
				tabindex={-1}
				autofocus={values.length <= 2}
				class="font-serif text-4xl font-semibold outline-none"
			>
				{tx.displayName}
			</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(correction?.totalCents ?? tx.amountCents, {
					signed: true,
				})}
			</p>
			<p class="text-muted">
				{dayLabel(tx.date, today)} · {account}
			</p>
			<SplitForm
				id={tx.id}
				parentCents={tx.amountCents}
				totalCents={correction?.totalCents}
				amountWas={correction?.amountWas}
				pendingEdit={correction?.pendingEdit}
				categories={categories}
				values={values}
				back={back}
				error={error}
			/>
		</BottomSheet>
	);
}

/** A posted amount in cents: a whole, positive number of cents, or null. */
function wholeCents(raw: string | null): number | null {
	if (raw === null || !/^[1-9]\d*$/.test(raw)) return null;
	const cents = Number(raw);
	return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * The new total of a Change the parts sheet, in cents: only for a split top-level cash entry, and only
 * a whole, positive amount. Null otherwise, so the route answers 404 for it.
 */
function correctionTotal(
	tx: TransactionDetail,
	raw: string | null,
): number | null {
	const cents = wholeCents(raw);
	return cents !== null &&
		tx.accountType === "cash" &&
		tx.parentId === null &&
		tx.isSplit
		? cents
		: null;
}

/**
 * The posted part ids, in row order: undefined for a new part (an empty id), else the saved part's id.
 * Null when one isn't a whole number, which only a tampered sheet posts.
 */
function partIdsOf(raw: string[]): (number | undefined)[] | null {
	const ids: (number | undefined)[] = [];
	for (const value of raw) {
		if (value === "") ids.push(undefined);
		else if (/^[1-9]\d*$/.test(value)) ids.push(Number(value));
		else return null;
	}
	return ids;
}

async function splitContext(c: Context<App>) {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	const categories = await c.env.DB.prepare(
		"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
	).all<Category>();
	return { tx, categories: categories.results };
}

/**
 * Change the parts: each saved part of the entry whose category is archived, by part id. That category
 * is the part's own to keep (src/transactions/split.ts), so it is read from the saved part, never from
 * the form.
 */
async function archivedPartCategories(db: D1Database, parentId: number) {
	const rows = await db
		.prepare(
			"SELECT part.id AS partId, cat.id, cat.name FROM transactions part JOIN categories cat ON cat.id = part.category_id WHERE part.parent_id = ? AND cat.archived = 1",
		)
		.bind(parentId)
		.all<{ partId: number; id: number; name: string }>();
	return new Map(
		rows.results.map((row) => [row.partId, { id: row.id, name: row.name }]),
	);
}

/**
 * Change the parts: the entry's saved parts, each with its id and, when its category is archived, the
 * category it keeps. The sheet's values for a correction.
 */
async function savedPartValues(
	db: D1Database,
	tx: TransactionDetail,
): Promise<SplitValue[]> {
	const saved = await db
		.prepare(
			"SELECT id, category_id AS categoryId, amount_cents AS amountCents FROM transactions WHERE parent_id = ? ORDER BY id",
		)
		.bind(tx.id)
		.all<{ id: number; categoryId: number | null; amountCents: number }>();
	const archived = await archivedPartCategories(db, tx.id);
	return saved.results.map((part) => ({
		category: part.categoryId === null ? "" : String(part.categoryId),
		amount: centsToAmount(part.amountCents),
		partId: part.id,
		kept: archived.get(part.id),
	}));
}

/**
 * The Change the parts sheet at `totalCents`: the saved parts, each with its id, against the new total.
 * GET ?total= and a panel's Change the parts both draw it here, so they always show the same sheet.
 * `pendingEdit` is the panel's other unsaved changes, which the sheet carries to its save.
 */
async function changePartsList(
	c: Context<App>,
	tx: TransactionDetail,
	back: string,
	today: string,
	totalCents: number,
	pendingEdit?: string,
) {
	const values = await savedPartValues(c.env.DB, tx);
	return renderList(c, today, filtersFrom(c, today, back), {
		sheet: (categories, today) => (
			<SplitSheet
				tx={tx}
				back={back}
				categories={categories}
				values={values}
				today={today}
				correction={{ totalCents, amountWas: tx.amountCents, pendingEdit }}
			/>
		),
	});
}

transactions.get("/transactions/:id{[0-9]+}/split", async (c) => {
	const { tx, categories } = await splitContext(c);
	// Income is never split (decision 62's review): no form for it either.
	if (!tx || tx.parentId !== null || tx.income) return c.notFound();
	const url = new URL(c.req.url);
	const back = safeBack(url.searchParams.get("back"));
	const today = await householdToday(c.env.DB);
	// Change the parts: the saved parts filled in, each with its id, against the new total.
	const correcting = url.searchParams.has("total");
	const total = correcting
		? correctionTotal(tx, url.searchParams.get("total"))
		: null;
	if (correcting && total === null) return c.notFound();
	if (total !== null) return changePartsList(c, tx, back, today, total);
	const values: SplitValue[] = [
		{ category: "", amount: "" },
		{ category: "", amount: "" },
	];
	return renderList(c, today, filtersFrom(c, today, back), {
		sheet: (_categories, today) => (
			<SplitSheet
				tx={tx}
				back={back}
				categories={categories}
				values={values}
				today={today}
			/>
		),
	});
});

transactions.post("/transactions/:id{[0-9]+}/split/line", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	const form = await c.req.formData();
	// A Change the parts sheet counts against its new total, when the total posted is one for this entry.
	const total = correctionTotal(tx, form.get("total")?.toString() ?? null);
	return c.html(
		<div id="split-line">
			<SplitLine
				parentCents={total ?? tx.amountCents}
				amounts={form.getAll("part_amount").map(String)}
			/>
		</div>,
	);
});

transactions.post("/transactions/:id{[0-9]+}/split", async (c) => {
	const { tx, categories } = await splitContext(c);
	if (!tx || tx.parentId !== null) return c.notFound();
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	// Change the parts: the posted total, and the amount the saved parts were drawn with, which the save
	// checks. A posted total that doesn't qualify for this entry is not found.
	const correcting = form.has("total");
	const total = correcting
		? correctionTotal(tx, form.get("total")?.toString() ?? null)
		: null;
	const amountWas = correcting
		? wholeCents(form.get("amount_was")?.toString() ?? null)
		: null;
	if (correcting && (total === null || amountWas === null)) return c.notFound();
	const correction =
		total !== null && amountWas !== null
			? {
					totalCents: total,
					amountWas,
					pendingEdit: form.get("pending_edit")?.toString(),
				}
			: undefined;
	const categoryValues = form.getAll("part_category").map(String);
	const amountValues = form.getAll("part_amount").map(String);
	const partIds = partIdsOf(form.getAll("part_id").map(String));
	if (partIds === null) return c.notFound();
	const archived = correction
		? await archivedPartCategories(c.env.DB, tx.id)
		: new Map<number, Category>();
	const values: SplitValue[] = categoryValues.map((category, i) => {
		const partId = partIds[i];
		return {
			category,
			amount: amountValues[i] ?? "",
			partId,
			kept: partId === undefined ? undefined : archived.get(partId),
		};
	});
	// Income is never split. A row that a bank change made income after the sheet opened gets the same
	// sheet back, refused in words, as the other split refusals do.
	if (tx.income)
		return renderList(c, today, filtersFrom(c, today, back), {
			status: 422,
			sheet: (_categories, today) => (
				<SplitSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					error="Income can't be split."
					today={today}
					still
					correction={correction}
				/>
			),
		});
	if (form.get("add") === "1") {
		// Add a part: the open sheet again, with one more part.
		values.push({ category: "", amount: "" });
		return renderList(c, today, filtersFrom(c, today, back), {
			sheet: (_categories, today) => (
				<SplitSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					today={today}
					still
					correction={correction}
				/>
			),
		});
	}
	const parsed = parseSplit(
		categoryValues,
		amountValues,
		total ?? tx.amountCents,
		categories.map((cat) => cat.id),
		values.map((value) => value.kept?.id),
	);
	if (!parsed.ok)
		return renderList(c, today, filtersFrom(c, today, back), {
			status: 422,
			sheet: (_categories, today) => (
				<SplitSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					error={parsed.error}
					today={today}
					still
					correction={correction}
				/>
			),
		});
	if (correction) {
		const result = await correctCashSplit(
			c.env.DB,
			tx.id,
			{
				totalCents: correction.totalCents,
				amountWasCents: correction.amountWas,
				parts: parsed.parts.map((part, i) => ({
					id: values[i]?.partId ?? null,
					categoryId: part.categoryId,
					amountCents: part.amountCents,
				})),
			},
			actor(c),
		);
		// The panel's other changes (its pending edit) are saved with the corrected parts, as its own save.
		if (result.saved)
			return correction.pendingEdit
				? savePendingEdit(c, tx, correction.totalCents, correction.pendingEdit)
				: splitSaved(c, tx, today, back, { unlinked: [], bills: [] });
		const error =
			"refundPart" in result
				? `Linked refunds add up to ${formatCents(result.refundPart.refundCents)}, so part ${result.refundPart.part} can't be less than that.`
				: `Linked refunds add up to ${formatCents(result.refundTotalCents)}, so the amount can't be less than that.`;
		return renderList(c, today, filtersFrom(c, today, back), {
			status: 422,
			sheet: (_categories, today) => (
				<SplitSheet
					tx={tx}
					back={back}
					categories={categories}
					values={values}
					error={error}
					today={today}
					still
					correction={correction}
				/>
			),
		});
	}
	const result = await saveSplit(c.env.DB, tx.id, parsed.parts, actor(c));
	if (result.saved) return splitSaved(c, tx, today, back, result);
	// Show the bank's new amount, so the next save checks against it.
	const fresh = (await getTransaction(c.env.DB, tx.id)) ?? tx;
	return renderList(c, today, filtersFrom(c, today, back), {
		status: 422,
		sheet: (_categories, today) => (
			<SplitSheet
				tx={fresh}
				back={back}
				categories={categories}
				values={values}
				error="The bank just changed this amount. Check the parts and save again."
				today={today}
				still
			/>
		),
	});
});

/** What a split change unlinked: refunds by the date of their purchase, and bill payments by bill (decision 99). */
type SplitChange = { unlinked: string[]; bills: UnpaidBill[] };

/** A saved split: the list again with its toast and announcement, or a redirect for a browser without htmx. */
function splitSaved(
	c: Context<App>,
	tx: TransactionDetail,
	today: string,
	back: string,
	change: SplitChange,
) {
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	const sentence = unlinkedSentence(change, today);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: {
				message: `Split ${tx.displayName}${sentence ? `.${sentence}` : ""}`,
				type: "success",
			},
			announce: `Saved split for ${tx.displayName}.${sentence}`,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, today, filtersFrom(c, today, back), {
		focusId: tx.id,
	});
}

/**
 * What a split change says about what it unlinked, after the toast's name: " The refund on Sep 26 is no longer
 * linked. The Costco membership bill for 2026 is no longer paid.", or "" for none (decisions 60 and 99).
 */
function unlinkedSentence(
	{ unlinked, bills }: SplitChange,
	today: string,
): string {
	const [first] = unlinked;
	const refunds =
		first === undefined
			? ""
			: unlinked.length === 1
				? `The refund on ${shortDay(first, today)} is no longer linked.`
				: `${unlinked.length} refunds are no longer linked.`;
	return [refunds, unpaidBillsSentence(bills)]
		.filter(Boolean)
		.map((sentence) => ` ${sentence}`)
		.join("");
}

transactions.post("/transactions/:id{[0-9]+}/split/remove", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx?.isSplit) return c.notFound();
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const unlinked = unlinkedSentence(
		await removeSplit(c.env.DB, tx.id, actor(c)),
		today,
	);
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: {
				message: `Removed split from ${tx.displayName}${unlinked ? `.${unlinked}` : ""}`,
				type: "success",
			},
			announce: `Removed split from ${tx.displayName}.${unlinked}`,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, today, filtersFrom(c, today, back), { focusId: tx.id });
});

// Saving the edit panel. htmx gets the updated list back with a toast; plain browsers are redirected to it.
transactions.post("/transactions/:id{[0-9]+}", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	return savePanel(c, tx, await c.req.formData());
});

/**
 * The panel's posted fields as a query string, without Change the parts' own button: what a Change the
 * parts sheet carries until its save. Pending values travel in the POST body only, never in a URL.
 */
function pendingEditOf(form: FormData): string {
	const fields = new URLSearchParams();
	form.forEach((value, key) => {
		if (key !== "change_parts" && typeof value === "string")
			fields.append(key, value);
	});
	return fields.toString();
}

/**
 * Saves the edit panel as `form` posted it, for `tx` (spec §8): the check, the save, the toast and the
 * list again. Change the parts (spec §8.4) is a save that the amount breaks the parts of: it answers with
 * the split sheet at that amount, holding the panel's other changes, which are saved with the corrected parts.
 */
async function savePanel(
	c: Context<App>,
	tx: TransactionDetail,
	form: FormData,
) {
	// The panel as it was posted, before anything below changes the form: a Change the parts sheet carries it.
	const pendingEdit = pendingEditOf(form);
	const keptDetails = form.get("details_action") === "keep";
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const filters = filtersFrom(c, today, back);
	const { results: categories } = await c.env.DB.prepare(
		"SELECT id, name FROM categories WHERE archived = 0",
	).all<Category>();
	const people = (
		await c.env.DB.prepare(
			"SELECT id, name FROM household_people ORDER BY id",
		).all<HouseholdPerson>()
	).results;
	// "This refunds…": no field leaves the link as it is; an empty one unlinks. A chosen purchase
	// must be one the panel offers (the current link always is).
	const refunds = await refundPurchases(c.env.DB, tx);
	// Only a top-level cash entry has the Amount and Date fields; a split part's date and amount come from its parent.
	const cashValues =
		tx.accountType === "cash" && tx.parentId === null
			? {
					date: form.get("date")?.toString() ?? tx.date,
					amount:
						form.get("amount")?.toString() ?? centsToAmount(tx.amountCents),
				}
			: undefined;
	const cashParsed = cashValues
		? parseCashDateAmount(cashValues.date, cashValues.amount, today)
		: undefined;
	const current = tx.refundOfId ?? null;
	const posted = form.get("refund_of");
	const refundOfId =
		posted === null ? current : posted === "" ? null : Number(posted);
	const refundOk =
		refundOfId === null || refunds.some((p) => p.id === refundOfId);
	// A refund that follows its purchase counts in that purchase's category, so a posted category (and a
	// merchant rule made from it) is ignored. It follows by the counting rule on what this save will hold.
	const linkedPurchase = refunds.find(
		(p) => p.id === refundOfId && !p.excluded,
	);
	if (
		linkedPurchase &&
		followsPurchaseAfterSave(tx, { refundOfId, ...postedCredit(form) })
	) {
		form.delete("category");
		form.delete("new_category_name");
		form.delete("always");
	}
	// A name chip counts only while it is still offered: the panel may have been opened before "Suggest store
	// names" went off or before the suggestion was settled elsewhere, and a person's save must not accept or
	// turn down a guess they can no longer see. A name typed in the field is always their own.
	const pick = form.get("name_pick")?.toString() ?? "";
	const offered = tx.nameChoices?.names ?? [];
	const stillOffered =
		pick === KEEP_VALUE
			? tx.nameChoices !== null && tx.nameChoices !== undefined
			: offered.some((name) => pickValue(name) === pick);
	if (pick && !stillOffered) form.delete("name_pick");
	if (keptDetails && !form.has("merchant") && !form.has("name_pick")) {
		const displayedGuess = form.get("displayed_name_guess")?.toString() ?? "";
		if (displayedGuess) form.set("name_pick", pickValue(displayedGuess));
	}
	const parsed = parseEdit(
		form,
		categories.map((cat) => cat.id),
		people.map((person) => person.id),
	);

	// The panel again, as the person left it, with what's wrong (422). `changePartsTotalCents` is set only
	// when the amount broke its parts, so the panel offers Change the parts for that amount. `shownPeople`
	// is the household as it is now, used when a For person was removed during the save.
	const showErrors = (
		errors: EditErrors,
		changePartsTotalCents?: number,
		shownPeople: HouseholdPerson[] = people,
	) => {
		const values: Edit = {
			categoryId: Number(form.get("category")) || null,
			newCategory: form.get("category") === "new",
			newCategoryName: form.get("new_category_name")?.toString() ?? "",
			alwaysForMerchant: form.get("always") === "1",
			alwaysWas: form.get("always_was") === "1",
			merchantRuleWas: Number(form.get("rule_category_was")) || null,
			displayName: form.get("merchant")?.toString() ?? null,
			note: form.get("note")?.toString() ?? null,
			noteWas: form.get("note_was")?.toString() ?? null,
			excluded: form.get("excluded") === "1",
			income: form.get("income") === "1",
			incomeWas: form.get("income_was") === "1",
			creditReviewed: form.get("creditReviewed") === "1",
			creditReviewedWas: form.get("creditReviewed_was") === "1",
			creditReviewedProvided:
				form.get("creditReviewedVisible") === "1" || form.has("creditReviewed"),
			refundOfId,
			kind: form.has("kind")
				? (form.get("kind")?.toString() as Edit["kind"])
				: tx.kind,
			kindWas: form.get("kind_was")?.toString() as Edit["kindWas"],
			forPersonId: form.has("for_person_id")
				? Number(form.get("for_person_id")) || null
				: tx.forPersonId,
			forPersonIdWas: Number(form.get("for_person_id_was")) || null,
		};
		return renderList(c, today, filters, {
			status: 422,
			sheet: (all, today) => (
				<EditSheet
					tx={tx}
					back={back}
					categories={all}
					people={shownPeople}
					values={values}
					refunds={refunds}
					errors={errors}
					today={today}
					namePick={form.get("name_pick")?.toString() ?? null}
					nameWas={form.get("merchant_was")?.toString() ?? null}
					cashValues={cashValues}
					changePartsTotalCents={changePartsTotalCents}
				/>
			),
		});
	};
	// The amount broke its parts: the panel again, or, when Change the parts was asked for, the split sheet at
	// that amount, holding the panel's other changes (spec §8.4).
	const partsBroken = (amountCents: number, partsCents: number) =>
		form.get("change_parts") === "1"
			? changePartsList(c, tx, back, today, amountCents, pendingEdit)
			: showErrors(
					{
						amount: `The parts add up to ${formatCents(partsCents)}. Change them to match ${formatCents(amountCents)}.`,
					},
					amountCents,
				);

	// "New category" (decision 101): the name under the chips is checked here, and the category is made only
	// once every other check has passed, so a taken name or a full list saves nothing.
	const choseNew = form.get("category") === "new";
	const named = choseNew
		? parseCategory(
				nameForm(form.get("new_category_name")),
				await categoryNames(c.env.DB),
				null,
			)
		: null;
	const newCategoryError = named && !named.ok ? named.errors.name : undefined;
	if (
		!parsed.ok ||
		!refundOk ||
		newCategoryError ||
		(cashParsed && Object.keys(cashParsed.errors).length)
	)
		return showErrors({
			...(parsed.ok ? {} : parsed.errors),
			...(refundOk ? {} : { refund: "Pick a purchase from the list." }),
			...(newCategoryError ? { newCategory: newCategoryError } : {}),
			...(cashParsed?.errors ?? {}),
		});
	if (cashParsed && tx.isSplit) {
		// Refunds linked to the entry and to its parts together: moving the parts can't make them fit, so this
		// is checked first.
		const linked = await c.env.DB.prepare(
			`SELECT ${refundedByOthersSql("?1", "0")} + COALESCE((SELECT SUM(${refundedByOthersSql("part.id", "0")}) FROM transactions part WHERE part.parent_id = ?1), 0) AS cents`,
		)
			.bind(tx.id)
			.first<{ cents: number }>();
		if (linked && linked.cents > cashParsed.amountCents)
			return showErrors({
				amount: `Linked refunds add up to ${formatCents(linked.cents)}, so the amount can't be less than that.`,
			});
		const parts = await c.env.DB.prepare(
			"SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions WHERE parent_id = ?",
		)
			.bind(tx.id)
			.first<{ cents: number }>();
		if (parts && parts.cents !== cashParsed.amountCents)
			return partsBroken(cashParsed.amountCents, parts.cents);
	}
	let edit: Edit = parsed.value;
	let made: { id: number; name: string } | null = null;
	if (named?.ok) {
		const created = await makeCategory(c.env.DB, named.value);
		if (!created.ok) return showErrors({ newCategory: created.error });
		edit = { ...parsed.value, categoryId: created.id };
		made = { id: created.id, name: named.value.name };
	}

	// The link is written only when it changes. A refund that is more than what's left of its
	// purchase is refused by the write itself, with nothing saved (spec §8.5).
	const result = await saveEdit(
		c.env.DB,
		tx.id,
		{
			...edit,
			refundOfId: refundOfId === current ? undefined : refundOfId,
			...(cashParsed
				? {
						cashDate: cashValues?.date,
						cashAmountCents: cashParsed.amountCents,
					}
				: {}),
		},
		actor(c),
	).catch(async (error: unknown) => {
		// A save that throws files nothing, so a category made for it goes too.
		if (made) await unmakeCategory(c.env.DB, made.id);
		throw error;
	});
	if (!result.saved) {
		// Nothing was filed in a category made for this save, so it goes too: a retry must not find its name taken.
		if (made) await unmakeCategory(c.env.DB, made.id);
		if ("personMissing" in result)
			// Removed since this page loaded the household: the panel shows the household as it is now.
			return showErrors(
				{ forPerson: FOR_PERSON_ERROR },
				undefined,
				(
					await c.env.DB.prepare(
						"SELECT id, name FROM household_people ORDER BY id",
					).all<HouseholdPerson>()
				).results,
			);
		return "refundLeftCents" in result
			? showErrors({ refund: refundTooBigMessage(result.refundLeftCents) })
			: result.cashError === "split"
				? partsBroken(cashParsed?.amountCents ?? 0, result.amountCents)
				: showErrors({
						amount: `Linked refunds add up to ${formatCents(result.refundCents)}, so the amount can't be less than that.`,
					});
	}
	// An unnamed merchant is named by its tidied text, never the raw bank string (#93), or by the
	// suggestion its rows were showing when nothing was chosen (P29 A). The toast and the offer use this name.
	// A panel that didn't rename the merchant names it as stored, not as it was drawn.
	const name =
		(parsed.value.nameChanged === false
			? tx.merchantName
			: parsed.value.displayName) ??
		(tx.nameSuggested && !parsed.value.keepBankName
			? tx.displayName
			: tidyName(tx.rawName));
	const ruleOfferRecord =
		parsed.value.categoryId === null ||
		parsed.value.categoryId === tx.categoryId ||
		parsed.value.alwaysForMerchant
			? null
			: await ruleOfferForTransaction(c.env.DB, tx.id, parsed.value.categoryId);
	const offerCategory = categories.find(
		(cat) => cat.id === parsed.value.categoryId,
	);
	const ruleOffer =
		ruleOfferRecord && offerCategory
			? {
					...ruleOfferRecord,
					merchant: name,
					category: offerCategory.name,
					back,
				}
			: undefined;
	// A clearer name or a note, added to a transaction that still needs a category, makes Tally ask
	// again (spec §7, decision 79). It runs once this answer is out, so the save never waits for it;
	// a transaction that already has a category, or gets one in this save, asks nothing.
	// A name counts only when this form gave one (nameChanged, from the name the panel showed): a panel that
	// is out of date, saved after another tab renamed the merchant, isn't a new name and asks nothing.
	const addedName =
		parsed.value.nameChanged !== false &&
		parsed.value.displayName !== null &&
		parsed.value.displayName !== tx.merchantName;
	const addedNote = parsed.value.note !== null && parsed.value.note !== tx.note;
	const changedDetails =
		(parsed.value.kind !== undefined && parsed.value.kind !== tx.kind) ||
		(parsed.value.forPersonId !== undefined &&
			parsed.value.forPersonId !== tx.forPersonId);
	if (
		(addedName || addedNote || changedDetails) &&
		tx.categoryId === null &&
		edit.categoryId === null
	)
		c.executionCtx.waitUntil(askAgain(c.env, tx.id));
	// A category made here offers the transactions that might belong in it, when there are any (decision 76).
	// Its reason names the entry as this save left it: a cash entry's date and amount may have just changed.
	const likely = made
		? {
				savedId: tx.id,
				savedDate: cashValues?.date ?? tx.date,
				savedCents: cashParsed?.amountCents ?? tx.amountCents,
				back,
				categoryId: made.id,
				categoryName: made.name,
				rows: await likelyTransactions(c.env.DB, tx.id, made.name, today),
			}
		: null;
	const panel = likely && likely.rows.length > 0 ? likely : null;
	// With JavaScript off the question is drawn as a whole page, like the Select save's; no question redirects.
	if (!c.req.header("HX-Request")) {
		if (ruleOffer) return renderRuleOffer(c, today, back, ruleOffer);
		if (panel) return renderLikely(c, today, filters, panel);
		return c.redirect(back, 303);
	}

	// A category made in this save is named too, so the toast says what the transaction is now.
	const category =
		made?.name ?? categories.find((cat) => cat.id === edit.categoryId)?.name;
	const saved = category
		? `Saved. ${name} is now ${category}.`
		: `Saved ${name}.`;
	// Linking a refund includes it, whatever the Exclude chip held.
	const excludedNow =
		refundOfId !== null && refundOfId !== current
			? false
			: parsed.value.excluded;
	const exclusion =
		excludedNow === tx.excluded
			? ""
			: excludedNow
				? tx.paysBill
					? " It still counts while it pays a bill."
					: " It's excluded from the budget."
				: " It counts in the budget again.";
	const saveWords =
		(keptDetails ? `Kept the details for ${name}.` : saved) + exclusion;
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: {
				message: keptDetails ? `Kept details for ${name}` : `Saved ${name}`,
				type: "success",
			},
			announce: ruleOffer
				? ruleOfferAnnouncement(ruleOffer, saveWords)
				: saveWords,
		}),
	);
	c.header("HX-Push-Url", back);
	// A rule offer and a category made here never both apply: an offer needs three picks of a category, and a
	// category made in this save has only this one.
	if (ruleOffer) return renderRuleOffer(c, today, back, ruleOffer);
	if (panel) return renderLikely(c, today, filters, panel);
	return renderList(c, today, filters, { focusId: tx.id });
}

/**
 * Change the parts has saved the entry's new total and its corrected parts: the panel's pending edit is
 * saved now too, as its own save would save it, with the amount the parts now add up to.
 */
async function savePendingEdit(
	c: Context<App>,
	tx: TransactionDetail,
	totalCents: number,
	pendingEdit: string,
) {
	const form = new FormData();
	new URLSearchParams(pendingEdit).forEach((value, key) => {
		form.append(key, value);
	});
	form.set("amount", centsToAmount(totalCents));
	return savePanel(c, (await getTransaction(c.env.DB, tx.id)) ?? tx, form);
}

/** A live category a likely-transactions form names, or null. */
async function liveCategory(db: D1Database, value: string | File | null) {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) return null;
	return db
		.prepare("SELECT id, name FROM categories WHERE id = ? AND archived = 0")
		.bind(id)
		.first<{ id: number; name: string }>();
}

// The likely transactions after a new category (decision 76): Add files the ticked ones, and only them.
transactions.post("/transactions/:id{[0-9]+}/likely", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const filters = filtersFrom(c, today, back);
	const category = await liveCategory(c.env.DB, form.get("category"));
	// A category archived since the panel opened moves nothing, as when every ticked row has changed.
	const moved = category
		? await addLikely(c.env.DB, {
				savedId: tx.id,
				categoryId: category.id,
				categoryName: category.name,
				ticked: form.getAll("ids").map(Number),
				today,
				actor: actor(c),
			})
		: 0;
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	// Nothing moves when every ticked row changed since the panel opened (addLikely files only the ticked rows
	// the panel's rules still allow).
	const message =
		moved === 0 || !category
			? "Nothing moved: those transactions changed since the panel opened."
			: `Set ${moved} ${moved === 1 ? "transaction" : "transactions"} to ${category.name}.`;
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message, type: moved === 0 ? "info" : "success" },
			announce: message,
		}),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, today, filters, { focusId: tx.id });
});

// A tick on the likely panel redraws only its Add count, so the number follows the ticks: the ticked rows Add
// would file now, not the six the panel lists.
transactions.post("/transactions/:id{[0-9]+}/likely/count", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (!tx) return c.notFound();
	const form = await c.req.formData();
	const today = await householdToday(c.env.DB);
	const category = await liveCategory(c.env.DB, form.get("category"));
	if (!category) return c.notFound();
	const count = (
		await likelyStill(c.env.DB, {
			savedId: tx.id,
			categoryName: category.name,
			today,
			ticked: form.getAll("ids").map(Number),
		})
	).length;
	return c.html(<LikelyAdd count={count} categoryName={category.name} />);
});

async function respondToRuleOffer(c: Context<App>, yes: boolean) {
	const form = await c.req.formData();
	const merchantKey = form.get("merchant_key")?.toString() ?? "";
	const categoryId = Number(form.get("category"));
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	const validCategory = await c.env.DB.prepare(
		"SELECT id, name FROM categories WHERE id = ? AND archived = 0",
	)
		.bind(categoryId)
		.first<{ id: number; name: string }>();
	const askedName = form.get("merchant")?.toString() ?? "";
	const merchantName = merchantKey
		? await c.env.DB.prepare(
				"SELECT display_name AS displayName FROM merchants WHERE raw_name = ?",
			)
				.bind(merchantKey)
				.first<{ displayName: string | null }>()
		: null;
	const offer =
		validCategory && merchantKey
			? await categoryRuleOffer(c.env.DB, merchantKey, categoryId)
			: null;
	const message =
		yes && offer && validCategory
			? `Always use ${validCategory.name} for ${askedName || merchantName?.displayName || tidyName(merchantKey)}.`
			: validCategory
				? `Saved as ${validCategory.name}.`
				: "Saved.";
	if (yes && offer && validCategory)
		await setMerchantRule(c.env.DB, merchantKey, categoryId, actor(c));
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	c.header("HX-Push-Url", back);
	return renderList(c, today, filtersFrom(c, today, back), {
		focusHeading: true,
	});
}

/** The likely panel after a category is made (decision 76), drawn over the list. Only the ticked rows move. */
function renderLikely(
	c: Context<App>,
	today: string,
	filters: Filters,
	panel: {
		savedId: number;
		savedDate: string;
		savedCents: number;
		back: string;
		categoryId: number;
		categoryName: string;
		rows: LikelyRow[];
	},
) {
	return renderList(c, today, filters, {
		sheet: () => (
			<LikelySheet
				savedId={panel.savedId}
				savedDate={panel.savedDate}
				savedCents={panel.savedCents}
				back={panel.back}
				closeAttrs={listCloseAttrs(panel.back, panel.savedId)}
				categoryId={panel.categoryId}
				categoryName={panel.categoryName}
				rows={panel.rows}
				ticked={
					new Set(
						panel.rows.filter((row) => row.sameMerchant).map((row) => row.id),
					)
				}
				today={today}
			/>
		),
	});
}

function renderRuleOffer(
	c: Context<App>,
	today: string,
	back: string,
	value: RuleOfferValue,
) {
	return renderList(c, today, filtersFrom(c, today, back), {
		sheet: () => (
			<BottomSheet labelledBy="rule-offer-title" closeHref={back}>
				<RuleOffer value={value} focus />
			</BottomSheet>
		),
	});
}

transactions.post("/transactions/rule-offer", (c) =>
	respondToRuleOffer(c, true),
);
transactions.post("/transactions/rule-offer/dismiss", (c) =>
	respondToRuleOffer(c, false),
);

transactions.post("/transactions/:id{[0-9]+}/delete", async (c) => {
	const tx = await getTransaction(c.env.DB, Number(c.req.param("id")));
	if (tx?.accountType !== "cash" || tx.parentId !== null) return c.notFound();
	const form = await c.req.formData();
	const back = safeBack(form.get("back")?.toString());
	const today = await householdToday(c.env.DB);
	if (form.get("confirm") !== "1") {
		const people = (
			await c.env.DB.prepare(
				"SELECT id, name FROM household_people ORDER BY id",
			).all<HouseholdPerson>()
		).results;
		const values: Edit = {
			categoryId: tx.categoryId,
			income: tx.income,
			creditReviewed: tx.creditReviewedByUser,
			alwaysForMerchant:
				tx.merchantRuleCategoryId !== null &&
				tx.merchantRuleCategoryId === tx.categoryId,
			merchantRuleWas: tx.merchantRuleCategoryId,
			displayName: tx.merchantName,
			note: tx.note,
			excluded: tx.excluded,
			refundOfId: tx.refundOfId ?? null,
			kind: tx.kind,
			forPersonId: tx.forPersonId,
		};
		const refunds = await refundPurchases(c.env.DB, tx);
		return renderList(c, today, filtersFrom(c, today, back), {
			sheet: (categories, today) => (
				<EditSheet
					tx={tx}
					back={back}
					categories={categories}
					people={people}
					values={values}
					refunds={refunds}
					deleteConfirm
					today={today}
				/>
			),
		});
	}
	const undoToken = await holdCashDelete(c.env.DB, tx.id, tx.displayName);
	if (!undoToken) return c.notFound();
	const undoExpiresInMs = await cashDeleteUndoExpiresInMs(c.env.DB, undoToken);
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	const deleted = `Deleted ${tx.displayName}, ${formatCents(tx.amountCents)}.`;
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: {
				message: deleted,
				type: "success",
				undo: undoToken,
				undoExpiresInMs,
			},
			// The Undo window is ten seconds by design (the token's life), so the words say so (#342).
			announce: `${deleted} Undo for 10 seconds.`,
		}),
	);
	c.header("HX-Push-Url", back);
	const nowFirstVisit = (await firstVisitFor(c)) !== null;
	if (nowFirstVisit) swapWholePage(c);
	return renderList(c, today, filtersFrom(c, today, back), {
		focusHeading: nowFirstVisit,
	});
});

transactions.post("/transactions/undo-cash-delete", async (c) => {
	const form = await c.req.formData();
	const token = form.get("token");
	const back = safeBack(form.get("back")?.toString());
	const wasFirstVisit = (await firstVisitFor(c)) !== null;
	const restored =
		typeof token === "string" && /^[0-9a-f-]{36}$/i.test(token)
			? await restoreCashDelete(c.env.DB, token)
			: null;
	const today = await householdToday(c.env.DB);
	if (!c.req.header("HX-Request")) return c.redirect(back, 303);
	// The restored entry, when this Undo restored it (not an earlier one, nor an expired one).
	const restoredNow = restored && !restored.alreadyRestored ? restored : null;
	c.header(
		"HX-Trigger",
		JSON.stringify(
			restoredNow
				? {
						// undoDone names the Deleted toast this Undo answers, which ends with this one (#397).
						toast: {
							message:
								restoredNow.lostLinks.length > 0
									? `Restored ${restoredNow.name}. ${restoredNow.lostLinks.join(", ")} no longer fits and was left off.`
									: `Restored ${restoredNow.name}.`,
							type: "success",
							undoDone: token,
						},
						announce: `${restoredNow.name} is back.`,
					}
				: restored?.alreadyRestored
					? {
							toast: {
								message: "That cash entry is already back.",
								type: "success",
							},
							announce: `${restored.name} is already back.`,
						}
					: {
							toast: {
								message: "Undo expired. The cash entry stays deleted.",
								type: "error",
							},
							announce: "Undo expired. The cash entry stays deleted.",
						},
		),
	);
	c.header("HX-Push-Url", back);
	if (wasFirstVisit && restoredNow) swapWholePage(c);
	// The restored row takes focus when this list shows it; otherwise toast.js moves focus to the heading as the Undo toast ends (#397).
	return renderList(c, today, filtersFrom(c, today, back), {
		restoredId: restoredNow?.id,
	});
});
