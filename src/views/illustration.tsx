import { NOTEBOOK_STROKES } from "./notebook";

/** The notebook-and-pencil line drawing beside the headline: ink notebook with tally marks, terracotta pencil. */
export function LedgerIllustration() {
	return (
		<svg
			class="size-28 shrink-0 lg:size-36"
			viewBox="0 0 120 120"
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<g class="stroke-ink" transform="rotate(-6 56 58)">
				<rect x="26" y="16" width="58" height="80" rx="4" />
				{[26, 36, 46, 56, 66, 76, 86].map((y) => (
					<circle cx="26" cy={y} r="3.5" />
				))}
				{NOTEBOOK_STROKES.map(([x1, y1, x2, y2]) => (
					<line x1={x1} y1={y1} x2={x2} y2={y2} />
				))}
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
