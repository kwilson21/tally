import type { Child } from "hono/jsx";
import { Icon } from "./icons";

/** The one tinted row per screen that links to the thing to do next. */
export function Band({ href, children }: { href: string; children?: Child }) {
	return (
		<a
			href={href}
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-lg text-ink no-underline"
		>
			<span>{children}</span>
			<Icon name="chevron-right" />
		</a>
	);
}
