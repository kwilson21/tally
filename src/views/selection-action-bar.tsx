import type { Child } from "hono/jsx";
import {
	NO_SELECTION,
	type Selection,
	unique,
} from "../transactions/selection";
import { Button } from "./button";
import { Icon } from "./icons";

/** The most ticked rows one bulk action takes (D1 binds at most 100 parameters per statement). */
export const MAX_SELECTED = 100;
/** Over the limit the bar says so in brick; both actions wait, and nothing is trimmed. */
export const TOO_MANY = `Select ${MAX_SELECTED} or fewer transactions.`;

/**
 * What a reply refreshes in the bar: the live count and both actions, the Select all link (its wrapper
 * stays in place, so a count can bring the link back), the limit and the line for ticks not on this
 * page. Out of band, a list change adds the list's own parts to this (LIST_OOB in the transactions route).
 */
export const SELECTION_BAR_OOB =
	"#selected-count:innerHTML, #set-category-selection:outerHTML, #exclude-selection:outerHTML, #select-all-page:outerHTML, #selection-limit:outerHTML, #not-on-page:outerHTML";

/**
 * The `focus` value the Select all link asks its reply for: the reply focuses Set category, since
 * the link leaves with that reply (a focused element that is removed drops focus to the page).
 */
export const FOCUS_SET_CATEGORY = "set-category-selection";

/**
 * The `focus` value Older and Newer ask their reply for: the reply focuses the first row's tick, since
 * the page link that had focus leaves with the old list.
 */
export const FOCUS_FIRST_TICK = "first-tick";

/**
 * The attributes a Select-mode list request carries: htmx marks the selection form while it loads (its
 * ticks pause with it, in CSS) and disables the two actions until the reply lands.
 */
export const LIST_LOAD_PAUSE = {
	"hx-indicator": "#selection-form",
	"hx-disable": "#set-category-selection, #exclude-selection",
};

/**
 * Every ticked row in the selection form, on this page or not (the rows a list request carries, #350), and
 * the fields that carry the rest of the selection: the page's rows, the all-mode flag and the unticked rows (#321).
 */
const TICKS = "#selection-form input[name=ids]:checked, #select-all-page input";

/**
 * The form field the "not on this page" line sends while it is drawn, so a count that empties the line
 * can tell the last tick was unticked in the disclosure, and move focus into the bar (#350).
 */
export const NOT_ON_PAGE_FIELD = "not-on-page";

/**
 * Every ticked row rides in a list request, on this page or not, so the ticks survive a change of
 * page, search or filter (#350). The selection's own fields ride with them (#321).
 */
export const TICKS_INCLUDE = { "hx-include": TICKS };

/**
 * The selection as address parameters, each only when it is set: the ticks and the held ticks as `ids` (each
 * once), the all-mode flag, and the rows unticked from the whole set (#321). Each is written in the address, so
 * a reload keeps the selection, and an address read sorts a held tick back into place (settle).
 */
export const selectionQuery = (selection: Selection) => {
	const ids = unique([...selection.ticks, ...selection.held]);
	return `${ids.length ? `&ids=${ids.join(",")}` : ""}${selection.all ? "&all=1" : ""}${selection.all && selection.unticked.length ? `&unticked=${selection.unticked.join(",")}` : ""}`;
};

/** The select-mode list at `back` (the list's own address), with this selection. */
export const selectModeHref = (back: string, selection: Selection) =>
	`${back}${back.includes("?") ? "&" : "?"}select=1${selectionQuery(selection)}`;

/**
 * The all-mode fields a form posts: the flag, each tick the set holds (`held`), and each row unticked from the
 * set (#321). The page's own rows are read from their boxes, so these are for the rows off the page.
 */
export function SelectionFields({ selection }: { selection: Selection }) {
	if (!selection.all) return null;
	return (
		<>
			<input type="hidden" name="all" value="1" />
			{selection.held.map((id) => (
				<input type="hidden" name="held" value={id} />
			))}
			{selection.unticked.map((id) => (
				<input type="hidden" name="unticked" value={id} />
			))}
		</>
	);
}

