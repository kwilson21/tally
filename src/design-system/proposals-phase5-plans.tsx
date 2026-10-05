// P54–P56 (spec §8.4, decision 66): a savings goal, planned one-time expenses, and the reconnect
// reminder email. Each option is drawn on a phone's first screen from the real components with
// demo-style data (today is Oct 5), so the owner can pick by seeing (decision 47). Amounts are
// worked out here from integer cents, the way §6 will, so every picture adds up. Nothing here is
// decided until the owner picks.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import type { BillRowData } from "../views/bill-row";
import { BillRow, BillStatusHeading } from "../views/bill-row";
import { Button } from "../views/button";
import { HomeTop } from "../views/home-top";
import { Icon } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { TextInput } from "../views/text-input";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

/** A rule the spec still needs before the feature is built. */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Rule to write before building: </span>
			{children}
		</p>
	);
}

const dollars = (cents: number) => formatCents(cents, { wholeDollars: true });

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: October, five days in.

const TODAY = "2026-10-05";

type Row = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

const GROCERIES: Row = {
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	spentCents: 19600,
	budgetCents: 70000,
};
const EATING_OUT: Row = {
	name: "Eating Out",
	icon: "eating-out",
	color: "cat-plum",
	spentCents: 9200,
	budgetCents: 25000,
};
const GAS: Row = {
	name: "Gas",
	icon: "gas",
	color: "cat-slate",
	spentCents: 4800,
	budgetCents: 15000,
};
/** Its $60 is the Swim lessons bill, paid Oct 2 (below), so the paid bill is part of the spending. */
const KIDS: Row = {
	name: "Kids",
	icon: "kids",
	color: "cat-ochre",
	spentCents: 6000,
	budgetCents: 20000,
};
const CAR: Row = {
	name: "Car & Transport",
	icon: "car",
	color: "cat-brown",
	spentCents: 6400,
	budgetCents: 10000,
};
const ROWS = [GROCERIES, EATING_OUT, GAS, KIDS, CAR];

// $1,400 budgeted and $460 spent, so Safe to spend stays under $1,000 in every picture: HomeTop's
// headline is wide enough at four digits to push its pencil off a 390px phone.
const BUDGET = ROWS.reduce((n, r) => n + r.budgetCents, 0);
const SPENT = ROWS.reduce((n, r) => n + r.spentCents, 0);

/** Electric, due Oct 8 and not paid: Safe to spend already sets it aside (§6). */
const BILL_DUE = 14200;

/** §6 as it stands: the whole budget, less what's spent, less bills due and not paid. */
const SAFE_TODAY = BUDGET - SPENT - BILL_DUE;

/** The savings goal, and what the family moved to savings on Oct 1 (an excluded transfer). */
const GOAL = 50000;
const MOVED = 20000;

/** The planned one-off: Car registration, $180, in October. */
const PLANNED = 18000;

/** Home's Budget heading with Adjust beside it, and its rows. */
function Budget({ children }: { children?: Child }) {
	return (
		<section class="mt-8">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="font-serif text-3xl font-semibold">Budget</h2>
				<AdjustLink adjusting={false} href="#p54-savings-goal" />
			</div>
			<ul class="mt-2 divide-y divide-rule">{children}</ul>
		</section>
	);
}

/** Home's top for October, with Safe to spend as a given rule works it out. */
function Top({
	safe,
	status = "Everything is on track.",
}: {
	safe: number;
	status?: string;
}) {
	return (
		<HomeTop
			month="October"
			safeToSpendCents={safe}
			status={status}
			demo={true}
		/>
	);
}

const rows = (list: Row[]) => list.map((r) => <ProgressRow {...r} />);

// ---------------------------------------------------------------------------------------------
// P54: a savings goal.

/**
 * P54 A: the goal as the Budget list's first row. Nothing is spent from it, so it has no bar; a
 * muted line says what it does instead. In the app it opens its sheet, as a budget row does.
 */
