// P88: where a "never suggest this again" lives, and how one is changed (questions 14 and 15, on
// P42 A's review screen and P69 A's list). Each option is drawn on a phone's first screen from the
// real components with demo-style data (today is Mon Oct 5), so the owner can pick by seeing
// (decision 47). Pieces that don't exist yet (a Never-suggest row, the toast) are prototypes, in
// tokens, that live only on this page. Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { shortDay } from "../dates";
import { formatCents } from "../money";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { Fixed, Options } from "./proposal-parts";
import { Answers, Question, ReviewHead } from "./proposals-ai";
import {
	actions,
	BLUE_BOTTLE,
	CARD,
	type Cat,
	Categories,
	Days,
	EATING_OUT,
	GROCERIES,
	KIDS,
	NeedsLine,
	PanelForm,
	PanelSheet,
	PanelTop,
	RULES,
	RuleRows,
	TITLE,
	TODAY,
	Toggles,
	TRADER_JOES,
	TxHeader,
	tx,
} from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

const DATE_NIGHT: Cat = {
	name: "Date Night",
	icon: "date-night",
	color: "cat-plum",
};

// ---------------------------------------------------------------------------------------------
// The rules the family has said No to, as a row: what Tally won't suggest, when the person said
// so, and a terracotta Remove, the same shape as P69 A's rows.

type Never = { icon: Child; says: string; when: string };

const NEVER: Never[] = [
	{
		icon: <Icon name="income" class="size-7" />,
		says: "Never suggest income for Venmo",
		when: "You said No on Oct 3",
	},
	{
		icon: <Icon name="tag" class="size-7" />,
		says: "Never suggest a name for AMZN MKTP",
		when: "You said No on Sep 28",
	},
	{
		icon: <CategoryIcon icon="eating-out" color="cat-plum" />,
		says: "Never suggest Eating Out for Lupita's Taqueria",
		when: "You said No on Sep 14",
	},
];

function NeverRows() {
	return (
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{NEVER.map((r) => (
				<li class="flex min-h-16 items-center gap-4 py-2">
					<span class="shrink-0">{r.icon}</span>
					<span class="min-w-0 flex-1">
						{/* No truncation, as in P69 A: a long merchant wraps rather than lose what the row says. */}
						<span class="block text-lg leading-6">{r.says}</span>
						<span class="block leading-6 text-muted">{r.when}</span>
					</span>
					<Button kind="text" type="button">
						Remove<span class="sr-only"> rule: {r.says}</span>
					</Button>
				</li>
			))}
		</ul>
	);
}

/**
 * A toast as toast.js draws it, minus its one shadow (the token test allows that only in
 * toast.js), where Layout's #toasts sits: 9rem above the screen's bottom, which is 88px above the
 * picture's, since the tab bar is under it.
 */
