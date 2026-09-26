import type { Child } from "hono/jsx";
import { nudgeCents } from "../budgets/nudge";
import { formatCents } from "../money";
import { barGeometry } from "./bar";
import { CategoryIcon } from "./category";
import { Icon } from "./icons";

type Props = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
	/** Where the row goes: its budget sheet (#66). None for an archived category, which can't be budgeted. */
	href?: string;
	/** htmx attributes that open the sheet in place. */
	attrs?: Record<string, string>;
	autofocus?: boolean;
	/**
	 * Adjust mode (#94, decision 48): a − before the row and a + after it, each posting to
	 * `${href}/down` or `${href}/up`. `id` prefixes the buttons' ids, so htmx keeps focus on the one
	 * tapped when the list is swapped back in.
	 */
	nudge?: { href: string; id: string; attrs?: Record<string, string> };
};

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });

/** The row's box: a link to its budget sheet, or a plain block when there's nowhere to go. */
function Wrap({
	href,
	autofocus,
	attrs,
	adjusting,
	children,
}: {
	href?: string;
	autofocus?: boolean;
	attrs?: Record<string, string>;
	adjusting?: boolean;
	children?: Child;
}) {
	const box = `flex items-start py-3 text-ink no-underline ${adjusting ? "min-w-0 flex-1 gap-3" : "gap-4"}`;
	return href ? (
		<a href={href} autofocus={autofocus} class={box} {...attrs}>
			{children}
		</a>
	) : (
		<div class={box}>{children}</div>
	);
}

// The same round button as the money input's ±$1 (P3: the owner kept those), at 44px.
const round =
	"flex size-11 shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-xl font-semibold leading-none text-muted select-none hover:text-ink disabled:opacity-40";

/** One − or + in Adjust mode: a form that posts without JavaScript, labeled with where it goes. */
function Nudge({
	name,
	budgetCents,
	direction,
	nudge,
}: {
	name: string;
	budgetCents: number;
	direction: "up" | "down";
	nudge: NonNullable<Props["nudge"]>;
}) {
	const to = nudgeCents(budgetCents, direction);
	const stuck = to === budgetCents;
	const label = stuck
		? direction === "down"
			? `${name} is at $0`
			: `${name} is at the largest budget`
		: `${direction === "down" ? "Lower" : "Raise"} ${name} to ${whole(to)}`;
	const href = `${nudge.href}/${direction}`;
	return (
		<form method="post" action={href} hx-post={href} {...nudge.attrs}>
			<button
				type="submit"
				id={`${nudge.id}-${direction}`}
				aria-label={label}
				disabled={stuck}
				class={round}
			>
				<span aria-hidden="true">{direction === "down" ? "−" : "+"}</span>
			</button>
		</form>
	);
}

/** One budget category: icon, name, "spent of budget", and a 4px bar; over budget, it's full and says by how much. */
export function ProgressRow({
	name,
	icon,
	color,
	spentCents,
	budgetCents,
	href,
	attrs,
	autofocus,
	nudge,
}: Props) {
	const over = spentCents > budgetCents;
	const { fillPct } = barGeometry(spentCents, budgetCents);
	// Cents only when there are some, as the status sentence says it: "$36 over", "$36.50 over".
	const overBy = spentCents - budgetCents;
	const overText = formatCents(overBy, { wholeDollars: overBy % 100 === 0 });
	const nudgeProps = nudge && { name, budgetCents, nudge };
	return (
		<li class={nudge ? "flex items-center gap-2" : undefined}>
			{nudgeProps && <Nudge direction="down" {...nudgeProps} />}
			<Wrap
				href={href}
				autofocus={autofocus}
				attrs={attrs}
				adjusting={nudge !== undefined}
			>
				{nudge ? (
					// On a phone in Adjust mode, − takes the icon's place, so the name and amount fit on one line.
					<span class="hidden sm:contents">
						<CategoryIcon icon={icon} color={color} />
					</span>
				) : (
					<CategoryIcon icon={icon} color={color} />
				)}
				<div class="min-w-0 flex-1">
					{/* When name and amount don't fit on one line, the amount moves under the name; if it still
					    doesn't fit (a narrow phone in Adjust mode), it breaks at "of", never inside a number. */}
					<div class="flex flex-wrap items-baseline justify-between gap-x-3">
						<span class="text-lg">{name}</span>
						<span class="ml-auto text-right text-lg">
							{whole(spentCents)} of {whole(budgetCents)}
						</span>
					</div>
					{/* SVG, not a styled div: the CSP forbids style attributes, and SVG width attributes aren't CSS. */}
					{/* 4px, no limit marker (decision 46): over budget is a full brick bar plus the words. */}
					<svg class="mt-2 h-1 w-full" aria-hidden="true">
						<rect width="100%" height="100%" rx="2" class="fill-rule" />
						<rect
							width={`${fillPct}%`}
							height="100%"
							rx="2"
							// In Adjust mode each tap redraws the list; replaying every fill would make it jump.
							class={`${nudge ? "" : "bar-fill "}${over ? "fill-over" : "fill-ok"}`}
						/>
					</svg>
					{over && (
						<p class="mt-1 flex items-center justify-end gap-1 text-over">
							<Icon name="alert" class="size-5" />
							{overText} over<span class="sr-only"> budget</span>
						</p>
					)}
					{href && <span class="sr-only">, change the budget</span>}
				</div>
			</Wrap>
			{nudgeProps && <Nudge direction="up" {...nudgeProps} />}
		</li>
	);
}
