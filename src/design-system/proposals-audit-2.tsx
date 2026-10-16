// P130–P133 (issues #603, #604 and #605): the second design audit's picks, each option drawn as the
// screens it changes, beside today's, so the owner decides by seeing (decision 47). Every picture is
// inert and labelled, like the rest of the page. The numbers are the local demo's as it shows them on
// Thursday, Oct 15: Streaming's months, Bills' rows, September's result and the month strip. Where the
// app has a component that draws the part, the real one draws it (BillRow, BillStatusHeading,
// BillMonthlyTotal, BillOccurrenceRow, WhyLink, TrendsTop, TrendGroup, TrendRow, MonthNavigation,
// MonthEnd, PastNotBudgeted). Where an option changes a part that the app's component doesn't take
// (a heading without its Why?, a month's dot with its mark, a sentence between a month's stamp and its
// bars), or where a real component has a fixed id that a page can't repeat (PlanBand), the picture
// is a prototype here, drawn with the same classes; src/views stays as it is.

import type { Child } from "hono/jsx";
import type { CategorySummary } from "../budget";
import { monthName, monthsBefore, shortDay } from "../dates";
import { formatCents } from "../money";
import type { MonthPoint } from "../trends";
import {
	BillOccurrenceRow,
	type OccurrencePayment,
} from "../views/bill-occurrence-row";
import {
	BillMonthlyTotal,
	BillRow,
	type BillRowData,
	BillStatusHeading,
} from "../views/bill-row";
import { Button } from "../views/button";
import { Icon, ROW_OPENS, RowArrow } from "../views/icons";
import { MonthEnd, monthEndLabels, PastNotBudgeted } from "../views/month-end";
import { MonthNavigation } from "../views/month-navigation";
import { TrendGroup, TrendRow, TrendsTop } from "../views/trends";
import { WhyLink, type WhySection } from "../views/why-link";
import { Fixed } from "./proposal-parts";
import { EndBars } from "./proposals-phase5-picks";
import { Choice, Choices, Desk, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// The demo, on Thursday Oct 15 (the local demo's own numbers).

const TODAY = "2026-10-15";
const CURRENT = "2026-10";
const dollars = (cents: number) => formatCents(cents, { wholeDollars: true });

type Group = "overdue" | "due";

const ELECTRIC: BillRowData = {
	id: 3,
	name: "Electric",
	amountCents: 14200,
	status: "overdue",
	dueDate: "2026-10-14",
	icon: "bills",
	color: "",
};
const NETFLIX: BillRowData = {
	id: 4,
	name: "Netflix",
	amountCents: 1549,
	status: "overdue",
	dueDate: "2026-10-14",
	icon: "bills",
	color: "",
	priceOffer: { amountCents: 1799, date: "2026-10-14" },
};
const RENT: BillRowData = {
	id: 9,
	name: "Rent",
	amountCents: 120000,
	status: "overdue",
	dueDate: "2026-10-01",
	paidCents: 60000,
	icon: "bills",
	color: "",
};
const INTERNET: BillRowData = {
	id: 5,
	name: "Internet",
	amountCents: 6500,
	status: "due",
	dueDate: "2026-10-18",
	icon: "bills",
	color: "",
};
const DAYCARE: BillRowData = {
	id: 8,
	name: "Daycare",
	amountCents: 24000,
	status: "due",
	dueDate: "2026-10-16",
	frequency: "weekly",
	dueDay: 5,
	icon: "bills",
	color: "",
};

/** Streaming's months as its page lists them, newest first (bills.tsx's billPeriods). */
type Month = {
	period: string;
	month: string;
	status: "upcoming" | "paid" | "not-paid";
	due: string;
	/** A charge Tally found that matches this month and asks to be linked (the demo's lookalike). */
	charge?: boolean;
};
const STREAMING: Month[] = [
	{ period: "2026-12", month: "December", status: "upcoming", due: "Dec 15" },
	{ period: "2026-11", month: "November", status: "upcoming", due: "Nov 15" },
	{ period: "2026-10", month: "October", status: "paid", due: "Oct 15" },
	{
		period: "2026-09",
		month: "September",
		status: "not-paid",
		due: "Sep 15",
		charge: true,
	},
	{ period: "2026-08", month: "August", status: "not-paid", due: "Aug 15" },
	{ period: "2026-07", month: "July", status: "not-paid", due: "Jul 15" },
	{ period: "2026-06", month: "June", status: "not-paid", due: "Jun 15" },
	{ period: "2026-05", month: "May", status: "not-paid", due: "May 15" },
	{ period: "2026-04", month: "April", status: "not-paid", due: "Apr 15" },
];
const OCTOBER_PAYMENT: OccurrencePayment = {
	transactionId: 77,
	displayName: "Apple.com/bill",
	dateLabel: "Oct 15",
	amountCents: 299,
	matchedBy: "auto",
};
/**
 * The demo's Apple.com/bill lookalike (seed.ts's streaming block): eight days after the prior month's
 * due day, which is min(16, today's day). On Oct 15 that is Sep 23.
 */
const LOOKALIKE = shortDay(
	`${monthsBefore(CURRENT, 1)}-${String(Math.min(16, Number(TODAY.slice(8, 10))) + 8).padStart(2, "0")}`,
	TODAY,
);

/** A category with a budget, as September's bars show it. */
type BudgetRow = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};
/** A category with no budget, as Not budgeted lists it. */
type Unbudgeted = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
};

const SEP_BUDGETS: BudgetRow[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 67200,
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 26200,
		budgetCents: 25000,
	},
	{
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents: 17600,
		budgetCents: 20000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 32000,
		budgetCents: 30000,
	},
	{
		name: "Household",
		icon: "household",
		color: "cat-ochre",
		spentCents: 24447,
		budgetCents: 25000,
	},
];
const SEP_UNBUDGETED: Unbudgeted[] = [
	{ name: "Childcare", icon: "kids", color: "cat-blue", spentCents: 96000 },
	{ name: "Rent", icon: "rent", color: "cat-slate", spentCents: 120000 },
];
/** A sample month, with numbers of its own (not the demo's): Eating Out and Kids over, all else under. */
const SAMPLE_BUDGETS: BudgetRow[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 67200,
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 43000,
		budgetCents: 25000,
	},
	{
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents: 17600,
		budgetCents: 20000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 34000,
		budgetCents: 30000,
	},
];

/**
 * The demo's months, from its budgets and all its counted spending, Not budgeted included (spec §6, "How a
 * finished month ended"). A null month had no budgets: April, before any budget was set, is a sample of
 * one. October is so far, so its spending is to date. August's spending is its budgeted rows ($1,556.48)
 * and the $277.11 in Needs a category, which Home counts toward its result too: it ends $134 over.
 */
const MONTHS: Record<
	string,
	{ budgetCents: number; spentCents: number } | null
