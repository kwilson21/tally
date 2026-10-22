// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here while a proposal is open; an
// accepted one moves into the real component in its own PR, and a decided one leaves this page
// for the Decided list.

import { AiProposals } from "./proposals-ai";
import { AuditRoundTwoPicks } from "./proposals-audit-2";
import { AuditRoundThreeProposals } from "./proposals-audit-3";
import {
	AuditFollowupProposals,
	BanksProposal,
	SplitCategoryProposal,
} from "./proposals-audit-followups";
import { AutofillProposals } from "./proposals-autofill";
import { BillsTotalsProposal } from "./proposals-bills-totals";
import { P75 } from "./proposals-corners";
import { DetailsProposals } from "./proposals-details";
import { FollowupProposals } from "./proposals-followups";
import { FormsProposals } from "./proposals-forms";
import { KeyboardListProposal } from "./proposals-keys";
import { MixedStoreProposals, SplitThisOneProposal } from "./proposals-mixed";
import { MoneyInputProposal } from "./proposals-money";
import { Phase4Proposals } from "./proposals-phase4";
import { Phase5BillsProposals } from "./proposals-phase5-bills";
import { Phase5HomeProposals } from "./proposals-phase5-home";
import { Phase5PicksProposals } from "./proposals-phase5-picks";
import { Phase5PlansProposals } from "./proposals-phase5-plans";
import { Phase5TransactionsProposals } from "./proposals-phase5-transactions";
import { Phase35Proposals } from "./proposals-phase35";
import { Phase35StatesProposals } from "./proposals-phase35-states";
import { PlannedDiagramProposal } from "./proposals-planned-diagram";
import { PolishProposals } from "./proposals-polish";
import { PolishRoundAProposals } from "./proposals-polish-2";
import { PolishRoundBProposals } from "./proposals-polish-3";
import { PolishRoundCProposals } from "./proposals-polish-4";
import { PolishRoundDProposals } from "./proposals-polish-5";
import { RulesProposals } from "./proposals-rules";
import { SafeToSpendSmallProposal } from "./proposals-safe-small";
import { SetupProposal } from "./proposals-setup";

