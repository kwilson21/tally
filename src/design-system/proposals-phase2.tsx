// P14's icon (decision 59): the always-visible Feedback button drawn with each candidate icon on a
// phone's first screen, for the owner to pick by seeing. P10–P13 are decided.

import type { Child } from "hono/jsx";
import { PhoneFrame, Specimen } from "./specimen";

type Option = { name: string; note: string; screen: Child };

/** A proposal's options side by side, each named and noted above its phone. */
function Options({ options }: { options: Option[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{options.map((o) => (
				<div class="flex w-[392px] max-w-full flex-col gap-2">
					<h4 class="font-semibold">{o.name}</h4>
					<p class="min-h-18 text-sm text-muted">{o.note}</p>
					<PhoneFrame label={`${o.name}, on a phone`}>{o.screen}</PhoneFrame>
				</div>
			))}
		</div>
	);
}

function Title({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-4xl font-semibold tracking-tight">{children}</h1>
	);
}

// Two Lucide speech bubbles (ISC License) for the Feedback button, drawn here until one is picked
// and joins src/views/icons.tsx.
const BUBBLES = {
	round: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
	square: (
		<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
	),
};

function Bubble({ shape }: { shape: keyof typeof BUBBLES }) {
	return (
		<svg
			class="size-5"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{BUBBLES[shape]}
		</svg>
	);
}

/** P14: a small button pinned above the tab bar on every page, as in the original app. */
const feedbackCorner = (shape: keyof typeof BUBBLES) => (
	<div class="relative h-[640px]">
		<Title>September</Title>
		<p class="mt-4 text-muted">Safe to spend</p>
		<p class="font-serif text-5xl">$283</p>
		<p class="mt-6 text-muted">The page scrolls under it; it never moves.</p>
		<span class="absolute right-0 bottom-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-paper px-4 text-ink">
			<Bubble shape={shape} />
			Feedback
		</span>
	</div>
);

/** The one open proposal: P14's icon. P10–P13 and the rest of P14 are decided (decision 59). */
export function Phase2Proposals() {
	return (
		<Specimen
			id="p14-feedback"
			title="P14 · Send feedback"
			tier="visual"
			sentence="Always visible, and the button and form are signed off (decision 59). Pick its icon."
		>
			<Options
				options={[
					{
						name: "Icon A · Round bubble",
						note: "A conversation: friendly and familiar.",
						screen: feedbackCorner("round"),
					},
					{
						name: "Icon B · Square bubble",
						note: "A message: a little more like a note to the builder.",
						screen: feedbackCorner("square"),
					},
				]}
			/>
		</Specimen>
	);
}
