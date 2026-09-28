import { Icon } from "./icons";

/** The fixed link that gives every page a quiet way to send feedback. */
export function FeedbackButton({ from }: { from: string }) {
	return (
		<a
			href={`/feedback?from=${encodeURIComponent(from)}`}
			class="fixed bottom-20 right-4 z-20 inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-paper px-4 text-sm font-medium text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:bottom-6 lg:right-6"
		>
			<Icon name="message" class="size-5" />
			Feedback
		</a>
	);
}