/** The bar's two actions. Out of band, a count's reply swaps them in place; each keeps its own request otherwise. */
export function SelectionActionButtons({
	disabled = false,
	oob = false,
	focusSetCategory = false,
}: {
	disabled?: boolean;
	oob?: boolean;
	/** Set category takes focus when it is drawn (only a Select all reply asks for it, and only when enabled). */
	focusSetCategory?: boolean;
}) {
	const oobSwap = oob ? "outerHTML" : undefined;
	return (
		<>
			<Button
				id="set-category-selection"
				kind="secondary"
				type="submit"
				class="px-3"
				formaction="/transactions/select/category"
				formmethod="post"
				disabled={disabled}
				autofocus={focusSetCategory && !disabled}
				hx-post="/transactions/select/category"
				hx-target="#sheet"
				hx-select="#sheet"
				hx-swap="outerHTML"
				hx-swap-oob={oobSwap}
			>
				Set category
			</Button>
			<Button
				id="exclude-selection"
				kind="secondary"
				type="submit"
				class="px-3"
				formaction="/transactions/select/exclude"
				formmethod="post"
				disabled={disabled}
				hx-post="/transactions/select/exclude"
				hx-target="#main"
				hx-select="#main > *"
				hx-swap="innerHTML"
				hx-swap-oob={oobSwap}
			>
				Exclude
			</Button>
		</>
	);
}

/**
 * Which Select all link the bar offers (P70 A, P81 A, #321). While some rows on the page aren't ticked, the page
 * ("Select all 25"). Once they are, or in all mode, the whole set ("Select all 112 in September") while some
 * matched row isn't selected yet, so the link never offers to tick nothing. Null otherwise.
 */
export function selectAllOffer({
	pageIds,
	ticked,
	all,
	unselected,
}: {
	pageIds: number[];
	ticked: Set<number>;
	all: boolean;
	/** The rows the filters match that the bar doesn't select yet: what the whole-set link would add. */
	unselected: number;
}): "page" | "whole" | null {
	if (all) return unselected > 0 ? "whole" : null;
	if (pageIds.length > 0 && !pageIds.every((id) => ticked.has(id)))
		return "page";
	return unselected > 0 ? "whole" : null;
}

/**
 * The text link that ticks rows: the page's (P70 A), or the whole set (P81 A, "Select all 112 in September"). Each is a
 * plain link to the same select-mode list, carrying the selection already in the address, so it works without
 * JavaScript too. Its htmx request asks the reply to focus Set category (FOCUS_SET_CATEGORY), while the pushed
 * address stays the plain list. The wrapper always stays, carrying the page's ids and the selection's fields, so a
 * count can swap the link in or out.
 */