function GoalRow({ amount, line }: { amount: Child; line: string }) {
	return (
		<li class="flex items-start gap-4 py-3">
			<span class="shrink-0 text-ink">
				<Icon name="bank" class="size-7" />
			</span>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3">
					<span class="text-lg">Savings</span>
					<span class="ml-auto text-right text-lg">{amount}</span>
				</div>
				<p class="text-muted">{line}</p>
			</div>
		</li>
	);
}

const aMonth = (cents: number) => (
	<>
		{dollars(cents)} <span class="text-muted">a month</span>
	</>
);

/** R1, the recommended rule: the whole goal is set aside from the first of the month. */
const SAFE_R1 = SAFE_TODAY - GOAL;

/** P54 A: Home with the goal as the first Budget row. */
const goalHome = (
	<>
		<Top safe={SAFE_R1} />
		<Budget>
			<GoalRow amount={aMonth(GOAL)} line="Set aside from Safe to spend" />
			{rows(ROWS)}
		</Budget>
	</>
);

/** P54 A: tapping the row opens the same sheet a budget does, with the money input. */
const goalSheet = (
	<Sheet behind={goalHome}>
		<div class="flex items-center gap-3">
			<Icon name="bank" class="size-7" />
			<h2 class="font-serif text-3xl font-semibold">Savings</h2>
		</div>
		<p class="text-muted">
			Set aside from Safe to spend at the start of every month.
		</p>
		<div class="flex flex-col gap-4 border-t border-rule pt-4">
			<MoneyInput
				id="p54-goal"
				name="goal"
				label="Save each month, from October on"
				value="500.00"
			/>
			<div class="mt-2 grid grid-cols-2 gap-3">
				<Button kind="secondary" type="button" class="w-full">
					Cancel
				</Button>
				<Button type="button" class="w-full">
					Save
				</Button>
			</div>
		</div>
	</Sheet>
);

/** P54 B: Home names the goal only in its status sentence. */
const goalSentence = (
	<>
		<Top
			safe={SAFE_R1}
			status={`Everything is on track, after ${dollars(GOAL)} for savings.`}
		/>
		<Budget>{rows(ROWS)}</Budget>
	</>
);

/**
 * Settings scrolled down to a new section, as P41 draws it: the end of the Categories list, the
 * section, and the top of Your data. The real Categories list runs a dozen rows or more, so a new
 * section sits below the first screen.
 */
function SettingsScrolled({ children }: { children?: Child }) {
	return (
		<>
			<div class="flex min-h-11 items-center gap-4 border-b border-rule py-2 text-accent">
				<Icon name="plus" class="size-5" />
				Add category
			</div>
			<section class="mt-8 border-t border-rule pt-6">{children}</section>
			<section class="mt-8 border-t border-rule pt-6">
				<h2 class="font-serif text-3xl font-semibold">Your data</h2>
			</section>
		</>
	);
}

/** P54 B: the goal is set in Settings, in a section of its own after Categories. */
const goalSettings = (
	<SettingsScrolled>
		<h2 class="font-serif text-3xl font-semibold">Savings</h2>
		<p class="mt-1 text-muted">
			Set aside from Safe to spend at the start of every month.
		</p>
		<div class="mt-4 flex flex-col gap-4">
			<MoneyInput
				id="p54-settings-goal"
				name="goal"
				label="Save each month, from October on"
				value="500.00"
			/>
			<div>
				<Button type="button">Save</Button>
			</div>
		</div>
	</SettingsScrolled>
);

/** P54 C: Savings as a category whose bar fills with transfers to savings. */
const goalCategory = (
	<>
		<Top safe={SAFE_R1} />
		<Budget>
			<ProgressRow
				name="Savings"
				icon="bank"
				color="cat-slate"
				spentCents={MOVED}
				budgetCents={GOAL}
			/>
			{rows(ROWS)}
		</Budget>
	</>
);

/** The rule question: Home on Oct 5 under each rule, with the goal's row saying what it does. */
function goalRule(safe: number, amount: Child, line: string) {
	return (
		<>
			<Top safe={safe} />
			<Budget>
				<GoalRow amount={amount} line={line} />
				{rows(ROWS.slice(0, 3))}
			</Budget>
		</>
	);
}