> = {
	"2026-04": null,
	"2026-05": { budgetCents: 165000, spentCents: 134000 },
	"2026-06": { budgetCents: 165000, spentCents: 155200 },
	"2026-07": { budgetCents: 165000, spentCents: 133500 },
	"2026-08": { budgetCents: 170000, spentCents: 183359 },
	"2026-09": { budgetCents: 170000, spentCents: 383447 },
	"2026-10": { budgetCents: 394000, spentCents: 166531 },
};
const FIRST_MONTH = "2026-05";
const STRIP_MONTHS = [
	"2026-04",
	"2026-05",
	"2026-06",
	"2026-07",
	"2026-08",
	"2026-09",
	"2026-10",
];

const GROCERIES_MONTHS: MonthPoint[] = [
	{ month: "2026-05", cents: 64000, partial: false },
	{ month: "2026-06", cents: 65500, partial: false },
	{ month: "2026-07", cents: 61000, partial: false },
	{ month: "2026-08", cents: 69000, partial: false },
	{ month: "2026-09", cents: 67200, partial: false },
	{ month: "2026-10", cents: 8410, partial: true },
];
const EATING_MONTHS: MonthPoint[] = [
	{ month: "2026-05", cents: 17000, partial: false },
	{ month: "2026-06", cents: 19500, partial: false },
	{ month: "2026-07", cents: 21500, partial: false },
	{ month: "2026-08", cents: 24000, partial: false },
	{ month: "2026-09", cents: 26200, partial: false },
	{ month: "2026-10", cents: 26400, partial: true },
];

// ---------------------------------------------------------------------------------------------
// The cause sentence (P132 A): from integer cents, the two largest causes by amount.

/** One cause of a month's overspend: an over-budget category (its amount over) or an unbudgeted one (its spending). */
export type Cause = { name: string; cents: number; budgeted: boolean };

/**
 * The sentence that names a month's cause in one line, or "" when there is none. It takes the two
 * largest causes by amount (ties keep the order given; a cause of $0 or less, such as a refund, is no
 * cause), and says "Most of it" only when those two
 * are over half of the month's overspend, "Part of it" otherwise. When both are unbudgeted it says
 * so once, when both are over budget once, and when they mix each names its own.
 */
export function monthCause(causes: Cause[], overCents: number): string {
	const largest = causes
		.filter((cause) => cause.cents > 0)
		.map((cause, index) => ({ cause, index }))
		.sort((a, b) => b.cause.cents - a.cause.cents || a.index - b.index)
		.slice(0, 2)
		.sort((a, b) => a.index - b.index)
		.map(({ cause }) => cause);
	if (largest.length === 0) return "";
	const shareCents = largest.reduce((sum, cause) => sum + cause.cents, 0);
	const lead = shareCents * 2 > overCents ? "Most of it" : "Part of it";
	const amount = (cause: Cause) => `${cause.name} ${dollars(cause.cents)}`;
	if (largest.every((cause) => !cause.budgeted))
		return `${lead} had no budget: ${largest.map(amount).join(" and ")}.`;
	if (largest.every((cause) => cause.budgeted))
		return `${lead} was over budget: ${largest.map(amount).join(" and ")}.`;
	const each = largest.map((cause) =>
		cause.budgeted
			? `${amount(cause)} over`
			: `${amount(cause)} with no budget`,
	);
	return `${lead}: ${each.join(" and ")}.`;
}

/** The causes of a month's overspend: each over-budget category by how far over, then each unbudgeted one by its spending (only spending above $0). */
function causesOf(rows: BudgetRow[], unbudgeted: Unbudgeted[]): Cause[] {
	return [
		...rows
			.filter((row) => row.spentCents > row.budgetCents)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents - row.budgetCents,
				budgeted: true,
			})),
		...unbudgeted
			.filter((row) => row.spentCents > 0)
			.map((row) => ({
				name: row.name,
				cents: row.spentCents,
				budgeted: false,
			})),
	];
}

// ---------------------------------------------------------------------------------------------
// A finished month's result, as Home works it out (budget.ts): its budgets less all its counted
// spending, Not budgeted included, so a refund in a category counts back.

/** A month's result in integer cents from its rows: positive is under budget, negative is over. */
function resultCents(rows: BudgetRow[], unbudgeted: Unbudgeted[]): number {
	const budget = rows.reduce((sum, row) => sum + row.budgetCents, 0);
	const spent = rows.reduce((sum, row) => sum + row.spentCents, 0);
	return (
		budget - spent - unbudgeted.reduce((sum, row) => sum + row.spentCents, 0)
	);
}

/** A strip month's result in cents, or null for a month with no budgets. */
function resultOf(item: string): number | null {
	const month = MONTHS[item] ?? null;
	return month ? month.budgetCents - month.spentCents : null;
}

/** A strip month's link name for a screen reader: its result in words, no budgets, or so far. */
function monthWords(item: string): string {
	const label = monthName(item);
	if (item === CURRENT) return `${label}, so far`;
	const result = resultOf(item);
	if (result === null) return `${label}, no budgets`;
	return `${label}, ended ${dollars(Math.abs(result))} ${result < 0 ? "over" : "under"}`;
}

/** What a strip month's mark says: under or over its budgets, no budgets, or the current month. */
function stateOf(item: string): "under" | "over" | "empty" | "current" {
	if (item === CURRENT) return "current";
	const result = resultOf(item);
	if (result === null) return "empty";
	return result < 0 ? "over" : "under";
}

// ---------------------------------------------------------------------------------------------
// P130: Bills' top and Trends' top.

/** A group's heading's look, as BillStatusHeading draws it. */
const GROUP_LOOK: Record<
	Group,
	{ text: string; icon: "alert" | "bills"; tone: string }
> = {
	overdue: { text: "Overdue", icon: "alert", tone: "text-over" },
	due: { text: "Due in the next 7 days", icon: "bills", tone: "text-ink" },
};

/** A group's heading with `why` beside it (B's quiet link) or none (A): BillStatusHeading without its WhyLink. */
function GroupHeading({
	group,
	totalCents,
	why,
}: {
	group: Group;
	totalCents: number;
	why?: Child;
}) {
	const look = GROUP_LOOK[group];
	return (
		<div class="flex items-center gap-2 text-sm text-muted">
			<h2 class="flex min-w-0 items-center gap-2">
				<span class={look.tone}>
					<Icon name={look.icon} class="size-4" />
				</span>
				{look.text}
			</h2>
			{why && (
				<>
					<span aria-hidden="true">·</span>
					{why}
				</>
			)}
			<span class="ml-auto shrink-0">{formatCents(totalCents)}</span>
		</div>
	);
}

/** B's Why?: the same link to its section of How Tally works, in muted words, underlined only on hover and focus. */
function QuietWhy({ section, topic }: { section: WhySection; topic: string }) {
	return (
		<a
			href={`/how-it-works#${section}`}
			aria-label={`Why? ${topic}`}
			class="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-muted no-underline hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
		>
			Why?
		</a>
	);
}

