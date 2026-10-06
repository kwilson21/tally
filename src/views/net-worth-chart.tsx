import type { NetWorthView } from "../net-worth";
import { WhyLink } from "./why-link";

// Four rules, from where the line's highest point can sit to its lowest, in the chart's 100-high box.
const RULES = [6, 35.3, 64.7, 94];

/** The sentence in the status sentence's voice, with its Why? after it, separated by a dot (decision 65). */
function Sentence({ children }: { children: string }) {
	return (
		<p class="mt-1 flex flex-wrap items-center gap-x-2">
			<span class="font-serif text-lg italic">{children}</span>
			<span aria-hidden="true">·</span>
			<WhyLink section="net-worth" topic="net worth" />
		</p>
	);
}

/**
 * The line under Accounts' headline (P25 A, P31): code writes the change in a sentence, then one
 * server-drawn line through the last 6 months of net worth on the ledger rules, with its first
 * and last day under it. It has no amounts or axis; the headline and the sentence carry them.
 * With fewer than two days of balances it shows the empty rules and says when the chart starts.
 * No script: the picture is an SVG with a text alternative in numbers.
 */
export function NetWorthChart({ view }: { view: NetWorthView }) {
	if (view.kind === "early") {
		return (
			<>
				{view.sentence && <Sentence>{view.sentence}</Sentence>}
				{/* Paper's own rules, like a ledger page waiting for its line. */}
				<div
					data-chart="early"
					aria-hidden="true"
					class="mt-6 flex h-20 flex-col justify-between lg:h-32"
				>
					<div class="border-t border-rule" />
					<div class="border-t border-rule" />
					<div class="border-t border-rule" />
					<div class="border-t border-rule" />
					<div class="border-t border-rule" />
				</div>
				<p class="mt-2 text-sm text-muted">{view.note}</p>
			</>
		);
	}
	return (
		<>
			<Sentence>{view.sentence}</Sentence>
			{/* The box stretches to the page's width; non-scaling strokes keep the lines thin and the dot round. */}
			<svg
				data-chart="line"
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				role="img"
				aria-label={view.description}
				fill="none"
				class="mt-4 h-28 w-full overflow-visible lg:h-32"
			>
				{RULES.map((y) => (
					<line
						x1="0"
						x2="100"
						y1={y}
						y2={y}
						stroke-width="1"
						vector-effect="non-scaling-stroke"
						class="stroke-rule"
					/>
				))}
				<polyline
					points={view.points}
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
					class="stroke-ink"
				/>
				{/* A zero-length round-capped stroke is the end dot: it stays a circle however the box stretches. */}
				<path
					d={`M${view.end.x} ${view.end.y}h0.01`}
					stroke-width="8"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
					class="stroke-ink"
				/>
			</svg>
			<p
				aria-hidden="true"
				class="mt-1 flex justify-between text-sm text-muted"
			>
				<span>{view.startLabel}</span>
				<span>{view.endLabel}</span>
			</p>
		</>
	);
}
