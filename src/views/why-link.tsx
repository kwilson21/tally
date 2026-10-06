/** The sections of How Tally works a "Why?" link can point to. */
export type WhySection =
	| "budget"
	| "transactions"
	| "exclusions"
	| "categorization"
	| "names"
	| "bills"
	| "trends"
	| "net-worth";

/** A small link beside a rule's result to the exact section that explains it. */
export function WhyLink({
	section,
	topic,
}: {
	section: WhySection;
	topic: string;
}) {
	return (
		<a
			href={`/how-it-works#${section}`}
			// The visible "Why?" starts the name, so voice control can match what's on screen.
			aria-label={`Why? ${topic}`}
			class="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			Why?
		</a>
	);
}
