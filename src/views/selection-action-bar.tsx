import type { Child } from "hono/jsx";
import { Button } from "./button";
import { Icon } from "./icons";

/** The most ticked rows one bulk action takes (D1 binds at most 100 parameters per statement). */
export const MAX_SELECTED = 100;
/** Over the limit the bar says so in brick; both actions wait, and nothing is trimmed. */
export const TOO_MANY = `Select ${MAX_SELECTED} or fewer transactions.`;

/**
 * What a reply refreshes in the bar: the live count and both actions, the page link (its wrapper
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

/** Every ticked row in the selection form, on this page or not (the rows a list request carries, #350). */
const TICKS = "#selection-form input[name=ids]:checked";

/**
 * Every ticked row rides in a list request, on this page or not, so the ticks survive a change of
 * page, search or filter (#350).
 */
export const TICKS_INCLUDE = { "hx-include": TICKS };

/** The select-mode list at `back` (the list's own address), with these rows ticked. */
export const selectModeHref = (back: string, ids: number[]) =>
	`${back}${back.includes("?") ? "&" : "?"}select=1${ids.length ? `&ids=${ids.join(",")}` : ""}`;

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
 * The text link that ticks every selectable row on the page (P70 A). It is a plain link to the
 * same select-mode list with those rows ticked, so it works without JavaScript too. Its htmx
 * request asks the reply to focus Set category (FOCUS_SET_CATEGORY), while the pushed address stays
 * the plain list. It shows until every row on the page is ticked. The wrapper always stays,
 * carrying the page's ids, so a count can swap the link in or out.
 */
export function SelectAllOnPage({
	back,
	pageIds,
	ticked,
	oob = false,
}: {
	/** The list's own address (no ticks), which Select all's link builds on. */
	back: string;
	/** The selectable rows on the page (split parents have no checkbox). */
	pageIds: number[];
	/** The page's rows that are ticked. */
	ticked: Set<number>;
	oob?: boolean;
}) {
	const showLink = pageIds.length > 0 && !pageIds.every((id) => ticked.has(id));
	return (
		<span id="select-all-page" hx-swap-oob={oob ? "outerHTML" : undefined}>
			<input type="hidden" name="page-ids" value={pageIds.join(",")} />
			{showLink && (
				<Button
					kind="text"
					// Without JavaScript the link ticks this page's rows (its ids are in the address).
					href={selectModeHref(back, pageIds)}
					class="-mr-2"
					// htmx replaces a URL's own ids with the ones it includes, so this address has none: the ticks
					// and the page's rows come as parameters, and the reply ticks both (page-ids, #350).
					hx-get={`${selectModeHref(back, [])}&focus=${FOCUS_SET_CATEGORY}`}
					{...LIST_LOAD_PAUSE}
					hx-include={`${TICKS}, #select-all-page input[name=page-ids]`}
					hx-sync="#filters:replace"
					hx-target="#results"
					hx-select="#results > *"
					hx-select-oob={SELECTION_BAR_OOB}
					hx-swap="innerHTML"
					// The reply's HX-Push-Url (the ticks, without the focus marker) replaces this in Select mode.
					hx-push-url={selectModeHref(back, pageIds)}
				>
					{`Select all ${pageIds.length}`}
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
}: {
	count: number;
	notOnPage: number;
}) {
	return (
		<>
			{count} selected
			{notOnPage > 0 && (
				<span class="sr-only">, {notOnPage} not on this page</span>
			)}
		</>
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
				<details class="group" open={open}>
					<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
						<NotOnPageCount count={count} />
						<span class="ml-auto shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
							<Icon name="chevron-right" class="size-5" />
						</span>
					</summary>
					<div class="max-h-[40vh] overflow-y-auto">{rows}</div>
				</details>
			)}
		</div>
	);
}

/**
 * The select-mode action bar (P70 A and P81 A): the live "N selected" count with the page link
 * beside it, then the limit, the line for ticks not on this page, and Set category and Exclude on the
 * last line.
 */
export function SelectionActionBar({
	label,
	count,
	notOnPage,
	rows,
	back,
	pageIds,
	ticked,
	disabled = false,
	focusSetCategory = false,
	openNotOnPage = false,
}: {
	/** The words for the count when there is no script to count with (the first load without JavaScript). */
	label?: string;
	/** Every ticked row, on this page or not. */
	count: number;
	/** The ticked rows that are not in the list on screen. */
	notOnPage: number;
	/** Those rows, under their day headings, for the disclosure. */
	rows?: Child;
	/** The list's own address, which Select all builds on. */
	back: string;
	pageIds: number[];
	/** The page's rows that are ticked. */
	ticked: Set<number>;
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
				<SelectAllOnPage back={back} pageIds={pageIds} ticked={ticked} />
			</div>
			<SelectionLimit count={count} />
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
