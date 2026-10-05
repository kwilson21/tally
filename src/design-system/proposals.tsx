// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.

import { AiProposals } from "./proposals-ai";
import { Phase35Proposals } from "./proposals-phase35";
import { Phase35StatesProposals } from "./proposals-phase35-states";
import { Phase4Proposals } from "./proposals-phase4";
import { Phase5BillsProposals } from "./proposals-phase5-bills";
import { Phase5HomeProposals } from "./proposals-phase5-home";
import { Phase5PlansProposals } from "./proposals-phase5-plans";
import { Phase5TransactionsProposals } from "./proposals-phase5-transactions";

// What the owner decided on 2026-09-26, 2026-09-28 and 2026-09-29 (decisions 46, 48, 50, 54, 55, 59
// and 60), and the issue each ships in.
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
	{
		title: "P9 · Accounts before any bank is linked",
		outcome:
			"Option B: no $0 headline yet; the drawing with an add sign, one sentence, a hint that Tally only reads, and Link a bank, centred (decision 55).",
		issue: 82,
	},
	{
		title: "P10 · Organize",
		outcome:
			"Option B: one group at a time, largest first, with its category, an optional rename, and Save and next (decision 59).",
		issue: 130,
	},
	{
		title: "P11 · Disconnect a bank",
		outcome:
			"Option B: behind Manage under each bank, then a confirm step that keeps history unless told to delete (decisions 58 and 59).",
		issue: 131,
	},
	{
		title: "P12 · Sync now",
		outcome:
			"Option A: a Sync now button under the Accounts title, and each bank says when it last synced (decision 59).",
		issue: 132,
	},
	{
		title: "P13 · Download your data",
		outcome:
			"As drawn: a Your data section at the end of Settings with two downloads, transactions as CSV and everything as JSON (decision 59).",
		issue: 133,
	},
	{
		title: "P14 · Send feedback",
		outcome:
			"Always visible: a small Feedback button with a round speech bubble, pinned above the tab bar on every page, opening a form with a type, how it feels and a message (decision 59).",
		issue: 136,
	},
	{
		title: "P15 · The Bills screen",
		outcome:
			"Option A: grouped by status, with Add a bill opening the form in a sheet (decision 60).",
		issue: 25,
	},
	{
		title: "P16 · A bill's payments",
		outcome:
			"Option A: a bill has its own page, with each month and the payment linked to it (decision 60).",
		issue: 26,
	},
	{
		title: "P17 · Split a transaction",
		outcome: "Option A: parts with what's left to assign (decision 60).",
		issue: 28,
	},
	{
		title: "P18 · Find bills from repeat charges",
		outcome:
			"Option A with Banner 1: a stronger Band, then a review list (decision 60).",
		issue: 156,
	},
	{
		title: "P19 · Link a refund to its purchase",
		outcome: "Option A: from the refund (decision 60).",
		issue: 157,
	},
	{
		title: "P20 · Select several transactions",
		outcome: "Option A: a Select button (decision 60).",
		issue: 158,
	},
	{
		title: "P21 · Add cash spending",
		outcome: "Option A: Add cash on Transactions (decision 60).",
		issue: 159,
	},
	{
		title: "P22 · Count a payment in its bill's month",
		outcome:
			"Option A: the month is chosen when linking, from the bill (decision 60).",
		issue: 26,
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

			<section aria-labelledby="trust-title" class="mt-10">
				<h2 id="trust-title" class="font-serif text-3xl font-semibold">
					Open: numbers you can trust (Phase 3.5)
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The fixes that keep Safe to spend honest (spec §8.5, decision 67).
					Each needs a pick before it's built.
				</p>
				<Phase35Proposals />
				<Phase35StatesProposals />
			</section>

			<section aria-labelledby="ai-title" class="mt-12">
				<h2 id="ai-title" class="font-serif text-3xl font-semibold">
					Open: AI that earns its place
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Every AI feature can be switched off, and Tally shows plainly what it
					did (spec §8.6, decision 68).
				</p>
				<AiProposals />
			</section>

			<section aria-labelledby="phase5-title" class="mt-12">
				<h2 id="phase5-title" class="font-serif text-3xl font-semibold">
					Open: from the original app (Phase 5)
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The original app's features and the review's gaps placed in Phase 5
					(spec §8.4, decisions 66 and 67).
				</p>
				<Phase5HomeProposals />
				<Phase5PlansProposals />
				<Phase5BillsProposals />
				<Phase5TransactionsProposals />
			</section>

			<section aria-labelledby="open-title" class="mt-12">
				<h2 id="open-title" class="font-serif text-3xl font-semibold">
					Picked, to build in Phase 4
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The owner picked the Recommended option of each, and P31 as drawn
					(decisions 64 and 65). The drawings stay here as the build reference
					until each ships.
				</p>
				<Phase4Proposals />
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
