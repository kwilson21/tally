import type { Child } from "hono/jsx";

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
	children?: Child;
};

/**
 * A page region over the list: a bottom sheet on phones, a right-hand panel on desktop.
 * Not a modal: focus moves in via autofocus, and Cancel or the dimmed backdrop (links) close it.
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
	children,
}: Props) {
	return (
		<>
			<a
				href={closeHref}
				aria-label="Close"
				tabindex={-1}
				class={`${still ? "" : "fade-in "}fixed inset-0 z-40 bg-ink/30`}
				{...closeAttrs}
			/>
			<section
				role="dialog"
				aria-labelledby={labelledBy}
				class={`${still ? "" : "sheet-panel "}fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-y-auto rounded-t-sheet bg-paper p-5 pb-[calc(1.25rem+var(--safe-area-bottom))] pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet`}
			>
				{children}
			</section>
		</>
	);
}