// What the owner decided from 2026-09-26 on (decisions 46 to 148), and the issue each ships in.
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
			"Option A: two links under the Transactions title, “With Tally · Without Tally” (decisions 73, 79 and 103).",
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
			"Tally guesses one category from the trip's details, or suggests a split with the categories filled in and the amounts left to the person (decision 80). Decision 89 and P117 replace the mixed-store count, showing “Split this one?” on every trip, and filling parts with the store's most-used categories.",
		issue: 233,
	},
	{
		title: "P91–P93 · Browse past months",
		outcome:
			"A finished month's number is its budgets minus its spending, with a tilted Under or Over stamp and one small bar per budgeted category against a dashed budget line; ‹ and › by the month name and a strip of month dots; its rows read “spent / budget” and open nothing, and its Not budgeted categories are listed with what each spent (decision 82).",
		issue: 198,
	},
	{
		title: "P94–P97 · Home's top",
		outcome:
			"Safe to spend shows a negative number in brick (“−$40”) with Why? beside the label; the daily amount becomes a forecast chart (“$120 under by Oct 31, at this pace”); a bank that's behind gets an “as of Oct 2” tag and a soft line with a Fix button; the Band reads “12 need a category” with a “+1 older” chip (decision 82).",
		issue: 199,
	},
	{
		title: "P98–P99 · Budget rows and the sheet's link",
		outcome:
			"Refunds that outweigh spending read “+$20” in green with an empty bar; a bar turns amber at 80% or more; a $0 budget with nothing spent shows no warning; the sheet's link is a “12 transactions ›” button, shown only when there are some (decision 82).",
		issue: 200,
	},
	{
		title: "P100 · Taking the savings goal away",
		outcome:
			"Setting the goal to $0 removes it, and it goes back under Not budgeted as “Set a goal”; Adjust's − and + don't change it (decision 82).",
		issue: 201,
	},
	{
		title: "P101–P105 · Planned expenses",
		outcome:
			"A plan has no category; its link picker lists money out from its month and the next, closest amount first; its sheet changes it, deletes it and unlinks a payment; once paid it shows with the paid bills; the Planned group has its own total, outside the monthly total; an unpaid one is asked about one at a time, Move to Nov or Drop (decision 82).",
		issue: 202,
	},
	{
		title: "P106 · Part paid, in a group's total",
		outcome:
			"Each group's heading total counts what's left of a part-paid bill, and the monthly total still counts it in full (decision 82).",
		issue: 207,
	},
	{
		title: "P107–P109 · The reconnect email",
		outcome:
			"One household switch, “Bank sign-in emails”, on to start, to everyone who has signed in within the last 90 days, with each address listed under a plain disclosure with Remove for anyone in the family; sent at the nightly run, then every 3 days until fixed; the email shows the bank, its account endings as chips, the last synced date and one Open Accounts button (decision 82); Resend sends it first, through plain fetch, with Cloudflare's own email as the fallback, and nothing has to be confirmed (decision 86).",
		issue: 203,
	},
	{
		title: "P110 · Documents in the menu",
		outcome:
			"Option A: More and the sidebar leave Documents out until receipts are built, so no menu item leads to a page that isn't built (decision 84).",
		issue: 246,
	},
	{
		title: "P111 · Deleting a cash entry",
		outcome:
			"Option B combined with D: the question “Delete Farmers market, $20.00? This can't be undone.” replaces Cancel and Save, with Delete and Keep it, and once deleted the toast offers Undo for 10 seconds (decision 84). The question is built; only the Undo is still to build.",
		issue: 244,
	},
	{
		title: "P112 · Send feedback in the demo",
		outcome:
			"Option A: in the demo, the box saying feedback is off sits right under the title, before the privacy text (decision 84).",
		issue: 246,
	},
	{
		title: "P113 · A How this works link on Bills",
		outcome:
			"Option A: a How this works link under Bills' status sentence, to the Bills section of How Tally works (decision 84).",
		issue: 246,
	},
	{
		title: "P114 · Deleting a cash entry, once Undo ships",
		outcome:
			"Option A: the sheet asks just the question, “Delete Farmers market, $20.00?”, because “This can't be undone.” would no longer be true once the toast's Undo ships (decision 85).",
		issue: 244,
	},
	{
		title: "P115 · The money box's corners",
		outcome:
			"Option A: the money box and its cent arrows use the 12px corner token, rounded-control, like every input, and become squircles with them (decision 85).",
		issue: 253,
	},
	{
		title: "P116 · A suggested amount in the budget sheet",
		outcome:
			"Option B: a second chip beside Last month, “3-month average”, with the average of what the category spent in the last three finished months, shown once there are three finished months and the average is above $0; a part first month isn't one of them (decision 85).",
		issue: 250,
	},
	{
		title: "P117 · When Split this one? shows",
		outcome:
			"Option A: Jev says when a trip looks mixed, using this household's categories and transaction details; “Split this one?” appears only for that trip, and suggested category parts start dashed with empty amounts (decision 89, pictures 14–16).",
		issue: 233,
	},
	{
		title: "P118 · How a row shows it opens",
		outcome:
			"Option A: every row that opens ends in Settings' small muted arrow; “Needs category” becomes quiet muted words at the start of the caption instead of a filled pill; and a pressed row shows the new press tint (ink at 6%) under the finger and while its sheet loads (decision 111).",
		issue: 497,
	},
	{
		title: "P119 · How the row you just saved shows it changed",
		outcome:
			"Option A: after a save, a hand-drawn pencil tick takes the saved row's arrow's place for as long as the toast stays, then the arrow comes back; only a save's own reply marks a row. This replaces #71's first idea of a band tint fading over 1.5 s (decision 111).",
		issue: 71,
	},
	{
		title: "P120 · What the edit panel leads with",
		outcome:
			"Option B: the edit panel leads with its category: the name is the one headline, the categories come first in two columns when one is needed and fold to one line once it is set, and Exclude and Count as income become switches; the detail rows follow the category, and the panel's own How this works link goes (decision 111, with #84).",
		issue: 498,
	},
	{
		title: "P121 · How much of Transactions' first screen goes to filters",
		outcome:
			"Option A: Transactions' four filters fold behind one Filters pill, with search and Needs category still in view; its How this works link moves to the page's foot with P124 A (decision 111).",
		issue: 84,
	},
	{
		title: "P122 · What More shows",
		outcome:
			"Option A: More becomes a contents page: each place's icon, what it holds, and a live count on a dotted leader (“3 accounts”, “3 to check”, “Needs attention” when a bank needs signing in, “None linked yet” before a bank), with a small colophon (decision 111).",
		issue: 499,
	},
	{
		title: "P123 · Where Feedback lives",
		outcome:
			"Option A: the Feedback pill moves into the top line beside the wordmark on every page (the sidebar on desktop) and scrolls away, so it never covers a row; this replaces decision 59's place above the tab bar (decision 111).",
		issue: 530,
	},
	{
		title: "P124 · What a first visit shows and teaches",
		outcome:
			"Option A, for the demo only: the banner's “Start here” opens How Tally works' new first section, Tally's story in three struck-through bank lines with Tally's rows and the total under a double rule; Things to try leaves Home, each screen's How this works moves to its page's foot, and How it's built moves last (#502) (decision 111). The family's first week is P125 E (#95).",
		issue: 501,
	},
	{
		title: "P125 · A new family's first week",
		outcome:
			"Option E: until setup is done, Home names the notebook's five strokes (link your bank, your pay, your bills, your budgets, and Tally's first night on its own) and the next morning asks three things one at a time from the family's own bank, each answer a ledger line and each step a stroke; budgets kept all in one tap or one at a time, each suggested as the mean of the full months Tally has, rounded up to the next $10; the demo keeps P124 A (decision 114).",
		issue: 95,
	},
	{
		title: "P126 · The Budget diagram with Planned",
		outcome:
			"Option A: the boxes keep today's size, and the row wraps after Bills due where it doesn't fit, with or without Planned (decisions 115 and 116).",
		issue: 202,
	},
	{
		title: "P127 · Safe to spend on a small phone",
		outcome:
			"Option A: no drawing below 390 px for amounts of 7 characters or fewer, and below 640 px for 8 or more characters, and the minus stays on its number (decision 116).",
		issue: 500,
	},
	{
		title: "P128 · The keyboard shortcuts list",
		outcome:
			"Option C: ? opens the list as a sheet, with a disclosure at each desktop page's foot and a More row below 1024px; keys /, ?, j, k, e or Enter, ← →, and u; key chips in a mono face (decision 118).",
		issue: 72,
	},
	{
		title: "P129 · The money input, state by state",
		outcome:
			"Option A: a muted 0.00 when empty, a check on the chip that matches the box, the steps off while the text can't be read, and five keyboard and screen-reader fixes; the centred layout stays (decision 117).",
		issue: 80,
	},
	{
		title: "P130 · One Why per page",
		outcome:
			"Option A: one Why? per page, beside the page's summary sentence (Bills' 5 bills to pay soon, Trends' headline); section headings carry none (decision 121).",
		issue: 603,
	},
	{
		title: "P131 · A bill's page",
		outcome:
			"Option A: a quiet ledger of months, one ruled row each with its status in muted words; a charge Tally found is its own row with Link it, months with no payment fold into one row, and no filled status pills (decision 121).",
		issue: 604,
	},
	{
		title: "P132 · What a past month's result says",
		outcome:
			"Option A: the number, stamp and bars stay, and one muted line under the number and stamp, above the bars, names the biggest causes, from the categories over budget and the positive spending with no budget, by amount, linking to them (decision 121).",
		issue: 605,
	},
	{
		title: "P133 · The month dots",
		outcome:
			"Option A: each finished month's dot in the month strip holds a small mark, a check for under budget, a minus for over, or an empty ring for a month with no budgets; the shown month keeps its ink ring and the current month its ring; each month's link names its result in words (decision 121). C, D and E stay drawn, not picked.",
		issue: 605,
	},
	{
		title: "P134 · Settings",
		outcome:
			"Option A: Settings becomes a short contents page drawn like More (P122 A), with the suggestions Band above; each section opens its own page with Settings as the back link; switches save when flipped, each rule names its category once with Remove as a quiet link, an empty Never suggest is one muted line, and Household keeps who gets the bank sign-in emails (decision 120).",
		issue: 606,
	},
	{
		title: "P135 · Category suggestions",
		outcome:
			"Option A: one suggestion card with one set of words wherever Tally asks it: Tally's guess, “A new category: Pet Care”, its transactions as ruled rows with one checkbox each, and Create Pet Care or No, where No retires the suggestion and asks “Don't suggest Pet Care again?”; in Organize, when the merchant is in a waiting suggestion, the card sits above the chips (decision 120).",
		issue: 607,
	},
	{
		title: "P136 · What Bills' section totals count",
		outcome:
			"Option A: each status heading's total counts every occurrence of its group in the month, listed or not, so Paid this month counts every bill payment made this month as Upcoming counts every occurrence still due; a muted line under a heading names the occurrences it counts that aren't listed (“Includes Daycare's Fridays on Oct 2 and 9”, up to two bills by name, then “and N more”) (decision 122).",
		issue: 602,
	},
	{
		title: "P137 · How Tally works' exact rules",
		outcome:
			"Option A: each section's exact rules fold under its diagram and worked example, in a closed “The exact rules” details with its rule count (“8 rules”); the words stay the spec's (decision 126).",
		issue: 644,
	},
	{
		title: "P138 · Link a payment's list",
		outcome:
			"Option A: Link a payment on a plan's and a bill's page shows the five closest charges as rows with the transaction row's look, each a 44px radio, then “Show all N charges” opening the rest in the same order (decision 126).",
		issue: 645,
	},
	{
		title: "P139 · How each part of a split picks its category",
		outcome:
			"Option A: each part picks its category in a folded row like the edit panel (P120 B): the two-column category grid shows until a category is chosen, then the row folds to one line naming it; each part's radios have their own group, read by part (decision 131).",
		issue: 660,
	},
	{
		title: "P140 · A new family's banks",
		outcome:
			"Option A: Your banks lists each connected bank's state under the status (90 days in · 412, or Reading · 86 so far with the busy ring), and Have more accounts? with Link a bank sits under it while the import is read; the list refreshes every 5 seconds while a bank is read (decision 133).",
		issue: 719,
	},
	{
		title: "P142 · A new family's setup",
		outcome:
			"Option A: setup on its own pages: a welcome, then four steps, each a screen with a step bar, one question, the bank's own numbers as a ledger card and the answers at its foot, and a finish that shows Safe to spend and what was set up; no tab bar until setup is done, and the fifth stroke goes (decision 148).",
		issue: 772,
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

			<section aria-labelledby="p139-title" class="mt-12">
				<h2 id="p139-title" class="font-serif text-3xl font-semibold">
					Picked: the split form's category picker
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 17. The owner's pick, marked Picked, is decision 131: A.
				</p>
				<SplitCategoryProposal />
			</section>

			<section aria-labelledby="p140-title" class="mt-12">
				<h2 id="p140-title" class="font-serif text-3xl font-semibold">
					Picked: Home's first week with two banks
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 19. The owner's pick, marked Picked, is decision 133: A.
				</p>
				<BanksProposal />
			</section>

			<section aria-labelledby="p142-title" class="mt-12">
				<h2 id="p142-title" class="font-serif text-3xl font-semibold">
					Picked: a new family's setup
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 22. The owner's pick, marked Picked, is decision 148: A.
				</p>
				<SetupProposal />
			</section>

			<section aria-labelledby="followups-picks-title" class="mt-12">
				<h2
					id="followups-picks-title"
					class="font-serif text-3xl font-semibold"
				>
					Picked: from the second design audit, the rules and the payment list
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 16. The owner's picks, marked Picked, are decision 126: P137
					A, P138 A.
				</p>
				<AuditFollowupProposals />
			</section>

			<section aria-labelledby="p136-title" class="mt-12">
				<h2 id="p136-title" class="font-serif text-3xl font-semibold">
					Picked: what Bills' totals count
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 15. The owner's pick, marked Picked, is decision 122: A,
					each heading counts every occurrence in the month and says which ones
					aren't listed.
				</p>
				<BillsTotalsProposal />
			</section>

			<section aria-labelledby="audit2-picks-title" class="mt-12">
				<h2 id="audit2-picks-title" class="font-serif text-3xl font-semibold">
					Picked: from the second design audit
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 15. The owner's picks, marked Picked, are decision 121: P130
					A, one Why per page; P131 A, a quiet ledger of months; P132 A, one
					line names the cause; P133 A, marks in outline.
				</p>
				<AuditRoundTwoPicks />
			</section>

			<section aria-labelledby="audit3-title" class="mt-12">
				<h2 id="audit3-title" class="font-serif text-3xl font-semibold">
					Picked: from the second design audit, Settings and suggestions
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 15. The owner's picks, marked Picked, are decision 120: A,
					Settings as a contents page, and A, one card for a category
					suggestion.
				</p>
				<AuditRoundThreeProposals />
			</section>

			<section aria-labelledby="p128-title" class="mt-12">
				<h2 id="p128-title" class="font-serif text-3xl font-semibold">
					Picked: the keyboard shortcuts list
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 15. The owner's pick, marked Picked, is decision 118: C, a
					sheet that ? opens, with the extra keys and mono key chips.
				</p>
				<KeyboardListProposal />
			</section>

			<section aria-labelledby="p129-title" class="mt-12">
				<h2 id="p129-title" class="font-serif text-3xl font-semibold">
					Picked: the money input
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 15. The owner's pick, marked Picked, is decision 117: A,
					today's money input with what it lost put back.
				</p>
				<MoneyInputProposal />
			</section>

			<section aria-labelledby="p127-title" class="mt-12">
				<h2 id="p127-title" class="font-serif text-3xl font-semibold">
					Picked: Safe to spend on a small phone
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 14 for issue #500. The owner's pick, marked Picked, is
					decision 116: A, no drawing below 390 px for amounts of 7 characters
					or fewer, and below 640 px for 8 or more, built in #566.
				</p>
				<SafeToSpendSmallProposal />
			</section>

			<section aria-labelledby="p126-title" class="mt-12">
				<h2 id="p126-title" class="font-serif text-3xl font-semibold">
					Picked: the Budget diagram with Planned
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 14 for #202. The owner's pick, marked Picked, is decision
					115: A, the boxes at today's size and the row wrapping where it
					doesn't fit. Decision 116 extends the wrap to every width.
				</p>
				<PlannedDiagramProposal />
			</section>

			<section aria-labelledby="polish5-title" class="mt-12">
				<h2 id="polish5-title" class="font-serif text-3xl font-semibold">
					Picked: the polish track, a new family's first week
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 14. The owner's pick, marked Picked, is decision 114: E, the
					notebook filled in one question at a time.
				</p>
				<PolishRoundDProposals />
			</section>

			<section aria-labelledby="polish4-title" class="mt-12">
				<h2 id="polish4-title" class="font-serif text-3xl font-semibold">
					Picked: the polish track, More, Feedback and the first visit
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 13. The owner's picks, marked Picked, are decision 111: what
					More shows, where Feedback lives, and what a first visit shows and
					teaches.
				</p>
				<PolishRoundCProposals />
			</section>

			<section aria-labelledby="polish3-title" class="mt-12">
				<h2 id="polish3-title" class="font-serif text-3xl font-semibold">
					Picked: the polish track, the edit panel and the list's top
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 13. The owner's picks, marked Picked, are decision 111: what
					the edit panel leads with, and how much of Transactions' first screen
					goes to filters.
				</p>
				<PolishRoundBProposals />
			</section>

			<section aria-labelledby="polish2-title" class="mt-12">
				<h2 id="polish2-title" class="font-serif text-3xl font-semibold">
					Picked: the polish track, rows and saves
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Drawn Oct 13. The owner's picks, marked Picked, are decision 111: how
					a row shows it opens, and how the row you just saved shows it changed.
				</p>
				<PolishRoundAProposals />
			</section>

			<section aria-labelledby="polish-title" class="mt-12">
				<h2 id="polish-title" class="font-serif text-3xl font-semibold">
					Picked: the polish pass
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					Choices the polish pass turned up (questions 56 to 63), each drawn on
					a phone. The owner's picks marked Picked are decisions 84 and 85.
				</p>
				<PolishProposals />
			</section>

			<section aria-labelledby="details-title" class="mt-12">
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
				<SplitThisOneProposal />
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

			<section aria-labelledby="picks-title" class="mt-12">
				<h2 id="picks-title" class="font-serif text-3xl font-semibold">
					Picked: Phase 5's open questions
				</h2>
				<p class="mt-2 max-w-prose text-muted">
					The owner's picks on the open questions of #198–#203 and #207, decided
					by seeing a picture of each (spec §8.4, decision 82). Each drawing is
					the pick as it will be built; a pick that replaces an earlier drawing
					says so there.
				</p>
				<Phase5PicksProposals />
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
