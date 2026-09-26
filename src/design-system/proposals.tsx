// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.
import type { Child } from "hono/jsx";
import { Band } from "../views/band";
import { Icon } from "../views/icons";
import { ProgressRow } from "../views/progress-row";
import { HOME_ROWS } from "./mock";
import { Specimen } from "./specimen";

const NEEDS = "12 transactions need a category";
const NEEDS_HREF = "/transactions?uncategorized=1";
// The last budget row, so each version shows where the Uncategorized row sits.
const LAST_ROW = HOME_ROWS[HOME_ROWS.length - 1];

/** One version of a proposal, at a phone's width, with its name above it. */
function Version({ name, children }: { name: string; children?: Child }) {
	return (
		<div class="flex w-full max-w-sm min-w-0 flex-col gap-3">
			<p class="text-sm font-semibold uppercase tracking-wide text-muted">
				{name}
			</p>
			{children}
		</div>
	);
}

/** Home's Uncategorized row as src/routes/home.tsx draws it today. */
function UncategorizedToday() {
	return (
		<li class="flex items-center gap-4 py-3 text-muted">
			<Icon name="circle-dashed" class="size-7 shrink-0" />
			<span class="flex-1 text-lg">Uncategorized</span>
			<span class="text-lg">$228</span>
		</li>
	);
}

/** B: the Uncategorized row as the link, with the count in words under its name. */
function UncategorizedLink() {
	return (
		<li>
			<a
				href={NEEDS_HREF}
				class="flex min-h-11 items-center gap-4 py-3 text-ink no-underline"
			>
				<Icon name="circle-dashed" class="size-7 shrink-0 text-muted" />
				<span class="min-w-0 flex-1">
					<span class="block text-lg">Uncategorized</span>
					<span class="block text-accent">{NEEDS}</span>
				</span>
				<span class="text-lg">$228</span>
				<Icon name="chevron-right" />
			</a>
		</li>
	);
}

/** A: the Band with the amount on a quiet second line, so the words fit a phone on one line. */
function BandWithAmount() {
	return (
		<a
			href={NEEDS_HREF}
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-ink no-underline"
		>
			<span class="min-w-0">
				<span class="block text-lg">{NEEDS}</span>
				<span class="block text-muted">$228 of this month's spending</span>
			</span>
			<Icon name="chevron-right" />
		</a>
	);
}

/** The Band and the end of the Budget list, with or without the Uncategorized row. */
function BandAndList({ band, last }: { band?: Child; last?: Child }) {
	return (
		<div>
			{band}
			<p class="mt-6 font-serif text-3xl font-semibold">Budget</p>
			<ul class="mt-2 divide-y divide-rule">
				{LAST_ROW && <ProgressRow {...LAST_ROW} />}
				{last}
			</ul>
		</div>
	);
}

// What the owner decided on 2026-09-26 (decisions 46 and 48), and the issue each ships in.
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
] as const;

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
				<Specimen
					id="p7"
					title="P7 · The Band and the Uncategorized row say one thing twice (H8)"
					tier="visual"
					sentence="Home's Band says “12 transactions need a category”, and the last budget row says “Uncategorized $228” with nowhere to go. A sign appears once (DESIGN.md), so #92 keeps one. A: the Band carries the amount on a quiet second line, and the row goes. B: the row becomes the link, and the Band goes. Recommended: A, because the Band is Home's one next action."
				>
					<div class="flex flex-wrap gap-8">
						<Version name="Today">
							<BandAndList
								band={<Band href={NEEDS_HREF}>{NEEDS}</Band>}
								last={<UncategorizedToday />}
							/>
						</Version>
						<Version name="A · The Band carries the amount">
							<BandAndList band={<BandWithAmount />} />
						</Version>
						<Version name="B · The row is the link">
							<BandAndList last={<UncategorizedLink />} />
						</Version>
					</div>
				</Specimen>
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
