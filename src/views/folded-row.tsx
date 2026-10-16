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
			{/* A grid, so the name, then the choice, then the line read in that order (one phrase, #498) while
			    the line still sits under the name and the choice still sits at the right. */}
			<summary class="grid min-h-12 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
				<span class="col-start-1 row-start-1 flex min-w-0 flex-col">
					<span class="text-muted">{label}</span>
				</span>
				{value && (
					<span
						class={`col-start-2 row-start-1 flex min-w-0 justify-self-end ${sub ? "row-span-2" : ""}`}
					>
						<span class="ml-auto flex min-w-0 items-center gap-2">{value}</span>
					</span>
				)}
				{sub && (
					<span class="col-start-1 row-start-2 flex min-w-0 flex-col">
						<span class="truncate text-sm text-muted">{sub}</span>
					</span>
				)}
				<Icon
					name="chevron-right"
					class={`col-start-3 row-start-1 size-5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none ${sub ? "row-span-2" : ""}`}
				/>
			</summary>
			{children && <div class="pb-3">{children}</div>}
		</details>
	);
}
