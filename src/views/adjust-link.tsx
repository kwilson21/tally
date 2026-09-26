// Home's Adjust mode switch (#94, decision 48): beside the Budget heading, "Adjust" shows − and + on
// every budgeted row, and "Done" puts them away. A plain link either way, so it works without JavaScript.

type Props = {
	adjusting: boolean;
	/** Where it goes instead of Home: the catalog points it at the other state. */
	href?: string;
	/** htmx attributes that swap the list in place. */
	attrs?: Record<string, string>;
};

/** "Adjust" or "Done": a terracotta text link to Home in or out of Adjust mode. */
export function AdjustLink({ adjusting, href, attrs }: Props) {
	return (
		<a
			href={href ?? (adjusting ? "/" : "/?adjust=1")}
			class="inline-flex min-h-11 items-center text-accent"
			{...attrs}
		>
			{adjusting ? "Done" : "Adjust"}
			<span class="sr-only">
				{adjusting ? " adjusting budgets" : " budgets"}
			</span>
		</a>
	);
}