export function SelectAllOnPage({
	back,
	pageIds,
	selection,
	unselected,
	total,
	words,
	oob = false,
	autofocus = false,
}: {
	/** The list's own address (no selection), which the link builds on. */
	back: string;
	/** The selectable rows on the page (split parents have no checkbox). */
	pageIds: number[];
	/** The selection the bar shows, settled against the filters (see settle). */
	selection: Selection;
	/** The rows the filters match that the bar doesn't select yet (see selectAllOffer). */
	unselected: number;
	/** The selectable rows the filters match: the whole-set link's number (#321). */
	total: number;
	/** The month the whole-set link names: "September", or "all months". */
	words: string;
	oob?: boolean;
	/** Takes focus when it is drawn (a count reply after the last tick off the page is unticked, #350). */
	autofocus?: boolean;
}) {
	const offer = selectAllOffer({
		pageIds,
		ticked: new Set(selection.ticks),
		all: selection.all,
		unselected,
	});
	// Each id once: the ticks, the held ones, then this page's rows that aren't ticked yet (the address both forms share).
	const pageAddress = selectModeHref(back, {
		ticks: unique([...selection.ticks, ...selection.held, ...pageIds]),
		held: [],
		all: false,
		unticked: [],
	});
	// The whole set, with every tick kept and no unticked rows: the link ticks everything the filters match.
	const wholeAddress = selectModeHref(back, {
		ticks: selection.ticks,
		held: selection.held,
		all: true,
		unticked: [],
	});
	return (
		<span id="select-all-page" hx-swap-oob={oob ? "outerHTML" : undefined}>
			<input type="hidden" name="page-ids" value={pageIds.join(",")} />
			<SelectionFields selection={selection} />
			{offer === "page" && (
				<Button
					kind="text"
					// Without JavaScript the link carries the ticks and ticks this page's rows.
					href={pageAddress}
					class="-mr-2"
					// htmx replaces a URL's own ids with the ones it includes, so this address has none: the ticks
					// and the page's rows come as parameters, and the reply ticks both (page-ids, #350).
					hx-get={`${selectModeHref(back, NO_SELECTION)}&focus=${FOCUS_SET_CATEGORY}`}
					{...LIST_LOAD_PAUSE}
					hx-include={TICKS}
					hx-sync="#filters:replace"
					hx-target="#results"
					hx-select="#results > *"
					hx-select-oob={SELECTION_BAR_OOB}
					hx-swap="innerHTML"
					// The reply's HX-Push-Url (the ticks, without the focus marker) replaces this in Select mode.
					hx-push-url={pageAddress}
					autofocus={autofocus}
				>
					{`Select all ${pageIds.length}`}
				</Button>
			)}
			{offer === "whole" && (
				<Button
					kind="text"
					href={wholeAddress}
					class="-mr-2"
					// As the page link: the all-mode flag rides in the request, and the ticks and the fields come as parameters.
					hx-get={`${selectModeHref(back, { ticks: [], held: [], all: true, unticked: [] })}&focus=${FOCUS_SET_CATEGORY}`}
					{...LIST_LOAD_PAUSE}
					hx-include={TICKS}
					hx-sync="#filters:replace"
					hx-target="#results"
					hx-select="#results > *"
					hx-select-oob={SELECTION_BAR_OOB}
					hx-swap="innerHTML"
					hx-push-url={wholeAddress}
					autofocus={autofocus}
				>
					{`Select all ${total} in ${words}`}
				</Button>
			)}
		</span>
	);
}

/**
 * The live count's words: "3 selected". A screen reader also hears ", 3 not on this page" when some
 * ticks are not in the list on screen, so one utterance says both.
 */
export function SelectedCount({
	count,
	notOnPage,
	focus = false,
}: {
	count: number;
	notOnPage: number;
	/**
	 * Takes focus when drawn, for a count that has no Select all to take it: the last tick off the page was
	 * unticked in its disclosure (#350). The live region's own element can't carry it, so this span does.
	 */
	focus?: boolean;
}) {
	const words = (
		<>
			{count} selected
			{notOnPage > 0 && (
				<span class="sr-only">, {notOnPage} not on this page</span>
			)}
		</>
	);
	// As the result count and the title do: no ring around text that is only there to be read.
	return focus ? (
		<span tabindex={-1} autofocus class="outline-none">
			{words}
		</span>
	) : (
		words
	);
}

/**
 * Over the limit, the words in brick with the alert icon, under the count. The wrapper always stays,
 * so a count can draw or remove the words out of band.
 */
export function SelectionLimit({
	count,
	oob = false,
}: {
	count: number;
	oob?: boolean;
}) {
	return (
		<div
			id="selection-limit"
			class="empty:hidden"
			hx-swap-oob={oob ? "outerHTML" : undefined}
		>
			{count > MAX_SELECTED && (
				<p role="alert" class="flex items-center gap-1 text-sm text-over">
					<Icon name="alert" class="size-4 shrink-0" />
					{TOO_MANY}
				</p>
			)}
		</div>
	);
}

