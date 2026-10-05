/** A small link beside a rule's result to the exact section that explains it. */
export function WhyLink({
	section,
	topic,
}: {
	section:
		| "architecture"
		| "budget"
		| "transactions"
		| "exclusions"
		| "categorization"
		| "bills";
	topic: string;
}) {
	return (
		<a
			href={`/how-it-works#${section}`}
			aria-label={`Why? ${topic}`}
			class="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			Why?
		</a>
	);
}
