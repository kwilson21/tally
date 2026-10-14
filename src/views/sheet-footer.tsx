import type { Child } from "hono/jsx";
import { Button } from "./button";

/**
 * A sheet's pinned footer (BottomSheet's `footer`): Cancel and the one primary side by side, each
 * half the width and 44px tall, under the sheet's rule. It stays in view however long the form is,
 * so a phone never scrolls to reach Save (gap E8, decision 80).
 */
export function SheetFooter({ children }: { children?: Child }) {
	return <div class="grid grid-cols-2 gap-3">{children}</div>;
}

/**
 * Cancel: a secondary link back to the list, with the sheet's close attributes, so it closes the
 * sheet as the backdrop does and works without JavaScript.
 */
export function SheetCancel({
	href,
	attrs,
}: {
	href: string;
	attrs?: Record<string, string>;
}) {
	return (
		<Button kind="secondary" href={href} class="w-full" {...attrs}>
			Cancel
		</Button>
	);
}

/**
 * The one primary: a submit button that posts the form it names by id (`form`), so it can sit in
 * the footer, outside the form. The form must carry `hx-indicator="#<id>"`, so the busy label shows
 * while it posts, and `hx-disable="#<id>"`, so the primary is off then and a double tap posts once.
 * Both name it by id: `findAll` searches only inside the form, and a bare `#id` reaches the button
 * outside it.
 */
export function SheetPrimary({
	id,
	form,
	busyLabel,
	children,
}: {
	id?: string;
	form: string;
	busyLabel?: string;
	children?: Child;
}) {
	return (
		<Button
			id={id}
			type="submit"
			form={form}
			busyLabel={busyLabel}
			class="w-full"
		>
			{children}
		</Button>
	);
}
