type MarkProps = { class?: string };

// Four upright strokes crossed by one diagonal: "卌", Tally's brand mark.
export function TallyMark({ class: className = "size-7" }: MarkProps) {
	return (
		<svg
			class={className}
			viewBox="0 0 28 28"
			fill="none"
			stroke="currentColor"
			stroke-width="2.25"
			stroke-linecap="round"
			aria-hidden="true"
		>
			<line x1="6" y1="5" x2="6" y2="23" />
			<line x1="11" y1="5" x2="11" y2="23" />
			<line x1="16" y1="5" x2="16" y2="23" />
			<line x1="21" y1="5" x2="21" y2="23" />
			<line x1="2" y1="19" x2="26" y2="9" />
		</svg>
	);
}

export function Wordmark() {
	return (
		<a
			href="/"
			class="flex items-center gap-2 text-ink no-underline"
			aria-label="Tally home"
		>
			<TallyMark />
			<span class="font-serif text-3xl font-semibold tracking-tight">
				Tally
			</span>
		</a>
	);
}