/** The summary line under the title, as the route draws it; A's One Why sits at its end. */
function Summary({ why }: { why?: boolean }) {
	return (
		<p class="mt-2 flex flex-wrap items-center gap-x-2 font-serif text-lg italic">
			5 bills to pay soon, $1,062.49 in all
			{why && (
				<>
					<span aria-hidden="true" class="not-italic">
						·
					</span>
					<span class="font-sans not-italic">
						<WhyLink section="bills" topic="bills to pay soon" />
					</span>
				</>
			)}
		</p>
	);
}

/**
 * PlanBand as the route draws it (planned-expense.tsx), with its heading's id made per picture: the
 * real one has one fixed id, and a page can't repeat it across pictures.
 */
function PlanBandPicture({ idPrefix }: { idPrefix: string }) {
	return (
		<section
			class="mt-3 bg-band px-4 py-3"
			aria-labelledby={`${idPrefix}-plan-title`}
		>
			<p class="text-lg" id={`${idPrefix}-plan-title`}>
				Car registration wasn't paid
			</p>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<form method="post" action="/plans/1/move">
					<Button type="submit" busyLabel="Moving…">
						Move to Oct
					</Button>
				</form>
				<form method="post" action="/plans/1/drop">
					<Button kind="secondary" type="submit" busyLabel="Dropping…">
						Drop
					</Button>
				</form>
				<span class="ml-auto flex items-center gap-1.5">
					<span aria-hidden="true" class="size-2.5 rounded-full bg-ink" />
					<span class="sr-only">1 of 1 planned expenses that weren't paid</span>
				</span>
			</div>
		</section>
	);
}

/** Bills' top, from its title to the second section, as the route draws it; `heading` draws each group. */
function BillsTop({
	idPrefix,
	why,
	heading,
}: {
	idPrefix: string;
	why?: boolean;
	heading: (group: Group, totalCents: number) => Child;
}) {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Bills</h1>
			<Summary why={why} />
			<BillMonthlyTotal
				monthlyCents={248500}
				stillToPayCents={154200}
				month={CURRENT}
			/>
			<PlanBandPicture idPrefix={idPrefix} />
			<div class="mt-3 flex flex-wrap gap-3">
				<Button kind="secondary" href="/bills/new">
					Add a bill
				</Button>
				<Button kind="secondary" href="/plans/new">
					Plan an expense
				</Button>
			</div>
			<div class="mt-4">
				{heading("overdue", 75749)}
				<ul class="divide-y divide-rule">
					<BillRow bill={ELECTRIC} today={TODAY} href="/bills/3" />
					<BillRow bill={NETFLIX} today={TODAY} href="/bills/4" />
					<BillRow bill={RENT} today={TODAY} href="/bills/9" />
				</ul>
			</div>
			<div class="mt-4">
				{heading("due", 30500)}
				<ul class="divide-y divide-rule">
					<BillRow bill={INTERNET} today={TODAY} href="/bills/5" />
					<BillRow bill={DAYCARE} today={TODAY} href="/bills/8" />
				</ul>
			</div>
		</>
	);
}

type TrendsMode = "today" | "a" | "b";

/**
 * One of Trends' two groups: TrendGroup as the route draws it, with its terracotta Why? beside the title
 * (today) or none (A). B draws the same markup with a muted Why? instead.
 */
function TrendsGroup({
	mode,
	id,
	title,
	icon,
	tone,
	topic,
	children,
}: {
	mode: TrendsMode;
	id: string;
	title: string;
	icon: "check" | "arrow-up";
	tone: "text-ok" | "text-ink";
	topic: string;
	children?: Child;
}) {
	if (mode !== "b")
		return (
			<TrendGroup
				id={id}
				title={title}
				icon={icon}
				tone={tone}
				why={mode === "today" ? topic : undefined}
			>
				{children}
			</TrendGroup>
		);
	return (
		<section aria-labelledby={`${id}-title`}>
			<div class="mt-3 flex items-center gap-2 text-sm text-muted">
				<h2 id={`${id}-title`} class="flex items-center gap-2">
					<span class={tone}>
						<Icon name={icon} class="size-4" />
					</span>
					{title}
				</h2>
				<span aria-hidden="true">·</span>
				<QuietWhy section="trends" topic={topic} />
			</div>
			<ul class="divide-y divide-rule border-y border-rule">{children}</ul>
		</section>
	);
}

/**
 * Trends' top at 390: the headline, then Going well and Worth a look. The Why? links are "today" beside the
 * headline and each group, "a" beside the headline only, and "b" muted beside the headline and each group.
 */
function TrendsPicture({
	idPrefix,
	mode,
}: {
	idPrefix: string;
	mode: TrendsMode;
}) {
	const sentence = "$339 less than by this time in September.";
	return (
		<>
			{mode === "b" ? (
				<>
					<TrendsTop month="October" spent="$1,665" />
					<p class="mt-1 flex flex-wrap items-center gap-x-2 font-serif text-lg italic">
						{sentence}
						<span class="font-sans not-italic">
							<QuietWhy section="trends" topic="this month against last" />
						</span>
					</p>
				</>
			) : (
				<TrendsTop month="October" spent="$1,665" sentence={sentence} />
			)}
			<TrendsGroup
				mode={mode}
				id={`${idPrefix}-well`}
				title="Going well"
				icon="check"
				tone="text-ok"
				topic="going well"
			>
				<TrendRow
					id={`${idPrefix}-groceries`}
					name="Groceries"
					icon="groceries"
					color="cat-blue"
					line="5 months under budget"
					months={GROCERIES_MONTHS}
					label="Spending by month: May $640, June $655, July $610, August $690, September $672, October so far $84."
				/>
			</TrendsGroup>
			<TrendsGroup
				mode={mode}
				id={`${idPrefix}-look`}
				title="Worth a look"
				icon="arrow-up"
				tone="text-ink"
				topic="worth a look"
			>
				<TrendRow
					id={`${idPrefix}-eating`}
					name="Eating Out"
					icon="eating-out"
					color="cat-plum"
					line="Up 4 months running"
					months={EATING_MONTHS}
					label="Spending by month: May $170, June $195, July $215, August $240, September $262, October so far $264."
				/>
			</TrendsGroup>
		</>
	);
}

/** B's group headings: each keeps its link, muted. */
function quietHeading(group: Group, totalCents: number) {
	return (
		<GroupHeading
			group={group}
			totalCents={totalCents}
			why={
				<QuietWhy
					section="bills"
					topic={GROUP_LOOK[group].text.toLowerCase()}
				/>
			}
		/>
	);
}

/** A's group headings: no link of their own. */
function plainHeading(group: Group, totalCents: number) {
	return <GroupHeading group={group} totalCents={totalCents} />;
}

/** Today's group headings: the real BillStatusHeading, with its terracotta Why?. */
function todayHeading(group: Group, totalCents: number) {
	return <BillStatusHeading status={group} totalCents={totalCents} />;
}

// ---------------------------------------------------------------------------------------------
// P131: a bill's page, Streaming.

/** Today's head, as the route draws it: the bank's text above the name, the name at 5xl. */
function TodayHead() {
	return (
		<>
			<p class="text-sm text-muted">APPLE.COM/BILL</p>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Streaming
			</h1>
			<p class="text-lg">$2.99 a month, due the 15th</p>
		</>
	);
}

