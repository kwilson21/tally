import type { Child } from "hono/jsx";
import { Icon } from "./icons";

/**
 * The one tinted row per screen that links to the thing to do next, with an optional quiet second
 * line (Home's "$228 of this month's spending", decision 50).
 */
export function Band({
	href,
	detail,
	children,
}: {
	href: string;
	detail?: string;
	children?: Child;
}) {
	return (
		<a
			href={href}
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-lg text-ink no-underline"
		>
			{detail ? (
				<span class="min-w-0">
					<span class="block">{children}</span>
					<span class="block text-base text-muted">{detail}</span>
				</span>
			) : (
				<span>{children}</span>
			)}
			<Icon name="chevron-right" />
		</a>
	);
}
