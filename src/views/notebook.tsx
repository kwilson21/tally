// The first week's notebook (P125 E, decision 114): the ledger notebook with its tally strokes, beside a terracotta
// pencil. It is decoration: setup's welcome draws none, setup's finish all five, the proposals' drawings what they need.
// It is the one drawing of the notebook: setup's welcome and finish and the proposals' SmallNotebook
// (proposal-parts.tsx) draw it from here (proposals-polish-5.tsx passes its own stroke classes through lineClass; SmallNotebook
// no longer does), and LedgerIllustration (illustration.tsx) is it with all five strokes in ink, so the drawing can't drift.
// Decorative: the step bar or the setup's words beside it say the same in words.

/** The five strokes in order: four short verticals, then the slash. Stroke n is drawn after stroke n - 1. */
export const NOTEBOOK_STROKES = [
	[46, 38, 46, 60],
	[53, 38, 53, 60],
	[60, 38, 60, 60],
	[67, 38, 67, 60],
	[41, 56, 72, 42],
] as const;

/**
 * The notebook with its first `strokes` strokes drawn (0 to 5), beside a terracotta pencil. Drawn strokes are in pencil
 * (muted) unless `ink`; `lineClass` replaces the stroke class per line (the proposals' replays use it).
 */
export function Notebook({
	strokes,
	ink = false,
	size = "size-32",
	lineClass,
}: {
	strokes: number;
	ink?: boolean;
	/** The notebook's box, a Tailwind size class (and any shrink or breakpoint class). */
	size?: string;
	lineClass?: (line: number) => string;
}) {
	const strokeClass = (line: number) =>
		lineClass?.(line) ?? (ink ? "stroke-ink" : "stroke-muted");
	return (
		<svg
			class={`${size} shrink-0`}
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
				{NOTEBOOK_STROKES.slice(0, strokes).map(([x1, y1, x2, y2], line) => (
					<line x1={x1} y1={y1} x2={x2} y2={y2} class={strokeClass(line)} />
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