function Toast({ children }: { children?: Child }) {
	return (
		<div class="absolute -inset-x-1 bottom-22 flex justify-center">
			<p
				role="status"
				class="rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink"
			>
				{children}
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Settings, drawn first so it fits (as P69 A does).

/** A: one heading, two lists. The first keeps the name the owner picked in decision 74. */
const settingsOneHeading = (
	<>
		<h1 class={TITLE}>Settings</h1>
		<section class="mt-8" aria-labelledby="p88-a-rules">
			<h2 id="p88-a-rules" class="font-serif text-3xl font-semibold">
				Tally's rules
			</h2>
			<p class="mt-1 text-muted">
				What Tally does on its own, and what it won't suggest.
			</p>
			<h3 class="mt-5 text-lg font-semibold">Always for these merchants</h3>
			<RuleRows rules={RULES.slice(0, 2)} />
			<h3 class="mt-6 text-lg font-semibold">Never suggest</h3>
			<NeverRows />
		</section>
	</>
);

/** B: P69 A's section as picked, and a second section of its own for the nevers. */
const settingsTwoSections = (
	<>
		<h1 class={TITLE}>Settings</h1>
		<section class="mt-8" aria-labelledby="p88-b-always">
			<h2 id="p88-b-always" class="font-serif text-3xl font-semibold">
				Always for these merchants
			</h2>
			<p class="mt-1 text-muted">Tally sorts these merchants for you.</p>
			<RuleRows rules={RULES.slice(0, 2)} />
		</section>
		<section class="mt-8" aria-labelledby="p88-b-never">
			<h2 id="p88-b-never" class="font-serif text-3xl font-semibold">
				Never suggest
			</h2>
			<p class="mt-1 text-muted">Tally won't suggest these again.</p>
			<NeverRows />
		</section>
	</>
);

// ---------------------------------------------------------------------------------------------
// The review screen (P42 A). Venmo's "Maybe income" is the question being answered No to.

const venmoHead = (
	<ReviewHead
		place="5 of 14"
		name="Venmo"
		bank="VENMO CASHOUT 4821"
		meta={`${formatCents(-8500, { signed: true })} · ${shortDay("2026-10-03", TODAY)}`}
	/>
);

const venmoQuestion = (
	<Question
		icon={<Icon name="income" class="size-7" />}
		line="Count it as income, not spending?"
		sure={66}
	>
		income
	</Question>
);

/**
 * A, after No: the next question is up, the count has gone from 14 to 13 (a Skip would have kept
 * it), and the toast says where the rule went.
 */
const afterNo = (
	<div class="relative h-[680px]">
		<ReviewHead
			place="5 of 13"
			name="Chase card payment"
			bank="CHASE CREDIT CRD AUTOPAY"
			meta={`${formatCents(81240, { signed: true })} · ${shortDay("2026-10-02", TODAY)}`}
		/>
		<Question
			icon={<Icon name="transfer" class="size-7" />}
			line="Leave it out of the budget?"
			sure={58}
		>
			a transfer
		</Question>
		<Answers yes="Yes, leave it out" no="No, it's spending" />
		<Toast>
			Got it. Tally won't suggest that again. Change it in Settings.
		</Toast>
	</div>
);

/**
 * B, after tapping No: it opens in place, as Something else does in P42 A, to the two things it
 * can mean. Yes and Skip stay where they were.
 */
const noOpened = (
	<>
		{venmoHead}
		{venmoQuestion}
		<div class="mt-5 flex flex-col gap-3">
			<Button type="button" class="w-full">
				Yes, it's income
			</Button>
			<div>
				<Button kind="secondary" type="button" class="w-full">
					No
				</Button>
				<div class="mt-3 flex flex-col gap-3">
					<p class="text-center text-sm text-muted">
						Just this one, or every time?
					</p>
					<Button kind="secondary" type="button" class="w-full">
						Not this one
					</Button>
					<Button kind="secondary" type="button" class="w-full">
						Never for this merchant
					</Button>
				</div>
			</div>
			<div class="text-center">
				<Button kind="text" type="button">
					Skip
				</Button>
			</div>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// The edit panel, for a transaction Tally was told not to sort as Eating Out.

const LUPITAS_DATE_NIGHT = tx(
	3,
	"2026-10-04",
	"Lupita's Taqueria",
	4290,
	DATE_NIGHT,
);

/** C: the line sits under the category chips, where "Picked by Tally" would, with Undo after it. */
const panelLine = (
	<PanelSheet
		behind={
			<>
				<TxHeader />
				<Days rows={[BLUE_BOTTLE, LUPITAS_DATE_NIGHT, TRADER_JOES]} />
			</>
		}
	>
		<PanelTop row={LUPITAS_DATE_NIGHT} raw="TST* LUPITAS TAQ" account={CARD} />
		<PanelForm>
			<Categories
				p="p88-c"
				cats={[GROCERIES, EATING_OUT, KIDS, DATE_NIGHT]}
				selected="Date Night"
			>
				<p class="flex flex-wrap items-center gap-x-1 text-sm text-muted">
					Tally won't suggest Eating Out for this merchant
					<Button kind="text" type="button" class="-ml-2 text-sm">
						Undo<span class="sr-only"> the rule for Eating Out</span>
					</Button>
				</p>
			</Categories>
			<Toggles p="p88-c" />
			{actions}
		</PanelForm>
	</PanelSheet>
);

export function RulesProposals() {
	return (
		<Specimen
			id="p88-never-ask"
			title="P88 · Never-ask-again, as rules you can change"
			tier="visual"
			sentence="When you answer No to one of Tally's guesses, it remembers and doesn't ask again, and each one is saved as a rule the family can see and change. Pick where those rules live and how one is changed. The examples are Venmo's “Maybe income”, a name for AMZN MKTP and Eating Out for Lupita's Taqueria."
		>
			<Fixed>
				questions 14 and 15, on decisions 73 and 74. P42 A's review screen asks
				each “Maybe …” as one yes-or-no question, with Something else and Skip,
				and a No is remembered so it's never asked again (for a name, for that
				merchant); a Skip stays in the count and comes back at the end. P69 A's
				list is named “Always for these merchants”, in the toggle's own words
				(decision 74), with Remove on each row. The owner's ask: every
				never-ask-again is also saved as a rule the family can see and easily
				change later, for future transactions.
			</Fixed>
			<NeedsLine>
				whether Something else on a category or name, which P42 A gives no No
				button, also makes a rule, whether Remove changes one already answered
				(proposed: never), and what Settings says with no rules (proposed: an
				EmptyState). Already settled (decisions 77 and 78): a rule is kept when
				a person says No, for one merchant and one kind of suggestion (for a
				category, which category), and Tally never makes that suggestion again
				until the family removes the rule from “Tally's rules” in Settings.
			</NeedsLine>
			<Options
				options={[
					{
						name: "Option A · One “Tally's rules” place in Settings",
						picked: true,
						note: "Two lists under one heading: “Always for these merchants”, as picked in P69 A, and “Never suggest”. Every No lands in the second as one line, and each line has Remove, which takes the line away and says so in a toast.",
						tradeoff:
							"Settings gets longer, and “Always for these merchants” moves one level down, under a new heading.",
						recommended:
							"everything Tally does on its own, and everything it won't, in one place a person can read and undo.",
						tall: true,
						screen: settingsOneHeading,
					},
					{
						name: "Option A, next · What No does on the review screen",
						note: "After No on Venmo, the next question is up, the count has gone from 14 to 13, and a toast says where to change it. A Skip makes no rule: it stays in the count and comes back at the end.",
						screen: afterNo,
					},
					{
						name: "Option B · Not this one, or never",
						note: "No opens in place, as Something else does, to “Not this one” (this transaction only, as in question 14) and “Never for this merchant”, which makes the rule.",
						tradeoff:
							"a second tap on every No, and “Not this one” asks again at that merchant's next transaction, which the owner asked to stop.",
						screen: noOpened,
					},
					{
						name: "Option B, next · A separate “Never suggest” list",
						note: "Only “Never for this merchant” lands here: a second section on Settings, beside “Always for these merchants”, each line with Remove.",
						tradeoff:
							"two sections to read to see what Tally does on its own and what it won't.",
						tall: true,
						screen: settingsTwoSections,
					},
					{
						name: "Option C · A line in the edit panel",
						note: "A No saves the rule with no screen of its own. That merchant's panel says “Tally won't suggest Eating Out for this merchant”, with Undo after it, under the category chips.",
						tradeoff:
							"there's no list: a rule is found only by opening a transaction from that merchant, so nothing shows everything Tally has been told not to suggest.",
						screen: panelLine,
					},
				]}
			/>
		</Specimen>
	);
}
