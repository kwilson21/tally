import { Icon } from "./icons";

/** The fixed link that gives every page a quiet way to send feedback; hidden while selecting rows, where the action bar takes its place, and on a phone while a toast shows, so the toast never sits over it. It stays while it has focus, so focus is never lost. */
export function FeedbackButton({ fixed = true }: { fixed?: boolean }) {
	return (
		<a
			href="/feedback"
			class={`${fixed ? "fixed bottom-[calc(var(--feedback-bottom)+var(--safe-area-bottom))] right-[calc(1rem+var(--safe-area-right))] z-20 lg:bottom-6 lg:right-6 [body:has(#selection-form)_&]:hidden max-lg:[body:has(#toasts>*)_&:not(:focus)]:hidden" : ""} inline-flex min-h-[var(--feedback-height)] items-center gap-2 rounded-full border border-ink bg-paper px-4 text-sm font-medium text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
		>
			<Icon name="message" class="size-5" />
			Feedback
		</a>
	);
}
