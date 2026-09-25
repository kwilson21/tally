const NAMES = {
	budget: "the budget",
	transactions: "transactions",
	categorization: "categories",
} as const;

/** A small "How this works" link from a screen to its section of How Tally works; demo only (spec §9). */
export function HowLink({
	section,
	demo,
}: {
	section: "budget" | "transactions" | "categorization";
	demo: boolean;
}) {
	if (!demo) return null;
	return (
		<a
			href={`/how-it-works#${section}`}
			// Distinct names for links to different places (WCAG 2.4.4); the visible text stays in the name.
			aria-label={`How this works: ${NAMES[section]}`}
			class="inline-flex min-h-11 items-center text-sm"
		>
			How this works
		</a>
	);
}
