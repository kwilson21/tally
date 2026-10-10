import { CategoryIcon } from "./category";
import { categoryRowAmount } from "./category-amount";

/** A category without a budget: its counted amount sits under its name; only active rows can open a sheet. */
export function NotBudgetedRow({
	name,
	icon,
	color,
	spentCents,
	href,
	attrs,
	autofocus,
}: {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	href?: string;
	attrs?: Record<string, string>;
	autofocus?: boolean;
}) {
	const amount = categoryRowAmount(spentCents);
	const content = (
		<>
			<CategoryIcon icon={icon} color={color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg">{name}</span>
				{spentCents !== 0 && (
					<span
						class={`block text-sm ${spentCents < 0 ? "text-ok" : "text-muted"}`}
					>
						{amount.text}
						{spentCents > 0 && " spent"}
					</span>
				)}
			</span>
			{href && <span class="shrink-0 text-accent">Add a budget</span>}
		</>
	);
	const className =
		"flex min-h-11 items-center gap-4 py-2 text-ink no-underline";
	return (
		<li>
			{href ? (
				<a href={href} autofocus={autofocus} class={className} {...attrs}>
					{content}
				</a>
			) : (
				<div class={className}>{content}</div>
			)}
		</li>
	);
}
