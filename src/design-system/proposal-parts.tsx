// Shared pieces of the proposals page: each option drawn as a named picture of a screen, so the
// owner decides by seeing (decision 47). Every proposal file draws with these.

import type { Child } from "hono/jsx";
import { Icon } from "../views/icons";
import { Notebook } from "../views/notebook";
import { PhoneFrame } from "./specimen";

export type Option = {
	name: string;
	/** What it is, in one plain line. */
	note: string;
	/** What it costs, in one line. */
	tradeoff?: string;
	/** Why it's the recommended one, in one line. */
	recommended?: string;
	/** The owner picked this one (decisions 72–80). */
	picked?: boolean;
	/** Drawn at desktop width instead of on a phone. */
	desktop?: boolean;
	/** Drawn as the family app, without the demo banner. */
	family?: boolean;
	/** Drawn on a taller phone screen (880px, not 790px), for a group that doesn't fit in 790. */
	tall?: boolean;
	screen: Child;
};

/** The owner's pick, beside an option's name: the same pill on every proposal that has one. */
export function PickedPill() {
	return (
		<span class="inline-flex items-center gap-1 rounded-full bg-band px-2.5 py-0.5 text-sm font-medium">
			<Icon name="check" class="size-4" />
			Picked
		</span>
	);
}

/**
 * A proposal's options side by side, each named, described and weighed above its picture. The
 * picture sits in a `data-screen` box, so a test can tell a drawn screen from an empty frame.
 */
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
							{o.picked && <PickedPill />}
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
							<div data-screen="picture">{o.screen}</div>
						</DesktopFrame>
					) : (
						<PhoneFrame
							label={`${o.name}, on a phone`}
							demo={!o.family}
							tall={o.tall}
						>
							<div data-screen="picture">{o.screen}</div>
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
				class="relative h-[560px] w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
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

/**
 * What a later pick replaced in an earlier drawing, in plain words: the decision that replaced
 * the drawing is named (82 unless given), and `by` points down to the drawing that takes its place.
 */
export function Replaced({
	by,
	decision = 82,
	children,
}: {
	by?: string;
	decision?: number;
	children?: Child;
}) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Replaced by decision {decision}: </span>
			{children}
			{by ? <> See {by}, further down.</> : null}
		</p>
	);
}

/**
 * On a new pick (decision 82): what it replaces in an earlier drawing, in plain words. The earlier
 * drawing carries the matching `Replaced` note, which points down to the new one.
 */
export function Replaces({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Replaces: </span>
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
	top = "top-64",
	children,
}: {
	behind?: Child;
	/** Where the sheet's top edge sits, as a Tailwind class, for a sheet with more to hold. */
	top?: string;
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[686px] overflow-hidden">
			<div class="px-5">{behind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div
				class={`absolute inset-x-0 bottom-0 ${top} flex flex-col gap-3 overflow-y-auto rounded-t-sheet bg-paper p-5`}
			>
				{children}
			</div>
		</div>
	);
}

/** One line of a ledger: an answer (ink) or what the bank says (muted). */
export type LedgerLine = { text: string; ink?: boolean };

/** The notebook beside a question page's headline, with what it counts in words beside it. */
export function SmallNotebook({
	strokes,
	text,
	size = "size-12",
}: {
	strokes: number;
	text: string;
	size?: string;
}) {
	return (
		<div class="flex items-center gap-2">
			<Notebook strokes={strokes} ink size={size} />
			<p class="text-sm text-muted">{text}</p>
		</div>
	);
}

/**
 * A question page's top (P125 E), as the proposals draw it: "Your first page", the count at the right, and the ledger so far.
 * The ledger is left out while it has no lines. `children` is the question.
 */
export function FirstPage({
	right,
	lines,
	children,
}: {
	right?: Child;
	lines: LedgerLine[];
	children?: Child;
}) {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-lg font-semibold">Your first page</h1>
				{right}
			</div>
			{lines.length > 0 ? (
				<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
					{lines.map((line) => (
						<li class={`py-2 ${line.ink ? "text-ink" : "text-muted"}`}>
							{line.text}
						</li>
					))}
				</ul>
			) : null}
			{children}
		</>
	);
}

// The first week's strokes as a list (P125 E, decision 114), drawn by the proposals pages: each line's glyph is its
// stroke, a short vertical for the first four and a slash for the fifth, in ink when done and dashed muted when not.

/**
 * One line of the list: its name, its note, and whether its stroke is drawn. `reAsk` is the line under step one when a bank
 * linked during setup took the questions back (#714): its own full-width muted line, not the note column's.
 */
export type StepLine = {
	name: string;
	done: boolean;
	note: string;
	reAsk?: string;
};

/** The lines in order: `notes` gives each its note, and the first `done` of them are done. */
export function stepsOf(
	names: readonly string[],
	notes: readonly string[],
	done: number,
): StepLine[] {
	return names.map((name, i) => ({
		name,
		done: i < done,
		note: notes[i] ?? "",
	}));
}

/** The five lines, with "Your first tally · N of 5" over them. */
export function TallySteps({ steps }: { steps: StepLine[] }) {
	const done = steps.filter((s) => s.done).length;
	return (
		<div class="mt-4">
			<p class="text-sm text-muted">Your first tally · {done} of 5</p>
			<ul class="mt-2 border-t border-rule">
				{steps.map((s, i) => (
					<li class="flex min-h-11 flex-wrap items-center gap-3 border-b border-rule">
						<svg
							class="h-6 w-3 shrink-0"
							viewBox="0 0 12 24"
							fill="none"
							stroke-width="2"
							stroke-linecap="round"
							aria-hidden="true"
						>
							{i < 4 ? (
								<line
									x1="6"
									y1="2"
									x2="6"
									y2="22"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							) : (
								<line
									x1="1"
									y1="22"
									x2="11"
									y2="2"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							)}
						</svg>
						<span
							class={`min-w-0 flex-1 py-2 text-base ${s.done ? "text-ink" : "text-muted"}`}
						>
							{s.name}
							{s.done && <span class="sr-only">, done</span>}
						</span>
						<span class="shrink-0 text-sm text-muted">{s.note}</span>
						{s.reAsk && (
							<p class="basis-full pb-2 text-sm text-muted">{s.reAsk}</p>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
