import type { Child } from "hono/jsx";
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
};

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });

/** The row's box: a link to its budget sheet, or a plain block when there's nowhere to go. */
function Wrap({
	href,
	autofocus,
	attrs,
	children,
}: {
	href?: string;
	autofocus?: boolean;
	attrs?: Record<string, string>;
	children?: Child;
}) {
	const box = "flex items-start gap-4 py-3 text-ink no-underline";
	return href ? (
		<a href={href} autofocus={autofocus} class={box} {...attrs}>
			{children}
		</a>
	) : (
		<div class={box}>{children}</div>
	);
}

/** One budget category: icon, name, "spent of budget", and a bar with a notch at the limit. */
export function ProgressRow({
	name,
	icon,
	color,
	spentCents,
	budgetCents,
	href,
	attrs,
	autofocus,
}: Props) {
	const over = spentCents > budgetCents;
	const { fillPct, limitPct } = barGeometry(spentCents, budgetCents);
	return (
		<li>
			<Wrap href={href} autofocus={autofocus} attrs={attrs}>
				<CategoryIcon icon={icon} color={color} />
				<div class="min-w-0 flex-1">
					<div class="flex items-baseline justify-between gap-3">
						<span class="text-lg">{name}</span>
						<span class="text-lg">
							{whole(spentCents)} of {whole(budgetCents)}
						</span>
					</div>
					{/* SVG, not a styled div: the CSP forbids style attributes, and SVG width attributes aren't CSS. */}
					<svg class="mt-2 h-2 w-full" aria-hidden="true">
						<rect width="100%" height="100%" rx="4" class="fill-rule" />
						<rect
							width={`${fillPct}%`}
							height="100%"
							rx="4"
							class={`bar-fill ${over ? "fill-over" : "fill-ok"}`}
						/>
						<line
							x1={`${limitPct}%`}
							x2={`${limitPct}%`}
							y1="0"
							y2="100%"
							class="stroke-ink"
							stroke-width="1.75"
						/>
					</svg>
					{over && (
						<p class="mt-1 flex items-center justify-end gap-1 text-over">
							<Icon name="alert" class="size-5" />
							over budget
						</p>
					)}
					{href && <span class="sr-only">, change the budget</span>}
				</div>
			</Wrap>
		</li>
	);
}
