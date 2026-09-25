// 110 is Local Bakery after a reset (test/seed.test.ts keeps that true), so its edit panel is always there.
const ITEMS = [
	{
		label: "Give a transaction a category",
		href: "/transactions?uncategorized=1",
	},
	{
		label: "Set a rule for a merchant",
		href: "/transactions/110?uncategorized=1",
	},
	{ label: "Rename a merchant", href: "/transactions/110?uncategorized=1" },
];

/** The demo's short list of things to try, each linking to where it's done (spec §9). */
export function ThingsToTry() {
	return (
		<section
			aria-labelledby="things-title"
			class="rounded-control border border-rule px-4 py-3"
		>
			{/* A labelled paragraph, not a heading, so the page's first heading stays its h1. */}
			<p id="things-title" class="font-serif text-2xl font-semibold">
				New here? Things to try
			</p>
			<ul class="mt-1 flex flex-col lg:flex-row lg:flex-wrap lg:gap-x-8">
				{ITEMS.map((item) => (
					<li>
						<a href={item.href} class="inline-flex min-h-11 items-center">
							{item.label}
						</a>
					</li>
				))}
			</ul>
			<p class="text-sm text-muted">
				For a rule or a new name, open a transaction and tick "Always use this
				category for this merchant," or change its merchant name.
			</p>
			<a
				href="/how-it-works"
				class="inline-flex min-h-11 items-center text-muted"
			>
				How Tally works →
			</a>
		</section>
	);
}
