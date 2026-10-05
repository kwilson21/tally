// Shared pieces of the proposals page: each option drawn as a named picture of a screen, so the
// owner decides by seeing (decision 47). Every proposal file draws with these.

import type { Child } from "hono/jsx";
import { Icon } from "../views/icons";
import { PhoneFrame } from "./specimen";

export type Option = {
	name: string;
	/** What it is, in one plain line. */
	note: string;
	/** What it costs, in one line. */
	tradeoff?: string;
	/** Why it's the recommended one, in one line. */
	recommended?: string;
	/** The owner picked this one (decisions 72–75). */
	picked?: boolean;
	/** Drawn at desktop width instead of on a phone. */
	desktop?: boolean;
	/** Drawn as the family app, without the demo banner. */
	family?: boolean;
	screen: Child;
};

/** A proposal's options side by side, each named, described and weighed above its picture. */
export function Options({ options }: { options: Option[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{options.map((o) => (
				<div
					class={`flex ${o.desktop ? "w-[722px]" : "w-[392px]"} max-w-full flex-col gap-2`}
				>
					<div class={`flex flex-col gap-1 ${o.tradeoff ? "lg:min-h-44" : ""}`}>
						<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
							{o.name}
							{o.recommended && (
								<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
									Recommended
								</span>
							)}
							{o.picked && (
								<span class="inline-flex items-center gap-1 rounded-full bg-band px-2.5 py-0.5 text-sm font-medium">
									<Icon name="check" class="size-4" />
									Picked
								</span>
							)}
						</h4>
						<p class="text-sm">{o.note}</p>
						{o.tradeoff && (
							<p class="text-sm text-muted">Trade-off: {o.tradeoff}</p>
						)}
						{o.recommended && (
							<p class="text-sm text-muted">Why: {o.recommended}</p>
						)}
					</div>
					{o.desktop ? (
						<DesktopFrame label={`${o.name}, on desktop`}>
							{o.screen}
						</DesktopFrame>
					) : (
						<PhoneFrame label={`${o.name}, on a phone`} demo={!o.family}>
							{o.screen}
						</PhoneFrame>
					)}
				</div>
			))}
		</div>
	);
}

/** A desktop window's first screen, cropped: a picture, with nothing inside to Tab to. */
export function DesktopFrame({
	label,
	children,
}: {
	label: string;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={label}
				class="h-[560px] w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert class="mx-auto max-w-xl px-8 pt-8">
					{children}
				</div>
			</div>
		</div>
	);
}

/** What the spec and decisions already fix for a proposal, so no option contradicts them. */
export function Fixed({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Already fixed by the spec: </span>
			{children}
		</p>
	);
}

export function Title({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-4xl font-semibold tracking-tight">{children}</h1>
	);
}

/**
 * The BottomSheet as it sits on a phone, drawn in place: the real one is fixed to the viewport, so
 * it can't sit inside a picture. The page behind it shows, dimmed, above its top edge.
 */
export function Sheet({
	behind,
	children,
}: {
	behind?: Child;
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[686px] overflow-hidden">
			<div class="px-5">{behind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div class="absolute inset-x-0 bottom-0 top-64 flex flex-col gap-3 overflow-y-auto rounded-t-sheet bg-paper p-5">
				{children}
			</div>
		</div>
	);
}