/** How many ticks are not in the list on screen, in the disclosure's summary (terracotta, a link). */
export function NotOnPageCount({
	count,
	oob = false,
}: {
	count: number;
	oob?: boolean;
}) {
	return (
		<span
			id="not-on-page-count"
			hx-swap-oob={oob ? "innerHTML" : undefined}
		>{`${count} not on this page`}</span>
	);
}

/**
 * The line for ticks not on this page: a closed disclosure that opens onto those rows, ticked, in a
 * list up to 40% of the screen tall that scrolls on its own. The wrapper always stays, so a list reply
 * can draw the line or take it away (SELECTION_BAR_OOB). `open` is only for the catalog's open state.
 * Out of band, a count reply with none left empties the wrapper, so the line goes (#350).
 */
export function NotOnPage({
	count,
	rows,
	open = false,
	oob = false,
}: {
	count: number;
	rows?: Child;
	open?: boolean;
	oob?: boolean;
}) {
	return (
		<div
			id="not-on-page"
			class="empty:hidden"
			hx-swap-oob={oob ? "outerHTML" : undefined}
		>
			{count > 0 && (
				<>
					{/* Sent with every count while the line is drawn (NOT_ON_PAGE_FIELD). */}
					<input type="hidden" name={NOT_ON_PAGE_FIELD} value="1" />
					<details class="group" open={open}>
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
							<NotOnPageCount count={count} />
							<span class="ml-auto shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
								<Icon name="chevron-right" class="size-5" />
							</span>
						</summary>
						<div class="max-h-[40vh] overflow-y-auto">{rows}</div>
					</details>
				</>
			)}
		</div>
	);
}

/**
 * The select-mode action bar (P70 A and P81 A): the live "N selected" count with the Select all link
 * beside it, then the limit, the line for ticks not on this page, and Set category and Exclude on the
 * last line. `count` is what the actions act on (the whole set in all mode); `selection.ticks` is what the
 * limit counts.
 */
export function SelectionActionBar({
	label,
	count,
	notOnPage,
	rows,
	back,
	pageIds,
	selection,
	unselected,
	total,
	words,
	disabled = false,
	focusSetCategory = false,
	openNotOnPage = false,
}: {
	/** The words for the count when there is no script to count with (the first load without JavaScript). */
	label?: string;
	/** The rows the actions act on, which the words count. */
	count: number;
	/** The ticked rows that are not in the list on screen. */
	notOnPage: number;
	/** Those rows, under their day headings, for the disclosure. */
	rows?: Child;
	/** The list's own address, which Select all builds on. */
	back: string;
	pageIds: number[];
	/** The selection, settled against the filters (#321). */
	selection: Selection;
	/** The rows the filters match that the bar doesn't select yet (see selectAllOffer). */
	unselected: number;
	/** The selectable rows the filters match: the whole-set link's number. */
	total: number;
	/** The month the whole-set link names. */
	words: string;
	disabled?: boolean;
	/** The reply to Select all: Set category takes focus (see FOCUS_SET_CATEGORY). */
	focusSetCategory?: boolean;
	/** The catalog's open state (the app's disclosure is always closed when drawn). */
	openNotOnPage?: boolean;
}) {
	return (
		<div class="flex flex-col gap-1">
			<div class="flex items-center justify-between gap-2">
				<span id="selected-count" aria-live="polite" class="text-lg">
					{label ?? <SelectedCount count={count} notOnPage={notOnPage} />}
				</span>
				<SelectAllOnPage
					back={back}
					pageIds={pageIds}
					selection={selection}
					unselected={unselected}
					total={total}
					words={words}
				/>
			</div>
			<SelectionLimit count={selection.ticks.length} />
			<NotOnPage count={notOnPage} rows={rows} open={openNotOnPage} />
			<div class="flex gap-2">
				<SelectionActionButtons
					disabled={disabled}
					focusSetCategory={focusSetCategory}
				/>
			</div>
		</div>
	);
}
