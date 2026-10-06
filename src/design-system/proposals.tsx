// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.

import { AiProposals } from "./proposals-ai";
import { AutofillProposals } from "./proposals-autofill";
import { P75 } from "./proposals-corners";
import { DetailsProposals } from "./proposals-details";
import { FollowupProposals } from "./proposals-followups";
import { FormsProposals } from "./proposals-forms";
import { MixedStoreProposals } from "./proposals-mixed";
import { Phase4Proposals } from "./proposals-phase4";
import { Phase5BillsProposals } from "./proposals-phase5-bills";
import { Phase5HomeProposals } from "./proposals-phase5-home";
import { Phase5PlansProposals } from "./proposals-phase5-plans";
import { Phase5TransactionsProposals } from "./proposals-phase5-transactions";
import { Phase35Proposals } from "./proposals-phase35";
import { Phase35StatesProposals } from "./proposals-phase35-states";
import { RulesProposals } from "./proposals-rules";

// What the owner decided on 2026-09-26, 2026-09-28 and 2026-09-29 (decisions 46, 48, 50, 54, 55, 59
// and 60), and the issue each ships in.
export const DECIDED: readonly {
	title: string;
	outcome: string;
	issue?: number;
}[] = [
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
	{
		title: "P34 · The Pending marker",
		outcome:
			"Option A: “Pending” in the row's caption line, and a line in the panel saying its amount can still change (decision 72).",
		issue: 179,
	},
	{
		title: "P35 · The household's time zone",
		outcome:
			"Option A: a “Time zone · Eastern” disclosure row under a Household heading in Settings (decision 72).",
		issue: 174,
	},
	{
		title: "P36 · “Price changed? Update the bill”",
		outcome:
			"Option B: the bill's row on Bills says “Price changed?” with the payment, and the bill's page offers the update (decision 72).",
		issue: 180,
	},
	{
		title: "P37 · A bank that stopped syncing, on Home",
		outcome:
			"Option A: a line with the alert icon under the status sentence, linking to Accounts; the Band keeps its job (decision 72).",
		issue: 184,
	},
	{
		title: "P38 · A failed save",
		outcome:
			"Option A: an error toast with the alert icon; the sheet stays open with what was typed (decision 72).",
		issue: 183,
	},
	{
		title: "P39 · The app's own 404 and 500 pages",
		outcome:
			"Option C: the ledger drawing with a serif 404 (or 500) and a sentence (decision 72).",
		issue: 183,
	},
	{
		title: "P40 · The first visit's empty Transactions list",
		outcome:
			"Option A: EmptyState for “Link a bank to see transactions” and for “Importing your transactions…” (decision 72).",
		issue: 185,
	},
	{
		title: "P45 · Confirming a bill amount over $100,000",
		outcome:
			"Option A: an alert line and a “Yes, $150,000.00 is right” chip to tick before Save (decision 72).",
		issue: 182,
	},
	{
		title: "P41 · The AI suggestions switches in Settings",
		outcome:
			"Option B: switches with On or Off beside each, and one Save under the group (decision 73).",
		issue: 191,
	},
	{
		title: "P42 · One review screen for every “Maybe …”",
		outcome:
			"Option A: each suggestion asked as a yes-or-no question, one at a time (decision 73).",
	},
	{
		title: "P43 · What AI did this month",
		outcome:
			"Option A: an “In October” tally under the switches, with a Why? link (decision 73).",
	},
	{
		title: "P44 · See it without AI",
		outcome:
			"Option A: two links under the Transactions title, “Tidied by Tally · Straight from the bank” (decisions 73 and 79).",
	},
	{
		title: "P46–P53 · Home",
		outcome:
			"Option A of each (decision 74): arrows by the month for past months; “Over budget this month”; Why? beside Safe to spend; “$14 left” when nearly spent; a daily amount under the sentence; what each unbudgeted category spent; older uncategorized on the Band; a link to a category's transactions in its budget sheet.",
	},
	{
		title: "P54–P56 · Savings, planned expenses, the reconnect email",
		outcome:
			"A savings goal as a line in Home's budget, set aside in full from the 1st (R1); planned one-time expenses on Bills; the reconnect email with a little detail (B), to the whole family, once and then every 3 days (decision 74).",
	},
	{
		title: "P57–P61 · Bills",
		outcome:
			"Occurrences one by one, keyed by due date (weekly matched within ±3 days); several payments for one occurrence; a payment takes its bill's category; the monthly total under the title and a total under each group; amount history like budgets (decision 74).",
	},
	{
		title: "P62–P71 · Transactions",
		outcome:
			"A rule offer after the third matching save and every one after (B); an Account filter; a Show choice for type (B); search matches categories and amounts, in every month; a New category chip; rename this one or all; “Always for these merchants” in Settings; Select all in the action bar; a cash entry's date and amount as fields (decision 74).",
	},
	{
		title: "P72 · Forms, rethought",
		outcome:
			"Option A, the quiet ledger form, for every form, with a plain big amount field for bills and cash; budgets keep MoneyInput (decision 75).",
	},
	{
		title: "P73 · A new category with its likely transactions",
		outcome:
			"Option A: right after a new category is made, the panel offers the others that likely belong, each with its reason; same-merchant ones ticked, Tally's guesses not (decision 76).",
	},
	{
		title: "P74 · Motion",
		outcome:
			"Option A: quiet confirmations in CSS only (the switch, the sheet, toasts) and the browser's own cross-fade between pages; B's morphs wait, as they need a script (decision 76).",
	},
	{
		title: "P75 · Squircle corners",
		outcome:
			"Option A: squircle corners on every button, field and the sheet, in CSS only; chips stay pills, and Safari and Firefox keep today's corners until they support it (decision 76).",
	},
	{
		title: "P76 · Where “Maybe income” shows",
		outcome:
			"Option A: “Maybe income” shows on the row, in the panel and on the review screen (decision 80).",
	},
	{
		title: "P77 · A switched-off feature in “What AI did”",
		outcome:
			"Option A: the line stays and says “Off” in muted words (decision 80).",
	},
	{
		title: "P78 · “Part paid” before it's overdue",
		outcome:
			"Option A: “Part paid” stays in the group its due date puts it in (decision 80).",
	},
	{
		title: "P79 · The category from a bill",
		outcome:
			"Option E: a Why? link beside Category explains where it came from (decision 80).",
	},
	{
		title: "P80 · Finding one in “Always for these merchants”",
		outcome:
			"Option A: A–Z, with a search box once there are more than 20 (decision 80).",
	},
	{
		title: "P81 · Select all's words",
		outcome: "Option A: Select all says its count and month (decision 80).",
	},
	{
		title: "P82 · Save in a form with no sheet",
		outcome: "Option A: a form with no sheet ends with Save (decision 80).",
	},
	{
		title: "P83 · An empty “Match payments from”",
		outcome:
			"Option A: an empty “Match payments from” reads “None yet” (decision 80).",
	},
	{
		title: "P84 · The over-$100,000 chip in the quiet Add a bill",
		outcome:
			"Option A: the over-$100,000 chip sits under the amount's alert (decision 80).",
	},
	{
		title: "P85 · Desktop's side panel entering",
		outcome:
			"Option A: desktop's side panel slides in from the right (decision 80).",
	},
	{
		title: "P86 · Clearer words for the AI switches",
		outcome:
			"Option A: the switches read “Suggest store names”, “Guess categories”, “Spot paychecks” and “Sort right away”, each with an example (decision 80).",
	},
	{
		title: "P87 · Where a suggested name comes from",
		outcome:
			"Option B: a name Tally guessed has a sparkles icon before it in the list, and the icon with the words “Tally's guess” in the edit panel and on the review screen, while the bank's own name says “From your bank” (decision 80).",
	},
	{
		title: "P88 · Never-ask-again, as rules you can change",
		outcome:
			"Option A: “Tally's rules” in Settings holds “Always for these merchants” and “Never suggest” together (decision 80).",
	},
	{
		title: "P89 · Tally fills in a transaction's details",
		outcome:
			"Option A: Tally fills in a clean name, what it was, its kind and who it was for, dashed until kept, with a “Fill in details” switch (decision 80).",
	},
	{
		title: "P90 · A store that sells many kinds of things",
		outcome:
			"Option A, combined with B: Tally guesses one category from the trip's details, or suggests a split with the categories filled in and the amounts left to the person (decision 80).",
	},
];

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

			<section aria-labelledby="details-title" class="mt-10">
				<h2 id="details-title" class="font-serif text-3xl font-semibold">
					Picked: details from the issues
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The questions in docs/reviews/open-questions-2026-10-05.md that change
					how a screen looks, drawn to decide by seeing. The owner's answers are
					decision 79; the picks marked Picked are decision 80.
				</p>
				<DetailsProposals />
				<RulesProposals />
				<AutofillProposals />
				<MixedStoreProposals />
			</section>

			<section aria-labelledby="followups-title" class="mt-12">
				<h2 id="followups-title" class="font-serif text-3xl font-semibold">
					Picked: follow-ups
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Follow-ups from the owner's picks and the micro-interaction libraries
					they shared: suggested transactions for a new category (P67), motion,
					and squircle corners. Picks marked (decision 76).
				</p>
				<FollowupProposals />
				<P75 />
			</section>

			<section aria-labelledby="trust-title" class="mt-12">
				<h2 id="trust-title" class="font-serif text-3xl font-semibold">
					Picked, to build in Phase 3.5
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The fixes that keep Safe to spend honest (spec §8.5, decision 67). The
					owner's pick of each is marked Picked (decision 72); the drawings stay
					here as the build reference until each ships.
				</p>
				<Phase35Proposals />
				<Phase35StatesProposals />
			</section>

			<section aria-labelledby="ai-title" class="mt-12">
				<h2 id="ai-title" class="font-serif text-3xl font-semibold">
					Picked: AI that earns its place
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Every AI feature can be switched off, and Tally shows plainly what it
					did (spec §8.6, decision 68). Picks marked (decision 73).
				</p>
				<AiProposals />
			</section>

			<section aria-labelledby="forms-title" class="mt-12">
				<h2 id="forms-title" class="font-serif text-3xl font-semibold">
					Picked: forms
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Add a bill felt crowded (the owner, on P45), so every form gets one
					pattern: the quiet ledger form (decision 75).
				</p>
				<FormsProposals />
			</section>

			<section aria-labelledby="phase5-title" class="mt-12">
				<h2 id="phase5-title" class="font-serif text-3xl font-semibold">
					Picked, to build in Phase 5
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The original app's features and the review's gaps placed in Phase 5
					(spec §8.4, decisions 66 and 67). Picks marked (decision 74).
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
								{d.outcome}
								{d.issue ? (
									<>
										{" "}
										Ships in{" "}
										<a
											href={`https://github.com/kwilson21/tally/issues/${d.issue}`}
											class="inline-flex min-h-11 items-center"
										>
											#{d.issue}
										</a>
										.
									</>
								) : (
									" Its issue is written when it's built."
								)}
							</p>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
