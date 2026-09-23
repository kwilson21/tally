/** The notebook-and-pencil line drawing beside the headline: ink notebook with tally marks, terracotta pencil. */
export function LedgerIllustration() {
	return (
		<svg
			class="size-28 shrink-0 lg:size-36"
			viewBox="0 0 120 120"
			fill="none"
			stroke-width="2.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<g class="stroke-ink" transform="rotate(-6 56 58)">
				<rect x="26" y="16" width="58" height="80" rx="4" />
				{[26, 36, 46, 56, 66, 76, 86].map((y) => (
					<circle cx="26" cy={y} r="3.5" />
				))}
				<line x1="46" y1="38" x2="46" y2="60" />
				<line x1="53" y1="38" x2="53" y2="60" />
				<line x1="60" y1="38" x2="60" y2="60" />
				<line x1="67" y1="38" x2="67" y2="60" />
				<line x1="41" y1="56" x2="72" y2="42" />
			</g>
			{/* Filled with paper so the notebook behind the pencil is hidden, not seen through it. */}
			<g class="stroke-accent fill-paper">
				<path d="M96 26 L106 30 L88 96 L78 92 Z" />
				<path d="M78 92 L88 96 L80 106 Z" />
				<line x1="94" y1="33" x2="104" y2="37" />
				<line x1="104" y1="16" x2="110" y2="8" />
				<line x1="96" y1="12" x2="98" y2="4" />
			</g>
		</svg>
	);
}
