import type { Child } from "hono/jsx";
import { Icon } from "./icons";

/**
 * A settled choice folded into a row (ledger form, P72 A): its name in muted words, what it holds at
 * the right (`value`, a category's icon and name) or under the name when it's long (`sub`, cut to one
 * line), and a chevron that turns when it opens. It opens in place, and tapping it again closes it.
 * It is a native `<details>` with the disclosure classes Settings uses (DESIGN.md "Disclosure"), so
 * it needs no JavaScript, and what's inside still posts while it's closed. The form sets `open` when
 * a field inside has an error, so the error is seen.
 */
export function FoldedRow({
	label,
	value,
	sub,
	open = false,
	children,
}: {
	label: string;
	value?: Child;
	sub?: Child;
	open?: boolean;
	children?: Child;
}) {
	return (
		<details class="group border-b border-rule" open={open}>
			<summary class="flex min-h-12 cursor-pointer list-none items-center gap-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="text-muted">{label}</span>
					{sub && <span class="truncate text-sm text-muted">{sub}</span>}
				</span>
				{value && (
					<span class="ml-auto flex min-w-0 items-center gap-2">{value}</span>
				)}
				<Icon
					name="chevron-right"
					class="size-5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
				/>
			</summary>
			{children && <div class="pb-3">{children}</div>}
		</details>
	);
}