/** P120 B's head (decision 111): the name as the one headline, its amount in muted words, the bank's text small under it. */
function QuietHead() {
	return (
		<div class="flex flex-col gap-1">
			<h1 class="font-serif text-3xl font-semibold tracking-tight">
				Streaming
			</h1>
			<p class="text-muted">$2.99 a month, due the 15th</p>
			<p class="text-sm text-muted">APPLE.COM/BILL</p>
		</div>
	);
}

/** The page's rest: Edit bill and Deactivate, and the footnote about Not this one. */
function BillFooter() {
	return (
		<>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<Button kind="secondary" href="/bills/1/edit">
					Edit bill
				</Button>
				<form method="post" action="/bills/1/deactivate">
					<Button kind="text" type="submit">
						Deactivate
					</Button>
				</form>
			</div>
			<p class="mt-6 border-t border-rule pt-3 text-sm text-muted">
				&quot;Not this one&quot; unlinks a payment, and Tally won&#39;t suggest
				it again for that month.
			</p>
		</>
	);
}

/** A bill's page from its back link to its footer, with its head and what sits under the head. */
function BillPage({ head, children }: { head: Child; children?: Child }) {
	return (
		<>
			<a href="/bills" class="inline-flex min-h-11 items-center">
				Bills
			</a>
			{head}
			{children}
			<BillFooter />
		</>
	);
}

/** The Payments heading and its list, as the route draws them. */
function Payments({ children }: { children?: Child }) {
	return (
		<>
			<h2 class="mt-6 text-sm text-muted">Payments</h2>
			<ul class="divide-y divide-rule border-y border-rule">{children}</ul>
		</>
	);
}

/** Today's months, one BillOccurrenceRow each, as the route lists them. */
function TodayMonths() {
	return (
		<>
			{STREAMING.map((m) => (
				<BillOccurrenceRow
					billId={1}
					period={m.period}
					label={`${m.month} · $2.99`}
					status={m.status}
					payments={m.status === "paid" ? [OCTOBER_PAYMENT] : []}
					paidCents={m.status === "paid" ? 299 : 0}
					amountCents={299}
				/>
			))}
		</>
	);
}

/** One month as a quiet ruled row that opens its picker, ending in the small muted arrow (P118 A). */
function LedgerRow({
	id,
	period,
	month,
	detail,
	mark,
}: {
	id?: string;
	period: string;
	month: string;
	detail: string;
	/** A status mark before the month's name (October's check). */
	mark?: Child;
}) {
	return (
		<li id={id}>
			<a
				href={`/bills/1/occurrences/${period}/link#payment-picker`}
				class={`flex min-h-11 items-center gap-3 py-2 text-ink no-underline ${ROW_OPENS}`}
			>
				{mark}
				<span class="min-w-0 flex-1 text-lg">{month}</span>
				<span class="text-sm text-muted">{detail}</span>
				<RowArrow />
			</a>
		</li>
	);
}

/**
 * A (P131): each month one ruled row. A charge Tally found is a row of its own, with Link it; the months
 * nothing was paid fold into one row, April to August, that opens to its five muted rows.
 */
function LedgerMonths({ opened }: { opened: boolean }) {
	const charge = STREAMING.find((m) => m.charge);
	const quiet = STREAMING.filter((m) => m.status === "not-paid" && !m.charge);
	return (
		<>
			{STREAMING.filter((m) => m.status === "upcoming").map((m) => (
				<LedgerRow
					period={m.period}
					month={m.month}
					detail={`Due ${m.due} · $2.99`}
				/>
			))}
			<LedgerRow
				period="2026-10"
				month="October"
				detail="Paid Oct 15 · $2.99"
				mark={
					<span class="text-ok">
						<Icon name="check" class="size-4" />
					</span>
				}
			/>
			{charge && (
				<li>
					<a
						href={`/bills/1/occurrences/${charge.period}/link#payment-picker`}
						class={`flex min-h-11 items-center gap-3 py-2 text-ink no-underline ${ROW_OPENS}`}
					>
						<span class="min-w-0 flex-1">
							<span class="block text-lg">{charge.month}</span>
							<span class="block text-sm text-muted">
								A $2.99 charge on {LOOKALIKE} looks like this
							</span>
						</span>
						<span class="text-accent">Link it</span>
						<RowArrow />
					</a>
				</li>
			)}
			<li class="py-2">
				<details class="group" open={opened}>
					<summary
						class={`flex min-h-11 cursor-pointer list-none items-center gap-3 text-ink ${ROW_OPENS}`}
					>
						<span class="min-w-0 flex-1 text-lg">April to August</span>
						<span class="text-sm text-muted">No payment</span>
						<RowArrow class="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
					</summary>
					<ul class="divide-y divide-rule">
						{quiet.map((m) => (
							<LedgerRow
								period={m.period}
								month={m.month}
								detail="Link a payment"
							/>
						))}
					</ul>
				</details>
			</li>
		</>
	);
}

/** B's strip: April to next March, each month's initial and mark; a month with a row below is a link to it. */
const YEAR = [
	"2026-04",
	"2026-05",
	"2026-06",
	"2026-07",
	"2026-08",
	"2026-09",
	"2026-10",
	"2026-11",
	"2026-12",
	"2027-01",
	"2027-02",
	"2027-03",
];
const INITIALS = "JFMAMJJASOND";

/** The months that need a line of their own: each unpaid one, the due ones and the past ones with no payment. */
const needsRow = (period: string) =>
	STREAMING.some((m) => m.period === period && m.status !== "paid");

/** A month's status in words, as the year strip says it to a screen reader. */
function yearStatus(period: string): "paid" | "due" | "no payment linked" {
	const status = STREAMING.find((m) => m.period === period)?.status;
	if (status === "paid") return "paid";
	// The two upcoming months, and January to March, are still to come.
	if (status === "upcoming" || period > CURRENT) return "due";
	return "no payment linked";
}

