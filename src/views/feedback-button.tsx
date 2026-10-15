import { Icon } from "./icons";

/** The link that gives every page a quiet way to send feedback. On a phone it sits at the right of the top line, beside the wordmark (layout.tsx), and scrolls away with the page, so it never covers a row or a button; on desktop the sidebar's second group carries it instead (P123 A). */
export function FeedbackButton() {
	return (
		<a
			href="/feedback"
			class="inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-paper px-4 text-sm font-medium text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			<Icon name="message" class="size-5" />
			Feedback
		</a>
	);
}
