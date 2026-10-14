import { DEMO_BAKERY_ID } from "../db/transactions";

const BAKERY = `/transactions/${DEMO_BAKERY_ID}?uncategorized=1`;

const ITEMS = [
	{
		label: "Give a transaction a category",
		href: "/transactions?uncategorized=1",
	},
	{ label: "Set a rule for a merchant", href: BAKERY },
	{ label: "Rename a merchant", href: BAKERY },
];

/**
 * The demo's three things to try, each linking to where it's done (spec §9). They sit at the end of Start here
 * on How Tally works, not on Home.
 */
export function ThingsToTry() {
	return (
		<div class="mt-8">
			<h3 class="font-serif text-2xl font-semibold">Three things to try</h3>
			<ul class="mt-2">
				{ITEMS.map((item) => (
					<li>
						<a href={item.href} class="inline-flex min-h-11 items-center">
							{item.label}
						</a>
					</li>
				))}
			</ul>
			<p class="text-sm text-muted">
				For a rule, open a transaction and tick "Use this category for … from
				now on." For a new name, pick one in its Name row.
			</p>
		</div>
	);
}
