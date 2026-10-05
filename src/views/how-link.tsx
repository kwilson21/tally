const NAMES = {
	budget: "the budget",
	transactions: "transactions",
	categorization: "categories",
	exclusions: "excluding",
	trends: "trends",
} as const;

/** A small "How this works" link from a screen to its section of How Tally works (spec §9). */
export function HowLink({ section }: { section: keyof typeof NAMES }) {
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
