import type { JSX } from "hono/jsx";
import { Button } from "./button";
import { Icon } from "./icons";

/**
 * The store lookup's line under a guess that used it, with "Don't use this" on the row below (P146 option B, decision 244).
 * The action names its store, so a screen reader hears which line it drops.
 */
export function LookupLine({
	line,
	store,
	button,
}: {
	line: string;
	store: string;
	/** The Don't use this button's own attributes: the card's answer name and value, or the edit panel's request. */
	button?: Omit<JSX.IntrinsicElements["button"], "class">;
}) {
	return (
		<div class="flex flex-col items-start">
			<p class="flex items-start gap-1.5 text-sm text-muted">
				<Icon name="search" class="mt-0.5 size-4 shrink-0" />
				<span class="wrap-anywhere">From the web: {line}</span>
			</p>
			<Button
				kind="quiet"
				type="submit"
				class="-ml-2"
				aria-label={`Don't use this for ${store}`}
				{...button}
			>
				Don't use this
			</Button>
		</div>
	);
}