/** R2: only what hasn't been moved to savings yet is set aside. */
const SAFE_R2 = SAFE_TODAY - (GOAL - MOVED);

/** R3: set aside like a bill due on the 15th, so only from Oct 8, a week before. Today it isn't. */
const SAFE_R3 = SAFE_TODAY;

const sum = (safe: number, ...parts: [number, string][]) =>
	`${dollars(BUDGET)} budget − ${dollars(SPENT)} spent − ${dollars(BILL_DUE)} bill due${parts
		.map(([c, what]) => ` − ${dollars(c)} ${what}`)
		.join("")} = ${dollars(safe)}.`;

// ---------------------------------------------------------------------------------------------
// P55: planned one-time expenses.

const BILLS: BillRowData[] = [
	{
		id: 1,
		name: "Electric",
		amountCents: BILL_DUE,
		status: "due",
		dueDate: "2026-10-08",
		icon: "utilities",
		color: "cat-ochre",
	},
	{
		id: 2,
		name: "Internet",
		amountCents: 7000,
		status: "upcoming",
		dueDate: "2026-10-18",
		icon: "utilities",
		color: "cat-ochre",
	},
	{
		id: 3,
		name: "Swim lessons",
		amountCents: KIDS.spentCents,
		status: "paid",
		dueDate: "2026-10-02",
		paidDate: "2026-10-02",
		icon: KIDS.icon,
		color: KIDS.color,
	},
];
const [ELECTRIC, INTERNET, SWIM] = BILLS as [
	BillRowData,
	BillRowData,
	BillRowData,
];

type Plan = { name: string; cents: number; line: string };
const PLANS: Plan[] = [
	{
		name: "Car registration",
		cents: PLANNED,
		line: "Set aside for October",
	},
	{ name: "Holiday gifts", cents: 40000, line: "Set aside from December" },
];

/**
 * One planned expense, shaped like a BillRow: an icon, its name, the month it's set aside in, and
 * the amount. It has no category of its own; its payment counts in the payment's category.
 */
function PlannedRow({ plan }: { plan: Plan }) {
	return (
		<li class="flex min-h-16 items-center gap-4">
			<span class="shrink-0 text-ink">
				<Icon name="tag" class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{plan.name}</span>
				<span class="block truncate leading-6 text-muted">{plan.line}</span>
			</span>
			<span class="shrink-0 text-lg">{formatCents(plan.cents)}</span>
		</li>
	);
}

/** The Planned group's heading, in BillStatusHeading's look: an icon and the word. */
const plannedHeading = (
	<h2 class="flex items-center gap-2 text-sm text-muted">
		<span class="text-muted">
			<Icon name="tag" class="size-4" />
		</span>
		Planned
	</h2>
);

