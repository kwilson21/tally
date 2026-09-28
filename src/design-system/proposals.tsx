// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.

import { AccountsTop } from "../views/accounts-top";
import { Button } from "../views/button";
import { PhoneFrame, Specimen } from "./specimen";

// What the owner decided on 2026-09-26 and 2026-09-28 (decisions 46, 48, 50 and 54), and the issue each ships in.
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
	{
		title: "P8 · Empty lists",
		outcome:
			"Option B: a small drawing, one sentence and a hint, and at most one button, centred (decision 54).",
		issue: 82,
	},
] as const;

/**
 * P9's drawing, a prototype: the empty-list notebook page (decision 54) with an add sign in the
 * accent, for an empty that has one thing to do rather than nothing or no results.
 */
function AddDrawing() {
	return (
		<svg
			class="size-16 shrink-0"
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
			<g class="stroke-accent fill-paper">
				<circle cx="45" cy="44" r="10" />
				<line x1="45" y1="39" x2="45" y2="49" />
				<line x1="40" y1="44" x2="50" y2="44" />
			</g>
		</svg>
	);
}

const NO_BANKS = "No banks linked yet.";

/** Option A: today's top ($0 and the ruled chart space), then the drawing where the banks go, then Link a bank. */
function NoBanksA() {
	return (
		<>
			<AccountsTop netWorthCents={0} />
			<div class="mt-6 flex flex-col items-center text-center">
				<AddDrawing />
				<p class="mt-3 text-lg">{NO_BANKS}</p>
				<p class="mt-1 max-w-xs text-muted">
					Link one and its accounts and balances appear here.
				</p>
			</div>
			<Button type="button" class="mt-8">
				Link a bank
			</Button>
		</>
	);
}

/** Option B: no $0 headline until there's something to add up; the drawing, a reassuring hint and the one button. */
function NoBanksB() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Accounts</h1>
			<div class="mt-16 flex flex-col items-center text-center">
				<AddDrawing />
				<p class="mt-3 text-lg">{NO_BANKS}</p>
				<p class="mt-1 max-w-xs text-muted">
					Link your bank to see balances and net worth here. Tally can only read
					them; it can't move money.
				</p>
				<div class="mt-6">
					<Button type="button">Link a bank</Button>
				</div>
			</div>
		</>
	);
}

/** Option C: today's shape, tidied: $0, a muted sentence where the banks go, and Link a bank. No drawing. */
function NoBanksC() {
	return (
		<>
			<AccountsTop netWorthCents={0} />
			<p class="mt-8 text-lg">{NO_BANKS}</p>
			<p class="text-muted">Link one to see its accounts here.</p>
			<Button type="button" class="mt-6">
				Link a bank
			</Button>
		</>
	);
}

const NO_BANKS_OPTIONS = [
	{
		letter: "A",
		name: "Option A · A drawing under net worth",
		note: "Keeps the screen's shape from day one: $0 and the space for the chart, then decision 54's drawing and sentence where the banks will go. Link a bank stays where it always is.",
		label:
			"Accounts with no bank linked, option A: the title, net worth $0 over the ruled space for the chart, then a notebook drawing with an add sign, the words No banks linked yet, a hint, and the Link a bank button.",
		render: NoBanksA,
	},
	{
		letter: "B",
		name: "Option B · Lead with the action",
		note: "Leaves out a $0 that means nothing yet. The drawing, a hint that says Tally only reads, and Link a bank sit together in the middle, so the one thing to do is the only thing on screen.",
		label:
			"Accounts with no bank linked, option B: the title, then in the middle a notebook drawing with an add sign, the words No banks linked yet, a hint that Tally can only read balances and can't move money, and the Link a bank button.",
		render: NoBanksB,
	},
	{
		letter: "C",
		name: "Option C · A quiet line",
		note: "Today's page, tidied: $0 and the chart space, then a plain sentence and hint, then Link a bank. The lightest; it has no drawing, so it breaks from decision 54's empty state.",
		label:
			"Accounts with no bank linked, option C: the title, net worth $0 over the ruled space for the chart, the words No banks linked yet and a one-line hint, then the Link a bank button.",
		render: NoBanksC,
	},
] as const;

/** P9: what Accounts shows before the family links a bank, as three phone screens side by side. */
function NoBanksProposal() {
	return (
		<Specimen
			id="p9-no-banks"
			title="P9 · Accounts before any bank is linked"
			tier="visual"
			sentence="Before a bank is linked, Accounts says only “No banks linked yet.” Neither empty-list drawing fits (they mean “no results” and “nothing to do”), so pick how this first screen should look. Each option is a phone's first screen."
		>
			<div class="flex flex-wrap gap-8">
				{NO_BANKS_OPTIONS.map((o) => (
					<div class="max-w-[392px]">
						<h4 class="font-semibold">{o.name}</h4>
						<p class="mt-1 min-h-24 text-sm text-muted">{o.note}</p>
						<div class="mt-3">
							<PhoneFrame label={o.label}>
								<o.render />
							</PhoneFrame>
						</div>
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
				<NoBanksProposal />
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
