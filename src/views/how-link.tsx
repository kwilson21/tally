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
			class="inline-flex min-h-11 items-center text-sm"
		>
			How this works
		</a>
	);
}
