import { Button } from "./button";

/**
 * What a reply refreshes in the bar: the live count and both actions, and the page link (its
 * wrapper stays in place, so a count can bring the link back). Out of band, a list change adds the
 * list's own parts to this (LIST_OOB in the transactions route).
 */
export const SELECTION_BAR_OOB =
	"#selected-count:innerHTML, #set-category-selection:outerHTML, #exclude-selection:outerHTML, #select-all-page:outerHTML";

/** The bar's two actions. Out of band, a count's reply swaps them in place; each keeps its own request otherwise. */
export function SelectionActionButtons({
	disabled = false,
	oob = false,
}: {
	disabled?: boolean;
	oob?: boolean;
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
 * The text link that ticks every selectable row on this page (P70 A). It is a plain link to the
 * same select-mode list with those rows ticked, so it works without JavaScript too. It shows until
 * every row on the page is ticked. The wrapper always stays, carrying the page's ids, so a count
 * can swap the link in or out.
 */
export function SelectAllOnPage({
	href,
	pageIds,
	ticked,
	oob = false,
}: {
	href: string;
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
					href={href}
					class="-mr-2"
					hx-get={href}
					hx-target="#results"
					hx-select="#results > *"
					hx-select-oob={SELECTION_BAR_OOB}
					hx-swap="innerHTML"
					hx-push-url="true"
				>
					{`Select all ${pageIds.length}`}
				</Button>
			)}
		</span>
	);
}

/**
 * The select-mode action bar (P70 A and P81 A): the live "N selected" count with the page link
 * beside it, and Set category and Exclude on a second line.
 */
export function SelectionActionBar({
	label,
	href,
	pageIds,
	ticked,
	disabled = false,
}: {
	label: string;
	/** The select-mode list with the page's rows ticked. */
	href: string;
	pageIds: number[];
	ticked: Set<number>;
	disabled?: boolean;
}) {
	return (
		<div class="flex flex-col gap-1">
			<div class="flex items-center justify-between gap-2">
				<span id="selected-count" aria-live="polite" class="text-lg">
					{label}
				</span>
				<SelectAllOnPage href={href} pageIds={pageIds} ticked={ticked} />
			</div>
			<div class="flex gap-2">
				<SelectionActionButtons disabled={disabled} />
			</div>
		</div>
	);
}