function YearStrip({ idPrefix }: { idPrefix: string }) {
	const mark = (period: string) => {
		const status = yearStatus(period);
		if (status === "paid")
			return (
				<span data-mark="paid" class="text-ok">
					<Icon name="check" class="size-4" />
				</span>
			);
		// A ring for the months still to come, a dash for an unpaid past month.
		if (status === "due")
			return (
				<span data-mark="due" class="size-3 rounded-full border-2 border-ink" />
			);
		return <span data-mark="none" class="h-0.5 w-3 bg-muted" />;
	};
	const look =
		"flex min-h-11 w-7 flex-col items-center justify-center gap-1 text-sm text-ink no-underline";
	return (
		<ol class="mt-4 flex justify-between">
			{YEAR.map((period) => {
				const cell = (
					<>
						<span aria-hidden="true">
							{INITIALS[Number(period.slice(5)) - 1]}
						</span>
						{mark(period)}
						<span class="sr-only">{`${monthName(period)}, ${yearStatus(period)}`}</span>
					</>
				);
				return (
					<li>
						{needsRow(period) ? (
							<a href={`#${idPrefix}-${period}`} class={look}>
								{cell}
							</a>
						) : (
							<span class={look}>{cell}</span>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/** B's list: only the months that need something, newest first, each a quiet row. */
function YearMonths({ idPrefix }: { idPrefix: string }) {
	return (
		<>
			{[...STREAMING]
				.filter((m) => m.status !== "paid")
				.map((m) => (
					<LedgerRow
						id={`${idPrefix}-${m.period}`}
						period={m.period}
						month={m.month}
						detail={
							m.status === "upcoming"
								? `Due ${m.due} · $2.99`
								: "Link a payment"
						}
					/>
				))}
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P132: a finished month's result.

/** The categories as MonthEnd takes them: each budget and spending, and whether it went over. */
function summaries(rows: BudgetRow[]): CategorySummary[] {
	return rows.map((row, index) => ({
		id: index,
		name: row.name,
		budgetCents: row.budgetCents,
		spentCents: row.spentCents,
		leftCents: row.budgetCents - row.spentCents,
		over: row.spentCents > row.budgetCents,
	}));
}

/** EndBars' rows: each budgeted category with its short label, as MonthEnd gives them. */
function barRows(rows: BudgetRow[]) {
	const labels = monthEndLabels(rows.map((row) => row.name));
	return rows.map((row, index) => ({
		...row,
		short: labels[index] ?? row.name,
	}));
}

/** MonthEnd's brick stamp, drawn for an option that keeps it. */
function OverStamp() {
	return (
		<span class="inline-block -rotate-3 rounded-control border-2 border-over px-3 py-0.5 text-xl font-extrabold tracking-widest text-over uppercase">
			Over
			<span class="sr-only"> budget</span>
		</span>
	);
}

/** Today's month: MonthEnd and Not budgeted, as the app draws them, with no sentence. */
function TodayMonth({ chartId }: { chartId: string }) {
	return (
		<>
			<MonthNavigation
				month="2026-09"
				firstMonth="2026-05"
				currentMonth={CURRENT}
			/>
			<MonthEnd
				chartId={chartId}
				monthName="September"
				amountCents={resultCents(SEP_BUDGETS, SEP_UNBUDGETED)}
				rows={summaries(SEP_BUDGETS)}
			/>
			<PastNotBudgeted items={SEP_UNBUDGETED} />
		</>
	);
}

/** A: the number and stamp, then one muted sentence naming the cause (linked to Not budgeted), then the bars. */
function CauseMonth({
	idPrefix,
	name,
	rows,
	unbudgeted,
}: {
	idPrefix: string;
	name: string;
	rows: BudgetRow[];
	unbudgeted: Unbudgeted[];
}) {
	const overCents = -resultCents(rows, unbudgeted);
	const sentence = monthCause(causesOf(rows, unbudgeted), overCents);
	const linked = unbudgeted.length > 0;
	return (
		<>
			<p class="mt-4 text-lg text-muted">{name} ended</p>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<p class="whitespace-nowrap font-serif text-6xl font-semibold tracking-tight text-over">
					{dollars(overCents)}
				</p>
				<OverStamp />
			</div>
			<p class="mt-2 text-muted">
				{linked ? (
					<a
						href={`#${idPrefix}-not-budgeted`}
						class="inline-flex min-h-11 items-center text-muted underline underline-offset-4"
					>
						{sentence}
					</a>
				) : (
					sentence
				)}
			</p>
			<EndBars rows={barRows(rows)} />
			{linked && (
				<div id={`${idPrefix}-not-budgeted`}>
					<PastNotBudgeted items={unbudgeted} />
				</div>
			)}
		</>
	);
}

/** B: the headline is how the budgets did, with the stamp that matches the bars, and one line says what had no budget. */
function SplitMonth({
	idPrefix,
	rows,
	unbudgeted,
}: {
	idPrefix: string;
	rows: BudgetRow[];
	unbudgeted: Unbudgeted[];
}) {
	return (
		<>
			<div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				<p class="font-serif text-3xl font-semibold tracking-tight">
					Two budgets ended $32 over
				</p>
				<OverStamp />
			</div>
			<EndBars rows={barRows(rows)} />
			<p class="mt-2 text-muted">
				And $2,160 went to things with no budget: Childcare and Rent.
			</p>
			<div id={`${idPrefix}-not-budgeted`}>
				<PastNotBudgeted items={unbudgeted} />
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P133: the month dots.

/** The strip's arrows, as MonthNavigation draws them: solid to a month, dashed and faded where there is none. */
function StripArrow({
	direction,
	target,
}: {
	direction: "previous" | "next";
	target?: string;
}) {
	return (
		<span
			aria-hidden="true"
			class={`inline-flex size-11 shrink-0 items-center justify-center rounded-full ${target ? "border border-muted text-ink" : "border border-dashed border-rule text-muted/40"}`}
		>
			<Icon
				name="chevron-right"
				class={`size-6 ${direction === "previous" ? "rotate-180" : ""}`}
			/>
		</span>
	);
}

const abbr = (item: string) => monthName(item).slice(0, 3);

/**
 * The month strip under the title, as MonthNavigation draws it: the arrows, the title and Months' links,
 * each link 44px and named for a screen reader with its result in words. `cell` draws what a link holds.
 */
function MonthStrip({
	month,
	cell,
}: {
	month: string;
	cell: (item: string, shown: boolean) => Child;
}) {
	const previous = month > FIRST_MONTH ? monthsBefore(month, 1) : undefined;
	const next = month < CURRENT ? monthsBefore(month, -1) : undefined;
	return (
		<div>
			<div class="flex items-center gap-3">
				<StripArrow direction="previous" target={previous} />
				<h1 class="font-serif text-2xl font-semibold tracking-tight">
					{monthName(month)}
				</h1>
				<StripArrow direction="next" target={next} />
			</div>
			<nav aria-label="Months" class="mt-2">
				<ol class="flex flex-wrap">
					{STRIP_MONTHS.map((item) => (
						<li>
							<a
								href={`/?month=${item}`}
								aria-current={item === month ? "page" : undefined}
								class="flex min-h-11 w-11 flex-col items-center gap-0.5 text-sm text-muted no-underline"
							>
								{cell(item, item === month)}
								<span class="sr-only">{monthWords(item)}</span>
							</a>
						</li>
					))}
				</ol>
			</nav>
		</div>
	);
}

/** A (marks in outline, as first drawn): a check, a minus or an empty ring in a ringed disc. */
function markedCell(item: string, shown: boolean) {
	const state = stateOf(item);
	const mark =
		state === "under" ? (
			<span data-mark="under" class="text-ok">
				<Icon name="check" class="size-4" />
			</span>
		) : state === "over" ? (
			<svg
				data-mark="over"
				aria-hidden="true"
				viewBox="0 0 16 16"
				class="size-4 text-over"
			>
				<path
					d="M3 8h10"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
				/>
			</svg>
		) : state === "empty" ? (
			<span
				data-mark="empty"
				class="size-3 rounded-full border-2 border-muted"
			/>
		) : (
			<span data-mark="current" class="size-2 rounded-full bg-muted/45" />
		);
	// One ring at most: the current month's accent, as MonthNavigation draws it, else the shown month's ink.
	const ring = state === "current" ? "ring-accent" : shown ? "ring-ink" : "";
	return (
		<>
			<span
				aria-hidden="true"
				class={`flex size-8 items-center justify-center rounded-full border border-rule ${ring ? `ring-2 ${ring} ring-offset-2 ring-offset-paper` : ""}`}
			>
				{mark}
			</span>
			<span aria-hidden="true">{abbr(item)}</span>
		</>
	);
}

/**
 * C (Tally strokes): each finished month is TallyMark's stroke, 4px wide and 24px tall. A month over its
 * budgets is struck through by a brick diagonal, as TallyMark's fifth stroke crosses its four.
 */
function strokesCell(item: string, shown: boolean) {
	const state = stateOf(item);
	const stroke =
		state === "empty" ? (
			<svg
				data-mark="empty"
				aria-hidden="true"
				viewBox="0 0 24 24"
				class="size-6 text-muted"
			>
				<line
					x1="12"
					y1="2"
					x2="12"
					y2="22"
					stroke="currentColor"
					stroke-width="4"
					stroke-linecap="round"
					stroke-dasharray="0 6"
				/>
			</svg>
		) : state === "current" ? (
			// 15 of 31 days is about half the month, so the stroke reaches halfway up, from the bottom.
			<svg
				data-mark="current"
				aria-hidden="true"
				viewBox="0 0 24 24"
				class="size-6 text-muted/45"
			>
				<line
					x1="12"
					y1="14.4"
					x2="12"
					y2="22"
					stroke="currentColor"
					stroke-width="4"
					stroke-linecap="round"
				/>
			</svg>
		) : (
			<svg
				data-mark={state}
				aria-hidden="true"
				viewBox="0 0 24 24"
				class="size-6 text-ink"
			>
				<line
					x1="12"
					y1="2"
					x2="12"
					y2="22"
					stroke="currentColor"
					stroke-width="4"
					stroke-linecap="round"
				/>
				{state === "over" && (
					<line
						x1="4"
						y1="18"
						x2="20"
						y2="6"
						class="text-over"
						stroke="currentColor"
						stroke-width="2.25"
						stroke-linecap="round"
					/>
				)}
			</svg>
		);
	return (
		<>
			<span class="flex h-6 items-end">{stroke}</span>
			<span aria-hidden="true" class={shown ? "text-ink" : ""}>
				{abbr(item)}
			</span>
			<span aria-hidden="true" class={`h-0.5 w-4 ${shown ? "bg-ink" : ""}`} />
		</>
	);
}

/**
 * D (Filled tokens): a 28px disc, green with a check when under, brick with a minus when over, paper with a
 * dashed rim for no budgets, and an ink ring with a dot for the current month.
 */
function tokensCell(item: string, shown: boolean) {
	const state = stateOf(item);
	const disc =
		state === "under"
			? "bg-ok"
			: state === "over"
				? "bg-over"
				: state === "empty"
					? "border border-dashed border-muted bg-paper"
					: "border-2 border-ink bg-paper";
	const mark =
		state === "under" ? (
			<Icon name="check" class="size-4 text-paper" />
		) : state === "over" ? (
			<svg aria-hidden="true" viewBox="0 0 16 16" class="size-4 text-paper">
				<path
					d="M3 8h10"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
				/>
			</svg>
		) : state === "current" ? (
			<span class="size-1.5 rounded-full bg-ink" />
		) : null;
	return (
		<>
			<span
				data-mark={state}
				aria-hidden="true"
				class={`flex size-7 items-center justify-center rounded-full ${disc} ${shown ? "ring-2 ring-ink ring-offset-2 ring-offset-paper" : ""}`}
			>
				{mark}
			</span>
			<span aria-hidden="true" class={shown ? "text-ink" : ""}>
				{abbr(item)}
			</span>
		</>
	);
}

/**
 * E (Mini bars): each finished month's bar is its spent over its budget, to 120%, with a hairline at 100% (25px
 * up a 30px track). The part above the hairline is brick. A month with no budgets is a dotted outline.
 */
function barsCell(item: string, shown: boolean) {
	const state = stateOf(item);
	const month = MONTHS[item] ?? null;
	const height = month
		? Math.round(Math.min(month.spentCents / month.budgetCents, 1.2) * 25)
		: 0;
	const bar =
		state === "empty" ? (
			<rect
				x="0.5"
				y="5"
				width="5"
				height="25"
				fill="none"
				class="stroke-muted"
				stroke-dasharray="2 2"
			/>
		) : (
			<>
				<line
					x1="-2"
					x2="8"
					y1="5"
					y2="5"
					class="stroke-muted"
					stroke-width="0.5"
				/>
				<rect
					x="0"
					y={30 - Math.min(height, 25)}
					width="6"
					height={Math.min(height, 25)}
					class={state === "current" ? "fill-muted/45" : "fill-ink"}
				/>
				{height > 25 && (
					<rect
						x="0"
						y={30 - height}
						width="6"
						height={height - 25}
						class="fill-over"
					/>
				)}
			</>
		);
	return (
		<>
			<svg
				data-mark={state}
				aria-hidden="true"
				viewBox="0 0 6 30"
				class="h-[30px] w-1.5 overflow-visible"
			>
				{bar}
			</svg>
			<span aria-hidden="true" class={shown ? "text-ink" : ""}>
				{abbr(item)}
			</span>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// The section (proposals.tsx draws it under its own heading): P130 to P133, picked on Oct 15 (decision 121).

/** P130 to P133, picked on Oct 15 (decision 121): the Picked section's proposals. */
export function AuditRoundTwoPicks() {
	return (
		<>
			<Specimen
				id="p130-why"
				title="P130 · One Why per page"
				tier="visual"
				sentence="Each section heading on Bills, and Trends' headline and two headings, end in a terracotta Why?, all to the same How Tally works section. Pick where the Why? goes. Each picture is Bills' top at 390 and 1280 px, and Trends' top at 390 px."
			>
				<Fixed>
					Each Why? opens its page's section of How Tally works (decision 65,
					#341); the link itself never changes where a reader lands.
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						note="A Why? after each heading on Bills: Overdue, Due in the next 7 days, Upcoming, Planned and Paid this month, all terracotta. Trends has three, after its headline, Going well and Worth a look."
						width="w-[722px]"
					>
						<Shot caption="Bills' top at 390 px: title to the second section">
							<Phone label="Today, Bills' top" tab="bills">
								<BillsTop idPrefix="p130-today-phone" heading={todayHeading} />
							</Phone>
						</Shot>
						<Shot caption="Bills' top at 1280 px">
							<Desk label="Today, Bills' top" active="bills">
								<BillsTop idPrefix="p130-today-desk" heading={todayHeading} />
							</Desk>
						</Shot>
						<Shot caption="Trends' top at 390 px">
							<Phone label="Today, Trends' top" tab="trends">
								<TrendsPicture idPrefix="p130-today" mode="today" />
							</Phone>
						</Shot>
					</Choice>
					<Choice
						name="Option A · One Why, beside the summary"
						picked
						note="One Why per page, where the page says its sum. Every heading's rule is in How Tally works' Bills section, which the one link opens."
						cost="WhyLink moves; no new component."
						why="five links to one place become one, and terracotta goes back to meaning a real next step."
						width="w-[722px]"
					>
						<Shot caption="Bills' top at 390 px: the one Why? beside the summary">
							<Phone label="Option A, Bills' top" tab="bills">
								<BillsTop idPrefix="p130-a-phone" why heading={plainHeading} />
							</Phone>
						</Shot>
						<Shot caption="Bills' top at 1280 px">
							<Desk label="Option A, Bills' top" active="bills">
								<BillsTop idPrefix="p130-a-desk" why heading={plainHeading} />
							</Desk>
						</Shot>
						<Shot caption="Trends' top at 390 px: the headline keeps its Why?, the two groups lose theirs">
							<Phone label="Option A, Trends' top" tab="trends">
								<TrendsPicture idPrefix="p130-a" mode="a" />
							</Phone>
						</Shot>
					</Choice>
					<Choice
						name="Option B · Quiet Why on the headings"
						note="Every heading keeps its link, but it no longer looks like an action."
						cost="a muted WhyLink variant."
						why="a reader who wonders about one heading still has the link right there."
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="Bills' top at 390 px: each heading's Why? muted">
							<Phone label="Option B, Bills' top" tab="bills">
								<BillsTop idPrefix="p130-b-phone" heading={quietHeading} />
							</Phone>
						</Shot>
						<Shot caption="Bills' top at 1280 px">
							<Desk label="Option B, Bills' top" active="bills">
								<BillsTop idPrefix="p130-b-desk" heading={quietHeading} />
							</Desk>
						</Shot>
						<Shot caption="Trends' top at 390 px: each Why? muted">
							<Phone label="Option B, Trends' top" tab="trends">
								<TrendsPicture idPrefix="p130-b" mode="b" />
							</Phone>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>

			<Specimen
				id="p131-bill-page"
				title="P131 · A bill's page"
				tier="visual"
				sentence="A bill's page lists every month, each with a filled status pill and a terracotta link to add a payment. Pick how the months read. Each picture is Streaming, $2.99 a month, due the 15th, at 390 and 1280 px."
			>
				<Fixed>
					The head is P120 B's (decision 111): the name, its amount in muted
					words, then the bank's text. Every status is a word as well as an
					icon, never colour alone.
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						note="Each month is a block: its month and amount, a filled status pill, the payment or No payment linked yet, and a terracotta Link a payment or Not this one."
						width="w-[722px]"
					>
						<Shot caption="Streaming at 390 px, cut where the picture ends">
							<Phone label="Today, a bill's page" tab="bills">
								<BillPage head={<TodayHead />}>
									<Payments>
										<TodayMonths />
									</Payments>
								</BillPage>
							</Phone>
						</Shot>
						<Shot caption="Streaming at 1280 px">
							<Desk label="Today, a bill's page" active="bills">
								<BillPage head={<TodayHead />}>
									<Payments>
										<TodayMonths />
									</Payments>
								</BillPage>
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option A · A quiet ledger of months"
						picked
						note="Each month is one ruled row, its status in muted words: October · Paid Oct 15 · $2.99 with a small check, or November · Due Nov 15 · $2.99. A charge Tally found is a row of its own, with Link it."
						extra="A charge Tally found asks to be linked; months nothing was paid say so once, instead of 'Not paid' six times."
						cost="BillOccurrenceRow redrawn; the fold is a details."
						why="the page stops reading like six missed bills, and its one repeated link becomes one."
						width="w-[722px]"
					>
						<Shot caption="Streaming at 390 px: April to August folded into one row">
							<Phone label="Option A, a bill's page" tab="bills">
								<BillPage head={<QuietHead />}>
									<Payments>
										<LedgerMonths opened={false} />
									</Payments>
								</BillPage>
							</Phone>
						</Shot>
						<Shot caption="The same at 390 px, with April to August opened">
							<Phone
								label="Option A, a bill's page, with April to August opened"
								tab="bills"
							>
								<BillPage head={<QuietHead />}>
									<Payments>
										<LedgerMonths opened />
									</Payments>
								</BillPage>
							</Phone>
						</Shot>
						<Shot caption="Streaming at 1280 px">
							<Desk label="Option A, a bill's page" active="bills">
								<BillPage head={<QuietHead />}>
									<Payments>
										<LedgerMonths opened={false} />
									</Payments>
								</BillPage>
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option B · A year at a glance"
						note="Under the head, a strip of the bill's months from April to next March. Each cell holds the month's initial and a mark: a check (paid), a ring (due), or a dash (no payment linked)."
						extra="The year reads in one glance; only the months that need you are listed."
						cost="a new strip component; the list filters its months."
						why="a bill is a pattern across months, and a strip shows the pattern."
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="Streaming at 390 px">
							<Phone label="Option B, a bill's page" tab="bills">
								<BillPage head={<QuietHead />}>
									<YearStrip idPrefix="p131-b-phone" />
									<Payments>
										<YearMonths idPrefix="p131-b-phone" />
									</Payments>
								</BillPage>
							</Phone>
						</Shot>
						<Shot caption="Streaming at 1280 px">
							<Desk label="Option B, a bill's page" active="bills">
								<BillPage head={<QuietHead />}>
									<YearStrip idPrefix="p131-b-desk" />
									<Payments>
										<YearMonths idPrefix="p131-b-desk" />
									</Payments>
								</BillPage>
							</Desk>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>

			<Specimen
				id="p132-month-result"
				title="P132 · What a past month's result says"
				tier="visual"
				sentence="A finished month says how it ended, with its stamp and the bars below, and Not budgeted lists the categories with no budget further down. Pick how the result says why. Each picture is September at 390 and 1280 px, and a second month with a budget over."
			>
				<Fixed>
					The number and its Over stamp come from the month's own result, and
					the bars and Not budgeted stay as MonthEnd draws them.
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						note="The stamp, the number and the bars, then further down Not budgeted: Childcare $960 and Rent $1,200. Nothing connects the two."
						width="w-[722px]"
					>
						<Shot caption="September at 390 px: the top of the month">
							<Phone label="Today, September" tab="home">
								<TodayMonth chartId="p132-today-phone" />
							</Phone>
						</Shot>
						<Shot caption="September at 1280 px">
							<Desk label="Today, September" active="home">
								<TodayMonth chartId="p132-today-desk" />
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option A · One line names the cause"
						picked
						note="Under the headline and stamp, one muted sentence: Most of it had no budget: Childcare $960 and Rent $1,200. The sentence links to the Not budgeted list. The stamp, the number and the bars stay."
						extra="Name the two largest causes, from the categories over and the unbudgeted ones, by amount; say Most of it only when they're over half."
						cost="one sentence from numbers MonthEnd already has."
						why="a family looking back sees the cause, not just a big red number."
						width="w-[722px]"
					>
						<Shot caption="September at 390 px: the sentence under the stamp">
							<Phone label="Option A, September" tab="home">
								<MonthNavigation
									month="2026-09"
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
								<CauseMonth
									idPrefix="p132-a-sep"
									name="September"
									rows={SEP_BUDGETS}
									unbudgeted={SEP_UNBUDGETED}
								/>
							</Phone>
						</Shot>
						<Shot caption="September at 1280 px">
							<Desk label="Option A, September" active="home">
								<MonthNavigation
									month="2026-09"
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
								<CauseMonth
									idPrefix="p132-a-desk"
									name="September"
									rows={SEP_BUDGETS}
									unbudgeted={SEP_UNBUDGETED}
								/>
							</Desk>
						</Shot>
						<Shot caption="A second month, with a budgeted category over (sample numbers, not the demo's)">
							<Phone
								label="Option A, a month over budget, sample numbers"
								tab="home"
							>
								<CauseMonth
									idPrefix="p132-a-sample"
									name="March"
									rows={SAMPLE_BUDGETS}
									unbudgeted={[]}
								/>
							</Phone>
						</Shot>
					</Choice>
					<Choice
						name="Option B · Split the result"
						note="The headline becomes how the budgets did: Two budgets ended $32 over, with the bars. Under it, a second line: And $2,160 went to things with no budget: Childcare and Rent."
						cost="changes what the headline number means (a spec change, §6), so it needs a decision entry."
						why="the stamp then matches the bars."
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="September at 390 px: the budgets' result first">
							<Phone label="Option B, September" tab="home">
								<MonthNavigation
									month="2026-09"
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
								<SplitMonth
									idPrefix="p132-b-phone"
									rows={SEP_BUDGETS}
									unbudgeted={SEP_UNBUDGETED}
								/>
							</Phone>
						</Shot>
						<Shot caption="September at 1280 px">
							<Desk label="Option B, September" active="home">
								<MonthNavigation
									month="2026-09"
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
								<SplitMonth
									idPrefix="p132-b-desk"
									rows={SEP_BUDGETS}
									unbudgeted={SEP_UNBUDGETED}
								/>
							</Desk>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>
			<Specimen
				id="p133-month-dots"
				title="P133 · The month dots"
				tier="visual"
				sentence="The strip under the month title marks each finished month. Five looks are drawn, from today's grey disc to marks that say how each month ended. Pick what the marks say. Each picture is the strip at 390 px on October and on September, and at 1280 px."
			>
				<Fixed>
					Each month's link keeps its name for a screen reader, with its result
					in words, never only its mark.
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						note="A grey disc for each finished month, ink for the month shown, and a ring for the current month."
						width="w-[722px]"
					>
						<Shot caption="October at 390 px: the strip under the title">
							<Phone label="Today, the month dots, October" tab="home">
								<MonthNavigation
									month={CURRENT}
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
							</Phone>
						</Shot>
						<Shot caption="September at 390 px">
							<Phone label="Today, the month dots, September" tab="home">
								<MonthNavigation
									month="2026-09"
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
							</Phone>
						</Shot>
						<Shot caption="October at 1280 px">
							<Desk label="Today, the month dots, October" active="home">
								<MonthNavigation
									month={CURRENT}
									firstMonth="2026-05"
									currentMonth={CURRENT}
								/>
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option A · Marks in outline, as first drawn"
						picked
						note="A finished month's dot holds a small mark: a check for under budget, a minus for over, or an empty ring for a month with no budgets. The month's initial stays under it, and the link's name says the result."
						cost="MonthNavigation takes each month's result, which Home already works out for the shown month."
						why="it says something the page knows, and it stays words-first for screen readers."
						width="w-[722px]"
					>
						<Shot caption="October at 390 px: April is the sample month with no budgets, an empty ring">
							<Phone label="Option A, the month dots, October" tab="home">
								<MonthStrip month={CURRENT} cell={markedCell} />
							</Phone>
						</Shot>
						<Shot caption="September at 390 px: the shown month keeps its ink ring">
							<Phone label="Option A, the month dots, September" tab="home">
								<MonthStrip month="2026-09" cell={markedCell} />
							</Phone>
						</Shot>
						<Shot caption="October at 1280 px">
							<Desk label="Option A, the month dots, October" active="home">
								<MonthStrip month={CURRENT} cell={markedCell} />
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option C · Tally strokes"
						note="The strip becomes Tally's own tally: a stroke per month, struck through when it went over."
						cost="MonthNavigation draws strokes from each month's result; no new token"
						why="it ties the month strip to Tally's mark and reads by shape, not colour"
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="October at 390 px: April is the sample month with no budgets">
							<Phone label="Option C, the month dots, October" tab="home">
								<MonthStrip month={CURRENT} cell={strokesCell} />
							</Phone>
						</Shot>
						<Shot caption="September at 390 px">
							<Phone label="Option C, the month dots, September" tab="home">
								<MonthStrip month="2026-09" cell={strokesCell} />
							</Phone>
						</Shot>
						<Shot caption="October at 1280 px: April is the sample month with no budgets">
							<Desk label="Option C, the month dots, October" active="home">
								<MonthStrip month={CURRENT} cell={strokesCell} />
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option D · Filled tokens"
						note="Each month reads at a glance, colour and mark together."
						cost="MonthNavigation draws tokens from each month's result"
						why="the clearest at a glance, like a habit tracker"
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="October at 390 px: April is the sample month with no budgets">
							<Phone label="Option D, the month dots, October" tab="home">
								<MonthStrip month={CURRENT} cell={tokensCell} />
							</Phone>
						</Shot>
						<Shot caption="September at 390 px">
							<Phone label="Option D, the month dots, September" tab="home">
								<MonthStrip month="2026-09" cell={tokensCell} />
							</Phone>
						</Shot>
						<Shot caption="October at 1280 px: April is the sample month with no budgets">
							<Desk label="Option D, the month dots, October" active="home">
								<MonthStrip month={CURRENT} cell={tokensCell} />
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option E · Mini bars"
						note="Each month shows how far under or over, not just which."
						cost="MonthNavigation draws bars from each month's spent and budget"
						why="it shows size, not only direction"
						recommended={false}
						width="w-[722px]"
					>
						<Shot caption="October at 390 px: April is the sample month with no budgets">
							<Phone label="Option E, the month dots, October" tab="home">
								<MonthStrip month={CURRENT} cell={barsCell} />
							</Phone>
						</Shot>
						<Shot caption="September at 390 px">
							<Phone label="Option E, the month dots, September" tab="home">
								<MonthStrip month="2026-09" cell={barsCell} />
							</Phone>
						</Shot>
						<Shot caption="October at 1280 px: April is the sample month with no budgets">
							<Desk label="Option E, the month dots, October" active="home">
								<MonthStrip month={CURRENT} cell={barsCell} />
							</Desk>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>
		</>
	);
}
