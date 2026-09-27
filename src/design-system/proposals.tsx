// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.
import { Button } from "../views/button";
import { Specimen } from "./specimen";

// What the owner decided on 2026-09-26 (decisions 46, 48 and 50), and the issue each ships in.
export const DECIDED = [
	{
		title: "P1 · The number on a phone's first screen",
		outcome:
			"Take it. Things to try moves off the first screen; onboarding becomes its own initiative.",
		issue: 92,
	},
	{ title: "P2 · Tidied bank names", outcome: "Take it.", issue: 93 },
	{
		title: "P3 · The money input's ±$1 buttons",
		outcome: "Keep today's round buttons.",
		issue: 80,
	},
	{
		title: "P4 · Thinner budget bars",
		outcome: "Take the 4px bar, without the black limit line.",
		issue: 86,
	},
	{
		title: "P5 · Showing the budget on a thin bar",
		outcome:
			"Option A: no marker. Over budget, the bar is full and brick, and the alert icon and words say by how much.",
		issue: 86,
	},
	{
		title: "P6 · Nudge buttons on Home's budget rows",
		outcome:
			"Option C: an Adjust mode shows − and + on every row until Done, each tap moving the budget to the next round $10 (decision 48).",
		issue: 94,
	},
	{
		title: "P7 · The Band and the Uncategorized row say one thing twice",
		outcome:
			"Option A: the Band carries the amount on a quiet second line, and the Uncategorized row goes (decision 50).",
		issue: 92,
	},
] as const;

type EmptyCase = {
	kind: "search" | "done";
	sentence: string;
	hint?: string;
	action?: string;
};

// P8's two cases: a filter with no results (one thing to do), and a good empty (nothing to do).
const EMPTY_CASES: EmptyCase[] = [
	{
		kind: "search",
		sentence: "No transactions match these filters.",
		hint: "Try a wider month, or clear the search.",
		action: "Clear filters",
	},
	{
		kind: "done",
		sentence: "Every transaction has a category.",
		hint: "New ones appear here after the next sync.",
	},
];

/** A small line drawing in the ledger illustration's style: a notebook page, and a magnifier or a tick. */
function EmptyDrawing({
	kind,
	size = "size-16",
}: {
	kind: EmptyCase["kind"];
	size?: string;
}) {
	return (
		<svg
			class={`${size} shrink-0`}
			viewBox="0 0 64 64"
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<g class="stroke-ink">
				<rect x="12" y="8" width="34" height="46" rx="3" />
				<line x1="19" y1="20" x2="39" y2="20" />
				<line x1="19" y1="28" x2="39" y2="28" />
				<line x1="19" y1="36" x2="31" y2="36" />
			</g>
			{kind === "search" ? (
				<g class="stroke-accent fill-paper">
					<circle cx="44" cy="42" r="9" />
					<line x1="50.5" y1="48.5" x2="57" y2="55" />
				</g>
			) : (
				<path class="stroke-accent" d="M36 44 L42 50 L55 35" />
			)}
		</svg>
	);
}

/** Option A: a quiet line where the list would be; the action is a text link. */
function EmptyA({ c }: { c: EmptyCase }) {
	return (
		<p class="py-6 text-muted">
			{c.sentence}
			{c.action && (
				<>
					{" "}
					<a href="#p8-empty" class="inline-flex min-h-11 items-center">
						{c.action}
					</a>
				</>
			)}
		</p>
	);
}

/** Option B: a small drawing, one sentence and a hint, and at most one button, centred. */
function EmptyB({ c }: { c: EmptyCase }) {
	return (
		<div class="flex flex-col items-center py-8 text-center">
			<EmptyDrawing kind={c.kind} />
			<p class="mt-3 text-lg">{c.sentence}</p>
			{c.hint && <p class="mt-1 max-w-xs text-muted">{c.hint}</p>}
			{c.action && (
				<div class="mt-4">
					<Button kind="secondary" href="#p8-empty">
						{c.action}
					</Button>
				</div>
			)}
		</div>
	);
}

/** Option C: a ruled row like the list's own rows: small drawing, sentence and hint, action at the end. */
function EmptyC({ c }: { c: EmptyCase }) {
	return (
		<div class="flex items-center gap-4 border-b border-rule py-4">
			<EmptyDrawing kind={c.kind} size="size-10" />
			<div class="min-w-0 flex-1">
				<p>{c.sentence}</p>
				{c.hint && <p class="text-sm text-muted">{c.hint}</p>}
			</div>
			{c.action && (
				<a href="#p8-empty" class="inline-flex min-h-11 shrink-0 items-center">
					{c.action}
				</a>
			)}
		</div>
	);
}

const EMPTY_OPTIONS = [
	{
		name: "Option A · A quiet line",
		note: "Today's pattern, tidied: the sentence sits where the list would be, and the action is a link. Nothing new to learn; it can read as unfinished.",
		render: EmptyA,
	},
	{
		name: "Option B · Drawing, sentence, one action",
		note: "The original app's empty state in Tally's line style: calm and finished, with the one thing to do as a button. It takes the most room.",
		render: EmptyB,
	},
	{
		name: "Option C · A ruled row",
		note: "Sits in the list like one of its rows, with a small drawing and the action at the end. Lighter than B; the action is quieter.",
		render: EmptyC,
	},
] as const;

/** P8: the three empty-list options, each showing both cases on the paper they'd sit on. */
function EmptyListsProposal() {
	return (
		<Specimen
			id="p8-empty"
			title="P8 · Empty lists"
			tier="visual"
			sentence="An empty list today is a blank space or a muted line. Pick how an empty list should look: each option shows a filter with no results (one thing to do) and a good empty (nothing to do)."
		>
			{/* Stacked at the list's own width (Transactions is max-w-3xl), each case under a rule as a list would be. */}
			<div class="mt-6 flex flex-col gap-10 lg:max-w-3xl">
				{EMPTY_OPTIONS.map((o) => (
					<div>
						<h4 class="font-semibold">{o.name}</h4>
						<p class="mt-1 max-w-prose text-sm text-muted">{o.note}</p>
						{EMPTY_CASES.map((c) => (
							<div class="mt-4 border-t border-rule">
								<o.render c={c} />
							</div>
						))}
					</div>
				))}
			</div>
		</Specimen>
	);
}

/** The proposals page body. */
export function Proposals() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Proposals
			</h1>
			<p class="mt-3 max-w-prose text-lg">
				Each open proposal next to its alternatives, to decide by seeing. Look
				at it on your phone as well as a wide screen.
			</p>
			<p class="mt-2">
				<a href="/design-system" class="inline-flex min-h-11 items-center">
					Back to the design system
				</a>
			</p>

			<section aria-labelledby="open-title" class="mt-10">
				<h2 id="open-title" class="font-serif text-3xl font-semibold">
					Open
				</h2>
				<EmptyListsProposal />
			</section>

			<section aria-labelledby="decided-title" class="mt-12">
				<h2 id="decided-title" class="font-serif text-3xl font-semibold">
					Decided
				</h2>
				<ul class="mt-3 divide-y divide-rule">
					{DECIDED.map((d) => (
						<li class="py-3">
							<p class="font-medium">{d.title}</p>
							<p class="text-muted">
								{d.outcome} Ships in{" "}
								<a
									href={`https://github.com/kwilson21/tally/issues/${d.issue}`}
									class="inline-flex min-h-11 items-center"
								>
									#{d.issue}
								</a>
								.
							</p>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
