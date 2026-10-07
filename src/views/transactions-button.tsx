import { Icon } from "./icons";

/** A 44px pill link to the counted transactions behind a budget row. */
export function TransactionsButton({
	href,
	count,
}: {
	href: string;
	count: number;
}) {
	if (count <= 0) return null;
	return (
		<a
			href={href}
			class="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full border border-ink px-4 font-medium text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			{count} {count === 1 ? "transaction" : "transactions"}
			<Icon name="chevron-right" class="size-5" />
		</a>
	);
}
