import type { Child } from "hono/jsx";

/**
 * The htmx attributes that open a link as a sheet over the list it sits in: the page it fetches is swapped down to
 * its #sheet, and the URL is pushed unless `pushUrl` is false (a sheet's own Delete and Cancel keep the URL they have).
 */
export function sheetAttrs(href: string, pushUrl = true) {
	return {
		"hx-get": href,
		"hx-target": "#sheet",
		"hx-select": "#sheet",
		"hx-swap": "outerHTML",
		"hx-push-url": String(pushUrl),
	};
}

type Props = {
	/** id of the sheet's heading. */
	labelledBy: string;
	/** Where the backdrop goes: the list the sheet was opened from. */
	closeHref: string;
	/** htmx attributes that swap the list back in instead of reloading. */
	closeAttrs?: Record<string, string>;
	/**
	 * This draws a sheet that is already open again (a field's error, the delete question, Add a part),
	 * so it stays where it is: neither the backdrop nor the sheet plays its arrival.
	 */
	still?: boolean;
	/**
	 * A pinned footer (SheetFooter): the children scroll above it, and it stays in view however long
	 * the form is (gap E8, decision 80). Without one the whole sheet scrolls, as it always has.
	 */
	footer?: Child;
	children?: Child;
};

/**
 * A page region over the list: a bottom sheet on phones, a right-hand panel on desktop.
 * Focus moves in via autofocus, and Cancel or the dimmed backdrop (links) close it. With sheet.js
 * (decision 109) it is a modal: Escape closes it, Tab stays inside it, and the page behind is inert.
 * Without the script it is only a page region. The markers below are how sheet.js finds it.
 * It arrives in 200 ms (decisions 76 and 80): the backdrop fades in, and the sheet rises (the panel
 * slides in from the right); both are classes in app.css, which still them for reduced motion. They
 * are classes on the elements, so a swap that draws the open sheet again would play them again; the
 * server knows when that is what it is doing, and says `still`.
 */
export function BottomSheet({
	labelledBy,
	closeHref,
	closeAttrs,
	still = false,
	footer,
	children,
}: Props) {
	const arrival = still ? "" : "sheet-panel ";
	return (
		<>
			<a
				href={closeHref}
				aria-label="Close"
				tabindex={-1}
				data-sheet-close=""
				class={`${still ? "" : "fade-in "}fixed inset-0 z-40 bg-ink/30`}
				{...closeAttrs}
			/>
			{footer ? (
				<section
					role="dialog"
					aria-labelledby={labelledBy}
					data-sheet=""
					class={`${arrival}fixed inset-x-0 bottom-0 z-50 flex max-h-[min(90vh,calc(100svh-var(--safe-area-top)-var(--toast-top-room)))] flex-col rounded-t-sheet bg-paper lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet`}
				>
					<div class="min-h-0 flex-1 overflow-y-auto p-5 pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))]">
						{children}
					</div>
					<div class="shrink-0 border-t border-rule pt-3 pb-[calc(1.25rem+var(--safe-area-bottom))] pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))]">
						{footer}
					</div>
				</section>
			) : (
				<section
					role="dialog"
					aria-labelledby={labelledBy}
					data-sheet=""
					class={`${arrival}fixed inset-x-0 bottom-0 z-50 max-h-[min(90vh,calc(100svh-var(--safe-area-top)-var(--toast-top-room)))] overflow-y-auto rounded-t-sheet bg-paper p-5 pb-[calc(1.25rem+var(--safe-area-bottom))] pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet`}
				>
					{children}
				</section>
			)}
		</>
	);
}