/** P55 A: Bills with a Planned group after Upcoming, and Plan an expense beside Add a bill. */
const plannedBills = (
	<>
		<Title>Bills</Title>
		<p class="mt-2 font-serif text-lg italic">
			1 bill to pay soon, {formatCents(BILL_DUE)} in all
		</p>
		<div class="mt-3 flex flex-wrap gap-3">
			<Button kind="secondary" type="button">
				Add a bill
			</Button>
			<Button kind="secondary" type="button">
				Plan an expense
			</Button>
		</div>
		<section class="mt-4">
			<BillStatusHeading status="due" />
			<ul class="divide-y divide-rule">
				<BillRow bill={ELECTRIC} today={TODAY} />
			</ul>
		</section>
		<section class="mt-4">
			<BillStatusHeading status="upcoming" />
			<ul class="divide-y divide-rule">
				<BillRow bill={INTERNET} today={TODAY} />
			</ul>
		</section>
		<section class="mt-4">
			{plannedHeading}
			<ul class="divide-y divide-rule">
				{PLANS.map((p) => (
					<PlannedRow plan={p} />
				))}
			</ul>
		</section>
		<section class="mt-4">
			<BillStatusHeading status="paid" />
			<ul class="divide-y divide-rule">
				<BillRow bill={SWIM} today={TODAY} />
			</ul>
		</section>
	</>
);

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** P55 A: Plan an expense opens a sheet like Add a bill's: what it's for, the amount, the month. */
const planSheet = (
	<Sheet behind={plannedBills}>
		<h2 class="font-serif text-3xl font-semibold tracking-tight">
			Plan an expense
		</h2>
		<div class="flex flex-col gap-2">
			<TextInput
				id="p55-name"
				label="What it's for"
				value="Car registration"
				surface="paper"
			/>
			<MoneyInput id="p55-amount" name="amount" label="Amount" value="180.00" />
			<label class="flex flex-col gap-1">
				<span>Month</span>
				<select
					name="p55-month"
					class="min-h-11 rounded-control border border-rule bg-paper px-3"
				>
					{Array.from({ length: 12 }, (_, i) => (
						<option value={i} selected={i === 0}>
							{MONTHS[(9 + i) % 12]} {i < 3 ? 2026 : 2027}
						</option>
					))}
				</select>
			</label>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				Save
			</Button>
		</div>
	</Sheet>
);

/** A and B set it aside like a due bill, for its whole month. */
const SAFE_PLANNED = SAFE_TODAY - PLANNED;

/** P55 B: a Planned this month list under the Budget, like Bills due soon, with an add row after it. */
const plannedHome = (
	<>
		<Top safe={SAFE_PLANNED} />
		<Budget>{rows(ROWS.slice(0, 2))}</Budget>
		<section class="mt-8">
			<h2 class="font-serif text-2xl font-semibold">Planned this month</h2>
			<ul class="divide-y divide-rule border-b border-rule">
				<PlannedRow
					plan={{
						name: "Car registration",
						cents: PLANNED,
						line: "Set aside until it's paid",
					}}
				/>
			</ul>
			<a
				href="#p55-planned"
				class="flex min-h-11 items-center gap-2 text-accent no-underline"
			>
				<Icon name="plus" class="size-5" />
				Plan an expense
			</a>
		</section>
	</>
);

/**
 * P55 C: a one-month bump on a category's budget. The total budget rises with it, so Safe to spend
 * goes up until it's paid, which the picture shows honestly.
 */
const SAFE_BUMP = SAFE_TODAY + PLANNED;
const bumpHome = (
	<>
		<Top safe={SAFE_BUMP} />
		<section class="mt-8">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="font-serif text-3xl font-semibold">Budget</h2>
				<AdjustLink adjusting={false} href="#p55-planned" />
			</div>
			<ul class="mt-2">
				<ProgressRow {...CAR} budgetCents={CAR.budgetCents + PLANNED} />
			</ul>
			<p class="-mt-1 text-pretty pb-3 text-muted">
				Includes {dollars(PLANNED)} for Car registration, October only
			</p>
			<ul class="divide-y divide-rule border-t border-rule">
				{rows([GROCERIES, EATING_OUT, GAS])}
			</ul>
		</section>
	</>
);

// ---------------------------------------------------------------------------------------------
// P56: the reconnect reminder email, drawn as it reads in a phone's mail app. The wordmark at the
// top of the picture is the email's own letterhead.

/** An email from Tally: who and when, the subject, its body, and a muted footer that says why it came. */
function Email({
	subject,
	sent,
	footer,
	children,
}: {
	subject: string;
	sent: string;
	footer: string;
	children?: Child;
}) {
	return (
		<>
			<div class="border-b border-rule pb-3">
				<p class="text-sm text-muted">
					From Tally · to dana@example.com · {sent}
				</p>
				<p class="mt-1 text-xl font-semibold">{subject}</p>
			</div>
			<div class="mt-4 flex flex-col items-start gap-4 text-lg">{children}</div>
			<div class="mt-8 border-t border-rule pt-3">
				<p class="text-sm text-muted">{footer}</p>
				<a
					href="#p56-reconnect-email"
					class="inline-flex min-h-11 items-center text-sm"
				>
					Turn these emails off
				</a>
			</div>
		</>
	);
}

