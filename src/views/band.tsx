import type { Child } from "hono/jsx";
import { Icon } from "./icons";

/**
 * The one tinted row per screen that links to the thing to do next, with an optional quiet second
 * line (Home's "$228 of this month's spending", decision 50).
 */
export function Band({
	href,
	detail,
	older,
	children,
}: {
	href: string;
	detail?: string;
	older?: number;
	children?: Child;
}) {
	return (
		<a
			href={href}
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-lg text-ink no-underline"
		>
			{detail ? (
				<span class="min-w-0">
					<span class="flex flex-wrap items-center gap-x-2">
						<span>{children}</span>
						{older !== undefined && older > 0 && (
							<span class="rounded-full bg-rule px-2.5 py-0.5 text-sm text-ink">
								+{older} older<span class="sr-only"> from earlier months</span>
							</span>
						)}
					</span>
					<span class="block text-base text-muted">{detail}</span>
				</span>
			) : (
				<span class="flex flex-wrap items-center gap-x-2">
					<span>{children}</span>
					{older !== undefined && older > 0 && (
						<span class="rounded-full bg-rule px-2.5 py-0.5 text-sm text-ink">
							+{older} older<span class="sr-only"> from earlier months</span>
						</span>
					)}
				</span>
			)}
			<Icon name="chevron-right" />
		</a>
	);
}
