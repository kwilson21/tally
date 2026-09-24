import type { Child } from "hono/jsx";

type Props = {
	/** id of the sheet's heading. */
	labelledBy: string;
	/** Where the backdrop goes: the list the sheet was opened from. */
	closeHref: string;
	/** htmx attributes that swap the list back in instead of reloading. */
	closeAttrs?: Record<string, string>;
	children?: Child;
};

/**
 * A page region over the list: a bottom sheet on phones, a right-hand panel on desktop.
 * Not a modal: focus moves in via autofocus, and Cancel or the dimmed backdrop (links) close it.
 */
export function BottomSheet({
	labelledBy,
	closeHref,
	closeAttrs,
	children,
}: Props) {
	return (
		<>
			<a
				href={closeHref}
				aria-label="Close"
				tabindex={-1}
				class="fixed inset-0 z-40 bg-ink/30"
				{...closeAttrs}
			/>
			<section
				role="dialog"
				aria-labelledby={labelledBy}
				class="fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-y-auto rounded-t-sheet bg-paper p-5 lg:inset-y-0 lg:left-auto lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-sheet"
			>
				{children}
			</section>
		</>
	);
}
