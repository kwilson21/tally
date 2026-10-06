/**
 * The demo's "See it without AI" (spec §8.6, decisions 73 and 79; P44 A): two plain links under the
 * Transactions title that switch the list between what Tally made of it and the bank's own data. The
 * current one is ink, semibold and not underlined, with `aria-current="page"`; the other is a terracotta
 * link. Each is 44px tall, and the dot between them is for the eye only. No script: they are links.
 */
export function ViewLinks({
	current,
	madeHref,
	bankHref,
	id = "view-links",
}: {
	current: "made" | "bank";
	/** The list as Tally made it. */
	madeHref: string;
	/** The same list as the bank sends it. */
	bankHref: string;
	/** The page swaps it out of band when a filter changes, so it keeps the filters; the catalog draws it twice. */
	id?: string;
}) {
	const link = "inline-flex min-h-11 items-center";
	const here = `${link} font-semibold text-ink no-underline`;
	return (
		<nav id={id} aria-label="View" class="flex flex-wrap items-center gap-x-2">
			<a
				href={madeHref}
				aria-current={current === "made" ? "page" : undefined}
				class={current === "made" ? here : link}
			>
				Tidied by Tally
			</a>
			<span aria-hidden="true" class="text-muted">
				·
			</span>
			<a
				href={bankHref}
				aria-current={current === "bank" ? "page" : undefined}
				class={current === "bank" ? here : link}
			>
				Straight from the bank
			</a>
		</nav>
	);
}
