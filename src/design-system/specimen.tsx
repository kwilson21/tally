import type { Child } from "hono/jsx";
import { Wordmark } from "../views/brand";

export type Tier = "visual" | "interactive" | "flow";

// Each tier's pill says its name; the word carries the meaning, not the style.
const PILL: Record<Tier, [string, string]> = {
	visual: ["Visual", "border border-rule text-muted"],
	interactive: ["Interactive", "bg-band text-ink"],
	flow: ["Flow", "border border-ink text-ink"],
};

/** A tier's name as a small pill. */
export function TierPill({ tier }: { tier: Tier }) {
	const [label, look] = PILL[tier];
	return (
		<span class={`rounded-full px-2.5 py-0.5 text-sm font-medium ${look}`}>
			{label}
		</span>
	);
}

type SpecimenProps = {
	id: string;
	title: string;
	/** DESIGN.md's one sentence for it. */
	sentence: string;
	tier: Tier;
	/** The DESIGN.md component names it shows (test/design-system-route.test.ts checks every one is shown). */
	components?: string[];
	children?: Child;
};

/**
 * One catalog entry: its name, tier and sentence, then its states. A Visual one is inert to htmx
 * (`hx-ignore`, htmx 4's name for it), so nothing inside it can make a request.
 */
export function Specimen({
	id,
	title,
	sentence,
	tier,
	components = [],
	children,
}: SpecimenProps) {
	return (
		<section
			id={id}
			aria-labelledby={`${id}-title`}
			data-ds-tier={tier}
			data-ds-components={components.join(" ")}
			hx-ignore={tier === "visual" ? "" : undefined}
			class="border-t border-rule py-8"
		>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<h3 id={`${id}-title`} class="text-xl font-semibold">
					{title}
				</h3>
				<TierPill tier={tier} />
			</div>
			<p class="mt-1 max-w-prose text-muted">{sentence}</p>
			<div class="mt-5 flex flex-col gap-6">{children}</div>
		</section>
	);
}

/** One state of a component, with a short label above it. */
export function State({
	label,
	children,
}: {
	label: string;
	children?: Child;
}) {
	return (
		<div class="flex flex-col gap-2">
			<p class="text-sm font-medium text-muted">{label}</p>
			<div>{children}</div>
		</div>
	);
}

/** DESIGN.md's eight questions for an interactive component, in order. */
export const USE_SPEC_PARTS = [
	["purpose", "Purpose"],
	["affordance", "Affordance"],
	["states", "States"],
	["feedback", "Feedback"],
	["input", "Input"],
	["motion", "Motion"],
	["edges", "Edge cases"],
	["words", "Words"],
] as const;

export type UseSpecText = Record<(typeof USE_SPEC_PARTS)[number][0], Child>;

/** A component's use spec (DESIGN.md, "Use"): all eight answers, shown next to it for sign-off. */
export function UseSpec({ spec }: { spec: UseSpecText }) {
	return (
		<div class="max-w-prose">
			<p class="text-sm font-medium text-muted">How it's used</p>
			<dl class="mt-2 divide-y divide-rule border-y border-rule">
				{USE_SPEC_PARTS.map(([key, label]) => (
					<div class="py-3 sm:grid sm:grid-cols-[8rem_1fr] sm:gap-4">
						<dt class="font-medium">{label}</dt>
						<dd class="mt-1 sm:mt-0">{spec[key]}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/**
 * A phone's first screen: 390 wide inside its 1px border and 788 tall, which is 844 minus the 56px
 * tab bar. What's below its edge is what a person scrolls to see. On a narrower screen it scrolls
 * sideways in its column rather than shrinking, so the text wraps exactly as on a real phone.
 */
export function PhoneFrame({
	label,
	children,
}: {
	label: string;
	children?: Child;
}) {
	// A picture of a screen, not a working one: one labelled image with nothing inside to Tab to.
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={label}
				class="h-[790px] w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<p class="bg-band py-2 text-center text-sm text-muted">
						Demo data. Nothing here is real.
					</p>
					<div class="px-5 pt-6">
						<div class="mb-4">
							<Wordmark />
						</div>
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}