/** The one action: a link that looks like Tally's primary button, to Accounts' Fix connection. */
const fixLink = (label: string) => <Button href="/accounts">{label}</Button>;

const EVERY_3_DAYS = "Tally sends this every 3 days until the bank is fixed.";

/** P56 A: short and plain. No amounts, accounts or transactions. */
const emailPlain = (
	<Email
		subject="Chase needs you to sign in again"
		sent="Mon, Oct 5"
		footer={EVERY_3_DAYS}
	>
		<p>
			Tally hasn't been able to sync Chase since Oct 1, so Safe to spend may be
			too high.
		</p>
		<p>Signing in again takes a minute.</p>
		{fixLink("Fix the connection")}
	</Email>
);

/** One account the email names: its icon, name and last four digits; never a balance. */
function EmailAccount({
	name,
	mask,
	card,
}: {
	name: string;
	mask: string;
	card?: boolean;
}) {
	return (
		<li class="flex min-h-11 items-center gap-3">
			<Icon name={card ? "card" : "bank"} class="size-6" />
			{name}
			<span class="text-muted">
				<span class="sr-only">ending in </span>
				<span aria-hidden="true">••</span>
				{mask}
			</span>
		</li>
	);
}

/** P56 B: the same, plus the accounts behind the login and the exact time it last synced. */
const emailDetail = (
	<Email
		subject="Chase needs you to sign in again"
		sent="Mon, Oct 5"
		footer={EVERY_3_DAYS}
	>
		<p>
			Tally hasn't been able to sync Chase since Oct 1 at 6:14 AM, so Safe to
			spend may be too high.
		</p>
		<div class="w-full">
			<p class="text-sm text-muted">Not syncing</p>
			<ul class="divide-y divide-rule border-y border-rule">
				<EmailAccount name="Checking" mask="4521" />
				<EmailAccount name="Card" mask="9921" card />
			</ul>
		</div>
		<p>Signing in again takes a minute.</p>
		{fixLink("Fix the connection")}
	</Email>
);

/** P56 C: one email a week, listing every bank that needs signing in again. */
const emailDigest = (
	<Email
		subject="2 banks need you to sign in again"
		sent="Mon, Oct 5"
		footer="Tally sends this on Mondays while a bank needs you."
	>
		<p>Tally can't sync these banks, so Safe to spend may be too high.</p>
		<ul class="w-full divide-y divide-rule border-y border-rule">
			<li class="flex min-h-11 items-center justify-between gap-3">
				<span>Chase</span>
				<span class="text-muted">since Oct 1</span>
			</li>
			<li class="flex min-h-11 items-center justify-between gap-3">
				<span>Capital One</span>
				<span class="text-muted">since Oct 4</span>
			</li>
		</ul>
		<p>Signing in again takes a minute for each.</p>
		{fixLink("Fix the connections")}
	</Email>
);

/**
 * Both: the switch in Settings, drawn as P41's option A draws a switch (the state in words, and a
 * button that says what a tap does), so it follows whichever switch the owner picks there. It sits
 * after Categories, and the line under its name says where the email goes.
 */
const reminderSettings = (
	<SettingsScrolled>
		<h2 class="font-serif text-3xl font-semibold">Reminders</h2>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			<li class="flex items-center gap-3 py-2">
				<span class="min-w-0 flex-1">
					<span class="block text-lg">
						Email me when a bank needs signing in again
					</span>
					<span class="block text-pretty text-muted">
						Goes to dana@example.com
					</span>
				</span>
				<span class="flex shrink-0 flex-col items-end">
					<span class="font-medium">On</span>
					<Button kind="secondary" type="button" class="px-4">
						Turn off
						<span class="sr-only"> emails about banks</span>
					</Button>
				</span>
			</li>
		</ul>
	</SettingsScrolled>
);

/** P54–P56 on the proposals page, open for the owner's pick. */
export function Phase5PlansProposals() {
	return (
		<>
			<Specimen
				id="p54-savings-goal"
				title="P54 · A savings goal"
				tier="visual"
				sentence="A monthly amount to save, which Safe to spend sets aside. Pick where it's set and how Home shows it; each is drawn with R1 from the rule below."
			>
				<Fixed>
					a goal is a monthly amount to save, which Safe to spend sets aside;
					before it's built, §6's Safe to spend rule gains the line that
					subtracts it and the goal's table joins §5 (§8.4). A budget is set on
					Home, in a sheet with the money input (decision 38).
				</Fixed>
				<NeedsLine>
					the goal's table in §5 (drawn: one amount a month, from a given month
					on, like budget_amounts, so changing it never rewrites a past month).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line in Home's budget",
							note: "“Savings · $500 a month” is the Budget list's first row, with no bar; tapping it opens a sheet like a budget's.",
							tradeoff: "one row without a bar among rows with bars.",
							recommended:
								"it sits where the month's money is planned, and is set the way every budget is.",
							screen: goalHome,
						},
						{
							name: "Option A · Setting it",
							note: "The budget sheet with the money input. Before a goal is set, the row waits under Not budgeted as “Set a goal”.",
							screen: goalSheet,
						},
						{
							name: "Option B · In Settings",
							note: "Home names the goal only in its status sentence: “after $500 for savings”.",
							tradeoff:
								"every other amount is set on Home (decision 38), and once it's set the goal shows only as a phrase in that sentence.",
							screen: goalSentence,
						},
						{
							name: "Option B · Setting it in Settings",
							note: "A Savings section after Categories, with the money input and Save.",
							screen: goalSettings,
						},
						{
							name: "Option C · A savings category",
							note: "Savings is a category whose bar fills as you move money to savings.",
							tradeoff:
								"transfers would have to count in it, saving more than $500 would show as brick “over”, and §6 would have to leave its $500 out of the total budget, or Safe to spend would rise by it.",
							screen: goalCategory,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p54-goal-rule"
				title="P54 · How the goal enters Safe to spend"
				tier="visual"
				sentence="The rule question for §6. Each picture is Home on Oct 5 with a $500 goal, $200 moved to savings on Oct 1, and Electric ($142) due Oct 8."
			>
				<Fixed>
					Safe to spend is the month's total budget, minus counted spending,
					minus bills due or overdue and not paid (§6). A transaction flagged as
					a transfer starts excluded, so it isn't counted as spending (§6,
					§8.5).
				</Fixed>
				<NeedsLine>
					the line §6's Safe to spend gains (drawn as R1: “minus the month's
					savings goal”), and how Home says it when the goal takes Safe to spend
					below $0 (with B1's wording).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option R1 · All of it, from day one",
							note: sum(SAFE_R1, [GOAL, "goal"]),
							tradeoff:
								"moving the $200 changes nothing, so saving can feel like nothing happened.",
							recommended:
								"simple and safe: it never counts on savings not yet made, and needs nothing from the bank.",
							screen: goalRule(
								SAFE_R1,
								aMonth(GOAL),
								"Set aside from Safe to spend",
							),
						},
						{
							name: "Option R2 · Only what's still to move",
							note: sum(SAFE_R2, [GOAL - MOVED, "still to move"]),
							tradeoff: `Tally must tell transfers to savings from other transfers, and saving raises Safe to spend by what you move (${dollars(SAFE_R1)} to ${dollars(SAFE_R2)}), which reads backwards.`,
							screen: goalRule(
								SAFE_R2,
								<>
									{dollars(GOAL - MOVED)} <span class="text-muted">to go</span>
								</>,
								`${dollars(MOVED)} moved Oct 1, of ${dollars(GOAL)} a month`,
							),
						},
						{
							name: "Option R3 · Like a bill on a chosen day",
							note: `Due the 15th, so it's set aside from Oct 8 until a transfer is linked. Today: ${dollars(SAFE_R3)}.`,
							tradeoff: `Safe to spend drops ${dollars(GOAL)} overnight on Oct 8, and reads ${dollars(GOAL)} too high until then.`,
							screen: goalRule(
								SAFE_R3,
								aMonth(GOAL),
								"Set aside from Oct 8, a week before the 15th",
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p55-planned"
				title="P55 · Planned one-time expenses"
				tier="visual"
				sentence="Money set aside in a month for a known one-off cost, like Car registration, $180, in October. Pick where it's planned and how it shows."
			>
				<Fixed>
					money set aside in a month for a known one-off cost (§8.4). Safe to
					spend already sets aside bills that are due and not paid, and a
					payment is linked to a bill by the matcher or by hand (§6, §6.1).
				</Fixed>
				<NeedsLine>
					how it enters Safe to spend: like a due bill for its whole month
					(drawn), or only once its date is near (it would need a day, not just
					a month); what happens if its month ends before it's paid; and its
					table in §5.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Planned, on Bills",
							note: "A Planned group after Upcoming, and “Plan an expense” beside Add a bill, which opens the sheet drawn next.",
							tradeoff: `one more kind of thing on Bills, and once paid its category reads “${dollars(CAR.spentCents + PLANNED - CAR.budgetCents)} over” though planned.`,
							recommended:
								"it behaves like a bill that happens once: set aside all its month, until a payment is linked.",
							screen: plannedBills,
						},
						{
							name: "Option A · Planning one",
							note: "The sheet: what it's for, the amount and the month, picked as Add a bill picks its month. A payment is linked on its page, as on a bill's.",
							screen: planSheet,
						},
						{
							name: "Option B · Planned this month, on Home",
							note: "A list under the Budget, like Bills due soon, with “+ Plan an expense” after it; set aside as in A.",
							tradeoff:
								"under every budget row it's off a phone's first screen (drawn here with only two rows so it shows), and it has no place for later months.",
							screen: plannedHome,
						},
						{
							name: "Option C · A one-month budget bump",
							note: "Car & Transport gets $180 more for October only, with a line saying why.",
							tradeoff: `the total budget rises, so Safe to spend goes up ${dollars(PLANNED)} until it's paid, the opposite of setting it aside.`,
							screen: bumpHome,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p56-reconnect-email"
				title="P56 · The reconnect reminder email"
				tier="visual"
				sentence="An email when a bank needs signing in again, so sync doesn't stop unnoticed. Each picture is the email itself, as it reads on a phone."
			>
				<Fixed>
					an email when a bank needs signing in again; how Tally sends email is
					its own decision (§8.4). Fix connection lives on Accounts (§8, §10),
					and Home flags a bank that needs attention or hasn't synced for 3 days
					(§8.5).
				</Fixed>
				<NeedsLine>
					who it goes to (every family email in Cloudflare Access, one address
					set in Settings, or whoever linked the bank, which §5 already stores
					as linked_by) and how often it repeats (drawn: once, then every 3 days
					until it's fixed); and, as logs never do (§10), no email carries
					amounts or transaction details.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Short and plain",
							note: "What's wrong, why it matters, and one link to Accounts. No amounts or transaction details.",
							tradeoff: "it doesn't say which accounts; Accounts does.",
							recommended:
								"it says what's wrong and gives one action, and nothing about your accounts leaves Tally.",
							family: true,
							screen: emailPlain,
						},
						{
							name: "Option B · With a little detail",
							note: "Adds the accounts behind the login and the exact time it last synced.",
							tradeoff:
								"more to read, and account endings in an inbox, though still no amounts.",
							family: true,
							screen: emailDetail,
						},
						{
							name: "Option C · A weekly digest",
							note: "One email on Mondays, listing every bank that needs signing in again and since when.",
							tradeoff:
								"fewer emails, but a bank can be stuck for up to a week before you hear.",
							family: true,
							screen: emailDigest,
						},
						{
							name: "Both · Settings",
							note: "A Reminders section after Categories: the email switch, On or Off in words with a button that turns it, and the address it goes to (drawn for one address).",
							family: true,
							screen: reminderSettings,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
