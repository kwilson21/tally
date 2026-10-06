// P46–P53 (spec §8.4, decision 67; docs/reviews/original-app-gaps.md B1–B3 and B5–B8): Home's
// wording, and where Home leads. Each option is drawn on a phone's first screen from the real
// components with the demo's October so far (today is Oct 5), so the owner can pick them in one
// pass. Where an option changes Home's top or a budget row, a prototype is drawn here in tokens;
// wherever an option leaves them as they are, the real HomeTop and ProgressRow draw them. Nothing
// here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { type CategorySummary, statusSentence } from "../budget";
import type { ListRow } from "../db/transactions";
import { budgetExample } from "../how-it-works/examples";
import { formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { HomeTop } from "../views/home-top";
import { BudgetDiagram } from "../views/how-diagrams";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

const dollars = (cents: number) => formatCents(cents, { wholeDollars: true });

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: October so far, with one category over and one nearly spent
// (spec §9, feature 1). Every total below is worked out from these rows, so the pictures agree.

type Row = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

const CATS = {
	groceries: { name: "Groceries", icon: "groceries", color: "cat-blue" },
	eatingOut: { name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	gas: { name: "Gas", icon: "gas", color: "cat-slate" },
	household: { name: "Household", icon: "household", color: "cat-brown" },
	utilities: { name: "Utilities", icon: "utilities", color: "cat-ochre" },
	kids: { name: "Kids", icon: "kids", color: "cat-ochre" },
	shopping: { name: "Shopping", icon: "shopping", color: "cat-plum" },
	dateNight: { name: "Date Night", icon: "date-night", color: "cat-blue" },
} as const;
type Cat = (typeof CATS)[keyof typeof CATS];

const row = (cat: Cat, spentCents: number, budgetCents: number): Row => ({
	...cat,
	spentCents,
	budgetCents,
});

/** October's budgeted categories, in Settings' order: Eating Out is over, Gas nearly spent. */
export const OCTOBER: Row[] = [
	row(CATS.groceries, 31200, 70000),
	row(CATS.eatingOut, 28600, 25000),
	row(CATS.gas, 18600, 20000),
	row(CATS.household, 3000, 25000),
	row(CATS.utilities, 12000, 45000),
];

/** Categories with no budget, and what each has spent in October. */
const NOT_BUDGETED = [
	{ ...CATS.kids, spentCents: 6000 },
	{ ...CATS.shopping, spentCents: 8000 },
	{ ...CATS.dateNight, spentCents: 0 },
];

/** The Band's numbers: this month's transactions needing a category, and older ones (P52). */
const UNCATEGORIZED = { count: 12, cents: 22800, older: 6 };
const BILLS_DUE_CENTS = 14200;
const DAYS_LEFT = 27; // Oct 5 to Oct 31, today included

const sum = (cents: number[]) => cents.reduce((s, c) => s + c, 0);
const BUDGET_CENTS = sum(OCTOBER.map((r) => r.budgetCents));
const IN_BUDGETS_CENTS = sum(OCTOBER.map((r) => r.spentCents));
const NO_BUDGET_CENTS = sum(NOT_BUDGETED.map((c) => c.spentCents));
const SPENT_CENTS = IN_BUDGETS_CENTS + NO_BUDGET_CENTS + UNCATEGORIZED.cents;
// Spec §6: the whole budget, minus all counted spending, minus bills due and unpaid ($406).
const SAFE_CENTS = BUDGET_CENTS - SPENT_CENTS - BILLS_DUE_CENTS;
/** What the budget rows have left between them ($916): more than Safe to spend (gap B2). */
const LEFT_IN_BUDGETS_CENTS = BUDGET_CENTS - IN_BUDGETS_CENTS;
/** P50: Safe to spend over the days left, rounded down to the cent. */
const PER_DAY = formatCents(Math.floor(SAFE_CENTS / DAYS_LEFT));

/** Rows as statusSentence reads them, so the sentence is the one Home's code writes. */
const summaries = (rows: Row[]): CategorySummary[] =>
	rows.map((r, i) => ({
		id: i + 1,
		name: r.name,
		budgetCents: r.budgetCents,
		spentCents: r.spentCents,
		leftCents: r.budgetCents - r.spentCents,
		over: r.spentCents > r.budgetCents,
	}));
const STATUS = statusSentence(summaries(OCTOBER));

const BAND = {
	href: "/transactions/organize",
	text: `${UNCATEGORIZED.count} transactions need a category`,
	detail: `${dollars(UNCATEGORIZED.cents)} of this month's spending`,
};

/** The real HomeTop with October's numbers, for options that change only its sentence or Band. */
const homeTop = (
	band: { href: string; text: string; detail?: string },
	status = STATUS,
) => (
	<HomeTop
		month="October"
		safeToSpendCents={SAFE_CENTS}
		status={status}
		band={band}
	/>
);

// ---------------------------------------------------------------------------------------------
// Home's parts, as the route draws them.

/** The month as Home's small serif heading. */
function Month({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-2xl font-semibold tracking-tight">{children}</h1>
	);
}

/**
 * Safe to spend's amount, at HomeTop's phone size (60px; the picture is a phone, so no lg: size). It
 * never breaks, so a "−" can't sit alone on a line.
 */
function Headline({
	tone = "",
	children,
}: {
	tone?: string;
	children?: Child;
}) {
	return (
		<p
			class={`font-serif text-6xl font-semibold tracking-tight whitespace-nowrap ${tone}`}
		>
			{children}
		</p>
	);
}

/**
 * Home's top as HomeTop draws it (month, label, amount, sentence, How this works, Band), with the
 * parts an option changes passed in.
 */
function Top({
	heading = <Month>October</Month>,
	label = "Safe to spend",
	amount = <Headline>{dollars(SAFE_CENTS)}</Headline>,
	status = STATUS,
	under,
	after = (
		<Band href={BAND.href} detail={BAND.detail}>
			{BAND.text}
		</Band>
	),
}: {
	heading?: Child;
	label?: Child;
	amount?: Child;
	status?: Child;
	/** A line under the status sentence, before How this works. */
	under?: Child;
	/** What sits where the Band is; null for nothing. */
	after?: Child;
}) {
	return (
		<>
			{heading}
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					{typeof label === "string" ? (
						<p class="text-lg text-muted">{label}</p>
					) : (
						label
					)}
					{amount}
				</div>
				{/* The picture is a phone: without this, LedgerIllustration's lg: size crowds the amount at 1024px and up. */}
				<div class="shrink-0 lg:[&>svg]:size-28">
					<LedgerIllustration />
				</div>
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			{under}
			<HowLink section="budget" />
			{after && <div class="mt-4">{after}</div>}
		</>
	);
}

/** The Budget heading with Adjust, its rows, and what follows them in the section. */
function Budget({
	adjust = true,
	children,
	after,
}: {
	adjust?: boolean;
	children?: Child;
	after?: Child;
}) {
	return (
		<section class="mt-8">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="font-serif text-3xl font-semibold">Budget</h2>
				{adjust && <AdjustLink adjusting={false} />}
			</div>
			<ul class="mt-2 divide-y divide-rule">{children}</ul>
			{after}
		</section>
	);
}

/** Each row as the real ProgressRow, a link to its budget sheet unless it's a finished month. */
const progressRows = (rows: Row[], links = true) =>
	rows.map((r, i) => (
		<ProgressRow {...r} href={links ? `/budget/${i + 1}` : undefined} />
	));

/**
 * A prototype of ProgressRow with what an option adds: a line under the bar (P47, P49), or a name
 * and amount that are links of their own (P53 C). Laid out exactly as ProgressRow lays out a row.
 */
function ProtoRow({
	r,
	href,
	name,
	amount,
	under,
}: {
	r: Row;
	href?: string;
	name?: Child;
	amount?: Child;
	under?: Child;
}) {
	const over = r.spentCents > r.budgetCents;
	const { fillPct } = barGeometry(r.spentCents, r.budgetCents);
	const Box = href ? "a" : "div";
	return (
		<li>
			<Box
				href={href}
				class="flex items-start gap-4 py-3 text-ink no-underline"
			>
				<CategoryIcon icon={r.icon} color={r.color} />
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline justify-between gap-x-3">
						{name ?? <span class="text-lg">{r.name}</span>}
						{amount ?? (
							<span class="ml-auto text-right text-lg">
								{dollars(r.spentCents)} of {dollars(r.budgetCents)}
							</span>
						)}
					</div>
					<svg class="mt-2 h-1 w-full" aria-hidden="true">
						<rect width="100%" height="100%" rx="2" class="fill-rule" />
						<rect
							width={`${fillPct}%`}
							height="100%"
							rx="2"
							class={over ? "fill-over" : "fill-ok"}
						/>
					</svg>
					{/* Over budget, ProgressRow's own words: the alert icon and "$36 over", in brick. */}
					{under ??
						(over && (
							<p class="mt-1 flex items-center justify-end gap-1 text-over">
								<Icon name="alert" class="size-5" />
								{dollars(r.spentCents - r.budgetCents)} over
								<span class="sr-only"> budget</span>
							</p>
						))}
				</div>
			</Box>
		</li>
	);
}

/** Home's "Not budgeted" list as the route draws it; with `spent`, P51 A's amount under each name. */
function NotBudgeted({
	spent = false,
	total,
}: {
	spent?: boolean;
	total?: Child;
}) {
	return (
		<>
			<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
			{total}
			<ul class="divide-y divide-rule">
				{NOT_BUDGETED.map((c, i) => (
					<li>
						<a
							href={`/budget/${10 + i}`}
							class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline"
						>
							<CategoryIcon icon={c.icon} color={c.color} />
							<span class="min-w-0 flex-1">
								<span class="block truncate text-lg">{c.name}</span>
								{spent && c.spentCents > 0 && (
									<span class="block text-muted">
										{dollars(c.spentCents)} spent
									</span>
								)}
							</span>
							<span class="text-accent">Add a budget</span>
						</a>
					</li>
				))}
			</ul>
		</>
	);
}

/** A prototype of the "Why?" link the owner picked (P33 A): the word, after a dot. */
function Why({ topic }: { topic: string }) {
	return (
		<a
			href="#p48-why-lower"
			aria-label={`Why: ${topic}`}
			class="inline-flex min-h-11 items-center text-sm"
		>
			Why?
		</a>
	);
}

// ---------------------------------------------------------------------------------------------
// P46: browse past months.

/** September, finished: under budget overall, with Eating Out over. Kids had no budget. */
export const SEPTEMBER: Row[] = [
	row(CATS.groceries, 63600, 70000),
	row(CATS.eatingOut, 28600, 25000),
	row(CATS.gas, 19200, 20000),
	row(CATS.household, 21000, 25000),
	row(CATS.utilities, 41000, 45000),
];
const SEPTEMBER_NO_BUDGET_CENTS = 3000;
/** How September ended: its budget minus everything it counted ($86). */
const SEPTEMBER_LEFT_CENTS =
	sum(SEPTEMBER.map((r) => r.budgetCents)) -
	sum(SEPTEMBER.map((r) => r.spentCents)) -
	SEPTEMBER_NO_BUDGET_CENTS;

/** A finished month's sentence, in the past tense, written from its rows. */
function endedSentence(rows: Row[]) {
	const over = rows.filter((r) => r.spentCents > r.budgetCents);
	if (over.length === 0) return "Every category stayed under its budget.";
	const [first] = over as [Row];
	return over.length === 1
		? `${first.name} finished ${dollars(first.spentCents - first.budgetCents)} over. Everything else stayed under.`
		: `${over.map((r) => r.name).join(" and ")} finished over. Everything else stayed under.`;
}

/** A prototype of A's heading: ‹ and › beside the month, each a 44px link; › is left out on this month. */
function MonthArrows({
	month,
	prev,
	next,
}: {
	month: string;
	prev: string;
	next?: string;
}) {
	return (
		<div class="-ml-3 flex items-center">
			<a
				href="#p46-past-months"
				aria-label={`Previous month, ${prev}`}
				class="inline-flex size-11 items-center justify-center"
			>
				<Icon name="chevron-right" class="size-6 rotate-180" />
			</a>
			<Month>{month}</Month>
			{next && (
				<a
					href="#p46-past-months"
					aria-label={`Next month, ${next}`}
					class="inline-flex size-11 items-center justify-center"
				>
					<Icon name="chevron-right" class="size-6" />
				</a>
			)}
		</div>
	);
}

/** How a finished month ended, in words under its number: a check and "under budget", or the alert and "over budget". */
function EndedAs({ cents }: { cents: number }) {
	return cents >= 0 ? (
		<p class="flex items-center gap-1 text-lg text-muted">
			<span class="text-ok">
				<Icon name="check" class="size-5" />
			</span>
			under budget
		</p>
	) : (
		<OverWords>over budget</OverWords>
	);
}

/** P46 A: "September ended $86 under budget" in Safe to spend's place; nothing to act on. */
const pastMonth = (
	<>
		<Top
			heading={<MonthArrows month="September" prev="August" next="October" />}
			label="September ended"
			amount={
				<>
					<Headline>{dollars(Math.abs(SEPTEMBER_LEFT_CENTS))}</Headline>
					<EndedAs cents={SEPTEMBER_LEFT_CENTS} />
				</>
			}
			status={endedSentence(SEPTEMBER)}
			after={
				<a href="#p46-past-months" class="inline-flex min-h-11 items-center">
					Back to October
				</a>
			}
		/>
		<Budget adjust={false}>{progressRows(SEPTEMBER, false)}</Budget>
	</>
);

/** P46 B: each finished month and how it ended, newest first. */
const PAST = [
	{ month: "September", leftCents: SEPTEMBER_LEFT_CENTS },
	{ month: "August", leftCents: -4200 },
	{ month: "July", leftCents: 13000 },
	{ month: "June", leftCents: 1500 },
	{ month: "May", leftCents: 21000 },
];

const pastList = (
	<>
		<Title>Past months</Title>
		<p class="mt-2 text-muted">
			How each month ended. Each opens that month's Home.
		</p>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{PAST.map((m) => (
				<li>
					<a
						href="#p46-past-months"
						class="flex h-16 items-center gap-4 text-ink no-underline"
					>
						<span class="min-w-0 flex-1">
							<span class="block text-lg leading-6">{m.month}</span>
							{m.leftCents < 0 ? (
								<span class="flex items-center gap-1 leading-6 text-over">
									<Icon name="alert" class="size-5" />
									{dollars(-m.leftCents)} over budget
								</span>
							) : (
								<span class="flex items-center gap-1 leading-6 text-muted">
									<span class="text-ok">
										<Icon name="check" class="size-5" />
									</span>
									{dollars(m.leftCents)} under budget
								</span>
							)}
						</span>
						<Icon name="chevron-right" />
					</a>
				</li>
			))}
		</ul>
	</>
);

/** P46 C: the phone's own month menu in place of the heading. */
const monthSelect = (
	<>
		<Top
			heading={
				<div>
					<label for="p46-month" class="sr-only">
						Month
					</label>
					<select
						id="p46-month"
						class="min-h-11 rounded-control border border-ink bg-paper px-3 font-serif text-2xl font-semibold"
					>
						{["October", "September", "August", "July", "June", "May"].map(
							(m) => (
								<option selected={m === "October"}>{m}</option>
							),
						)}
					</select>
				</div>
			}
		/>
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P47: when Safe to spend is below $0 (gap B1).

/** A month gone over: Groceries and Eating Out over, and $120 past the whole budget with bills due. */
const OVER: Row[] = [
	row(CATS.groceries, 74200, 70000),
	row(CATS.eatingOut, 28600, 25000),
	row(CATS.gas, 19800, 20000),
	row(CATS.household, 16200, 25000),
	row(CATS.utilities, 44000, 45000),
];
// Every transaction has a category in this month, so there's no Band.
const OVER_BY_CENTS =
	sum(OVER.map((r) => r.spentCents)) + BILLS_DUE_CENTS - BUDGET_CENTS;
const OVER_STATUS = statusSentence(summaries(OVER));

/** A brick line with the alert icon: status in color, icon and word. */
function OverWords({ children }: { children?: Child }) {
	return (
		<p class="flex items-center gap-1 text-lg text-over">
			<Icon name="alert" class="size-5" />
			{children}
		</p>
	);
}

const belowZero = (top: Child) => (
	<>
		{top}
		<Budget>{progressRows(OVER)}</Budget>
	</>
);

/** P47 A: no "Safe to spend"; the headline is how far over, a plain amount, with the icon and "over" in brick. */
const overByLabel = belowZero(
	<Top
		label={null}
		amount={
			<>
				<Headline>{dollars(OVER_BY_CENTS)}</Headline>
				<OverWords>over</OverWords>
			</>
		}
		status="Over budget this month. Spending more takes it further over."
		after={null}
	/>,
);

/** P47 B: the amount stays negative, in brick, with the words under it. */
const overNegative = belowZero(
	<Top
		amount={
			<>
				<Headline tone="text-over">−{dollars(OVER_BY_CENTS)}</Headline>
				<OverWords>Over budget</OverWords>
			</>
		}
		status={OVER_STATUS}
		after={null}
	/>,
);

/** P47 C: nothing is safe to spend, so $0, and how far over in a brick line. */
const overZero = belowZero(
	<Top
		amount={
			<>
				<Headline>{dollars(0)}</Headline>
				<OverWords>{dollars(OVER_BY_CENTS)} over budget</OverWords>
			</>
		}
		status={OVER_STATUS}
		after={null}
	/>,
);

// ---------------------------------------------------------------------------------------------
// P48: why Safe to spend is lower than what the budgets have left (gap B2).

/** P48 A: a Why? beside the label, as decision 65 puts one beside anything a rule decides. */
const whyLabel = (
	<>
		<Top
			label={
				<p class="flex flex-wrap items-center gap-x-2 text-lg text-muted">
					Safe to spend
					<span aria-hidden="true">·</span>
					<Why topic="safe to spend" />
				</p>
			}
		/>
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

/** How Tally works' budget section as the family sees it: the rule, then their own numbers. */
function HowBudget({
	diagram = false,
	children,
}: {
	diagram?: boolean;
	children?: Child;
}) {
	return (
		<>
			<Title>How Tally works</Title>
			<h2 class="mt-6 font-serif text-3xl font-semibold">
				Budget and safe to spend
			</h2>
			<p class="mt-2">
				Home shows how much of this month's budget is left, for each category
				and in total.
			</p>
			<ul class="mt-3 list-disc pl-5">
				<li>
					Safe to spend is the whole month's budget, minus all counted spending
					(including uncategorized and unbudgeted), minus bills that are due or
					overdue and not yet paid.
				</li>
			</ul>
			{diagram && (
				<div class="mt-4">
					<BudgetDiagram
						totalBudgetCents={BUDGET_CENTS}
						totalSpentCents={SPENT_CENTS}
						safeToSpendCents={SAFE_CENTS}
					/>
				</div>
			)}
			<div class="mt-4 flex flex-col gap-2 bg-band px-4 py-3">
				<p>
					<span class="font-semibold">With your numbers: </span>
					{budgetExample({
						totalBudgetCents: BUDGET_CENTS,
						totalSpentCents: SPENT_CENTS,
						safeToSpendCents: SAFE_CENTS,
					})}
				</p>
				{children}
			</div>
		</>
	);
}

/** Option A: where its Why? leads, with a line on why it's less than the budgets have left. */
const whyLeads = (
	<HowBudget diagram>
		<p>
			Your budgets have {dollars(LEFT_IN_BUDGETS_CENTS)} left. Safe to spend is{" "}
			{dollars(LEFT_IN_BUDGETS_CENTS - SAFE_CENTS)} less:{" "}
			{dollars(UNCATEGORIZED.cents)} has no category yet,{" "}
			{dollars(NO_BUDGET_CENTS)} went to categories with no budget, and{" "}
			{dollars(BILLS_DUE_CENTS)} is set aside for bills due.
		</p>
	</HowBudget>
);

/** The sum, line by line: what the budgets have, and each thing Safe to spend takes off. */
const SUM_LINES: [string, number][] = [
	["Spent in budgeted categories", IN_BUDGETS_CENTS],
	["Spent, no category yet", UNCATEGORIZED.cents],
	["Spent, no budget", NO_BUDGET_CENTS],
	["Bills due", BILLS_DUE_CENTS],
];

/** P48 B: a no-script disclosure under the sentence, drawn open. */
const workedOut = (
	<>
		<Top
			under={
				<details open class="group mt-1">
					<summary class="flex min-h-11 list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
						<Icon name="chevron" class="size-5 group-open:rotate-90" />
						How it's worked out
					</summary>
					<dl class="divide-y divide-rule border-y border-rule">
						<div class="flex justify-between gap-4 py-1.5">
							<dt>Budgets</dt>
							<dd>{dollars(BUDGET_CENTS)}</dd>
						</div>
						{SUM_LINES.map(([label, cents]) => (
							<div class="flex justify-between gap-4 py-1.5">
								<dt>{label}</dt>
								<dd>−{dollars(cents)}</dd>
							</div>
						))}
						<div class="flex justify-between gap-4 py-1.5 font-semibold">
							<dt>Safe to spend</dt>
							<dd>{dollars(SAFE_CENTS)}</dd>
						</div>
					</dl>
				</details>
			}
		/>
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

/** P48 C: the sum as one quiet line, always shown. */
const sumLine = (
	<>
		<Top
			under={
				<p class="mt-1 text-sm text-muted">
					{dollars(BUDGET_CENTS)} budget − {dollars(SPENT_CENTS)} spent −{" "}
					{dollars(BILLS_DUE_CENTS)} bills due{" "}
					<span class="whitespace-nowrap">= {dollars(SAFE_CENTS)}</span>
				</p>
			}
		/>
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P49: a category that's nearly spent (gap B3).

/** Drawn: 80% or more of its budget used, and not over. In the sample, only Gas. */
const nearlySpent = (r: Row) =>
	r.spentCents <= r.budgetCents && r.spentCents * 10 >= r.budgetCents * 8;

/**
 * The Budget list scrolled into view, each nearly spent row drawn by the prototype and every other
 * row by ProgressRow, so A and B show the row they change (on Home's first screen it's below the fold).
 */
function nearList(under: (r: Row) => Child) {
	return (
		<Budget>
			{OCTOBER.map((r, i) =>
				nearlySpent(r) ? (
					<ProtoRow r={r} href={`/budget/${i + 1}`} under={under(r)} />
				) : (
					<ProgressRow {...r} href={`/budget/${i + 1}`} />
				),
			)}
		</Budget>
	);
}

/** P49 A: where an over row says "$36 over", a nearly spent one says what's left, in ink. */
const nearLeft = nearList((r) => (
	<p class="mt-1 text-right text-ink">
		{dollars(r.budgetCents - r.spentCents)} left
	</p>
));

/** P49 B: a word and the alert icon, in ink. */
const nearWord = nearList(() => (
	<p class="mt-1 flex items-center justify-end gap-1 text-ink">
		<Icon name="alert" class="size-5" />
		Nearly spent
	</p>
));

/** P49 C: rows as today; the sentence names it. */
const nearSentence = (
	<>
		{homeTop(
			BAND,
			"Eating Out is $36 over and Gas is nearly spent. Everything else is on track.",
		)}
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P50: a daily amount (gap B5, issue #74's line).

const DAILY = `About ${PER_DAY} a day for the ${DAYS_LEFT} days left.`;

/** P50 A: a quiet line under the status sentence. */
const dailyUnder = (
	<>
		<Top under={<p class="mt-1 text-muted">{DAILY}</p>} />
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

/** P50 B: the daily amount is the status sentence. */
const dailyStatus = (
	<>
		<Top status={DAILY} />
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

/** P50 C: only in How Tally works, with your numbers. */
const dailyHow = (
	<HowBudget>
		<p>
			That's about {PER_DAY} a day for the {DAYS_LEFT} days left in October,
			today included.
		</p>
	</HowBudget>
);

// ---------------------------------------------------------------------------------------------
// P51: spending in categories with no budget (gap B6). Drawn scrolled to the Budget list.

/** P51 A: each category says what it spent. */
const notBudgetedEach = (
	<Budget after={<NotBudgeted spent />}>{progressRows(OCTOBER)}</Budget>
);

/** P51 B: one total under the heading. */
const notBudgetedTotal = (
	<Budget
		after={
			<NotBudgeted
				total={
					<p class="mt-1">
						{dollars(NO_BUDGET_CENTS)} spent in categories with no budget
					</p>
				}
			/>
		}
	>
		{progressRows(OCTOBER)}
	</Budget>
);

// ---------------------------------------------------------------------------------------------
// P52: transactions from earlier months needing a category (gap B7).

const olderHome = (band: Child) => (
	<>
		{band}
		<Budget>{progressRows(OCTOBER)}</Budget>
	</>
);

/** P52 A: the Band's second line counts the older ones too; "and 6 more…" wraps as one piece, never "6 / more". */
const olderOnBand = olderHome(
	homeTop({
		...BAND,
		detail: `${BAND.detail} ${`and ${UNCATEGORIZED.older} more from earlier months`.replaceAll(" ", "\u00a0")}`,
	}),
);

/** P52 A, once this month's are done: the Band stays for the older ones. */
const olderOnly = olderHome(
	homeTop({
		href: BAND.href,
		text: `${UNCATEGORIZED.older} transactions from earlier months need a category`,
	}),
);

/** P52 B: a second, quieter link under the Band. */
const olderLink = olderHome(
	<>
		{homeTop(BAND)}
		<a href="#p52-older" class="inline-flex min-h-11 items-center">
			{UNCATEGORIZED.older} more from earlier months need a category
		</a>
	</>,
);

// ---------------------------------------------------------------------------------------------
// P53: from a budget row to its transactions (gap B8, beta feedback #39).

const EATING_OUT = OCTOBER[1] as Row;
/** What Eating Out spent in September, for the money input's "Last month" chip. */
const LAST_MONTH_CENTS =
	SEPTEMBER.find((r) => r.name === EATING_OUT.name)?.spentCents ?? 0;

/** Eating Out's 9 transactions so far in October, newest first; they add up to the row's $286. */
const EATING_OUT_ROWS: ListRow[] = (
	[
		["2026-10-05", "Lupita's Taqueria", 2240],
		["2026-10-05", "Blue Bottle Coffee", 650],
		["2026-10-04", "Pizzeria Delfina", 6420],
		["2026-10-04", "Local Bakery", 1180],
		["2026-10-03", "Chipotle", 2890],
		["2026-10-03", "Sushi Ran", 8450],
		["2026-10-02", "Starbucks", 575],
		["2026-10-02", "Panera Bread", 1995],
		["2026-10-01", "Shake Shack", 4200],
	] as const
).map(([date, name, cents], i) => ({
	id: i + 1,
	date,
	amountCents: cents,
	rawName: name.toUpperCase(),
	displayName: name,
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	categoryId: 2,
	categoryName: "Eating Out",
	categoryIcon: "eating-out",
	categoryColor: "cat-plum",
}));

/** Home scrolled to the Budget list, behind the sheet. */
export const budgetBehind = <Budget>{progressRows(OCTOBER)}</Budget>;

/** P53 A: the budget sheet as the route draws it, with a link to the transactions above the amount. */
const sheetLink = (
	<Sheet behind={budgetBehind}>
		<div class="flex items-center gap-3">
			<CategoryIcon icon={EATING_OUT.icon} color={EATING_OUT.color} />
			<h2 class="min-w-0 wrap-anywhere font-serif text-4xl font-semibold tracking-tight">
				{EATING_OUT.name}
			</h2>
		</div>
		<div>
			<p class="text-muted">
				{formatCents(EATING_OUT.spentCents)} spent so far in October
			</p>
			<a href="#p53-row" class="inline-flex min-h-11 items-center gap-1">
				See the {EATING_OUT_ROWS.length} transactions
				<Icon name="chevron-right" class="size-5" />
			</a>
		</div>
		<div class="flex flex-col gap-4 border-t border-rule pt-4">
			<MoneyInput
				id="p53-budget"
				name="budget"
				label="Budget from October on"
				value="250.00"
				lastMonthCents={LAST_MONTH_CENTS}
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

/** P53 B: the row opens Transactions for that category and month, with a link to change its budget. */
const rowToList = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">
			{EATING_OUT_ROWS.length} transactions in Eating Out, October
		</p>
		<a href="#p53-row" class="inline-flex min-h-11 items-center">
			Change the Eating Out budget
		</a>
		<ul class="divide-y divide-rule border-y border-rule">
			{EATING_OUT_ROWS.map((r) => (
				<TransactionRow row={r} />
			))}
		</ul>
	</>
);

/** P53 C: two links in each row, each 44px tall: the name to its transactions, the amount to its sheet. */
const twoLinks = (
	<Budget>
		{OCTOBER.map((r) => (
			<ProtoRow
				r={r}
				name={
					<a href="#p53-row" class="inline-flex min-h-11 items-center text-lg">
						{r.name}
						<span class="sr-only">, see its transactions</span>
					</a>
				}
				amount={
					<a
						href="#p53-row"
						class="ml-auto inline-flex min-h-11 items-center text-right text-lg"
					>
						{dollars(r.spentCents)} of {dollars(r.budgetCents)}
						<span class="sr-only">, change the budget</span>
					</a>
				}
			/>
		))}
	</Budget>
);

/** P46–P53 on the proposals page (spec §8.4, decision 67). */
export function Phase5HomeProposals() {
	return (
		<>
			<Specimen
				id="p46-past-months"
				title="P46 · Browse past months"
				tier="visual"
				sentence="See how an earlier month ended, on Home (spec §8.4). Pick how you get there; A's finished September is drawn."
			>
				<Fixed>
					a month is the YYYY-MM of Plaid's dates, and "today" is the
					household's date (§6, decision 67). A category's budget for a month is
					its latest amount set on or before it, a budget changes from this
					month on, and an archived category stays on Home for any month it has
					spending in (§6, §7).
				</Fixed>
				<NeedsLine>
					a finished month's number is its budget minus everything it counted,
					with no bills set aside, and says “over budget” with the alert icon
					when it ended over; its rows don't open a budget sheet; and it goes
					back to the first month with transactions.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Arrows by the month",
							picked: true,
							note: "‹ and › beside the month step back and forward (› is hidden on this month); a finished month reads “September ended $86 under budget” in Safe to spend's place, with no Band or Adjust, and a Back to October link.",
							tradeoff: "one month at a time, so a year ago is twelve taps.",
							recommended:
								"it's where you're already looking, and a finished month reads as finished, not as something to do.",
							screen: pastMonth,
						},
						{
							name: "Option B · A list of past months",
							note: "A Past months list, under More or at the foot of Trends, shows each month and how it ended; each opens that month's Home.",
							tradeoff:
								"a few taps from Home, and Home never hints that the past is there.",
							screen: pastList,
						},
						{
							name: "Option C · A month menu",
							note: "The phone's own month menu in place of the heading, above Safe to spend.",
							tradeoff:
								"a form control on Home's top every day for something done now and then; without JavaScript it needs a Show button.",
							screen: monthSelect,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p47-below-zero"
				title="P47 · When Safe to spend is below $0"
				tier="visual"
				sentence="When spending and bills due pass the whole budget, Safe to spend goes below $0, and Home says “-$120” (gap B1). Pick the words."
			>
				<Fixed>
					Safe to spend is the whole budget minus all counted spending minus
					bills due or overdue and unpaid (§6), so it can be below $0. Brick
					only with an icon and a word (DESIGN.md).
				</Fixed>
				<NeedsLine>
					how a category reads when refunds outweigh its spending (gap E9; today
					“-$20 of $250”). At exactly $0 Home says “$0” under “Safe to spend”,
					as today. Already settled (decision 74): when Safe to spend is below
					$0, Home shows “$120 over” with the alert icon, and the sentence under
					the number reads “Over budget this month. Spending more takes it
					further over.”
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · “Over budget this month”",
							picked: true,
							note: "“Safe to spend” goes; the headline is how far over, “$120”, with the alert icon and “over” in brick under it, and the sentence says what more spending does.",
							tradeoff:
								"the big number now means how far over, not what's safe, so the words under it have to be read.",
							recommended:
								"the number stays a plain amount, and the icon and word carry the status, as on a budget row.",
							screen: overByLabel,
						},
						{
							name: "Option B · A negative number",
							note: "Safe to spend stays the label; the amount shows “−$120” in brick, with “Over budget” under it.",
							tradeoff:
								"a negative amount to spend is a puzzle, and a brick headline is the loudest thing Home could show.",
							screen: overNegative,
						},
						{
							name: "Option C · $0, and how far over",
							note: "Nothing is safe to spend, so the headline says $0; a brick line under it says “$120 over budget”.",
							tradeoff:
								"true, but the amount that matters is in the small print.",
							screen: overZero,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p48-why-lower"
				title="P48 · Why Safe to spend is lower than the budgets"
				tier="visual"
				sentence="Safe to spend is less than the budget rows have left, because it also takes off spending with no category yet, spending with no budget, and bills due (gap B2). Pick how Home explains it."
			>
				<Fixed>
					the rule (§6), and the Why? link (decision 65, P33 A): the word in
					terracotta beside what a rule decides, to its section of How Tally
					works, in the demo and the family app.
				</Fixed>
				<NeedsLine>
					How Tally works' budget example breaks the difference down with your
					numbers: what the budgets have left, then each thing Safe to spend
					also takes off.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Why? beside Safe to spend",
							picked: true,
							note: "A Why? after the label (the number is what the rule decides) goes to How Tally works with your numbers.",
							tradeoff: "the answer is a page away.",
							recommended:
								"no new screen: the Why? you picked answers it, and Home's top stays as calm as today.",
							screen: whyLabel,
						},
						{
							name: "Option A · Where Why? leads",
							note: "The budget section as the family app draws it, with the sum and a line on why it's less than your budgets have left (its other rules are left out of the picture).",
							family: true,
							screen: whyLeads,
						},
						{
							name: "Option B · How it's worked out, on tap",
							note: "A disclosure under the sentence opens the sum on Home, line by line (drawn open).",
							tradeoff:
								"the answer is right there, but open it fills a third of the first screen and pushes the Budget list below it.",
							screen: workedOut,
						},
						{
							name: "Option C · The sum, always",
							note: "A quiet line under the sentence: budget − spent − bills due = Safe to spend.",
							tradeoff: `arithmetic on Home's first screen every day, and its “${dollars(SPENT_CENTS)} spent” is more than the rows add up to (${dollars(IN_BUDGETS_CENTS)}).`,
							screen: sumLine,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p49-near-limit"
				title="P49 · Nearly spent"
				tier="visual"
				sentence="A category at 80% or more of its budget gets no warning today; it's green until it's over (gap B3). Pick how a row says it's nearly spent; A and B are drawn scrolled to the Budget list."
			>
				<Fixed>
					status is green or brick only, each with an icon and a word; no new
					status color, and category colors never carry status (DESIGN.md). Bars
					have no limit marker (decision 46).
				</Fixed>
				<NeedsLine settled="decisions 74 and 79">
					A category is nearly spent when 80% or more of its budget is used and
					it is not over. Its row says “$X left”, with no new color.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · “$14 left” under the bar",
							picked: true,
							note: "Where an over row says “$36 over”, a nearly spent row says what's left, in ink; the bar stays green.",
							tradeoff: "quiet, so it's easy to read past.",
							recommended:
								"the amount left is the most useful warning, and it adds no color or icon to learn.",
							screen: nearLeft,
						},
						{
							name: "Option B · “Nearly spent” with the alert icon",
							note: "The words and the alert icon, in ink, under the bar.",
							tradeoff:
								"the same alert icon then marks nearly spent (in ink) and over (in brick), so the icon alone no longer says which.",
							screen: nearWord,
						},
						{
							name: "Option C · Named in the sentence",
							note: "Rows stay as today; the status sentence adds “Gas is nearly spent”.",
							tradeoff: "the row itself still looks on track.",
							screen: nearSentence,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p50-daily"
				title="P50 · A daily amount"
				tier="visual"
				sentence="How much is safe to spend each day for the rest of the month (gap B5; issue #74's line). Pick where it goes."
			>
				<Fixed>
					Safe to spend is the one thing on Home's first screen (decision 46),
					and code calculates every number (§2, rule 6).
				</Fixed>
				<NeedsLine>
					the daily amount is Safe to spend divided by the days left, today
					included ({DAYS_LEFT} on Oct 5), in whole cents, never up; there's no
					line when Safe to spend is $0 or less.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line under the sentence",
							picked: true,
							note: `“${DAILY}” in quiet text under the status sentence.`,
							tradeoff: "one more line before the Band.",
							recommended:
								"it answers “how much can I spend today?” in the same glance as the number it comes from.",
							screen: dailyUnder,
						},
						{
							name: "Option B · In place of the sentence",
							note: "The daily amount becomes the status sentence.",
							tradeoff:
								"Home no longer says which category is over until the rows.",
							screen: dailyStatus,
						},
						{
							name: "Option C · Only in How Tally works",
							note: "Home stays as today; the budget section works out the daily amount with your numbers.",
							tradeoff: "few people would ever find it.",
							family: true,
							screen: dailyHow,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p51-not-budgeted"
				title="P51 · Spending with no budget"
				tier="visual"
				sentence="Spending in categories with no budget counts in Safe to spend, but Home lists those categories without amounts (gap B6). Pick how it shows; drawn scrolled to the Budget list."
			>
				<Fixed>
					they sit under a small muted “Not budgeted” heading in Settings'
					order, each a link ending in a terracotta “Add a budget” that opens
					its budget sheet (DESIGN.md, #66); their spending already counts in
					Safe to spend (§6).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · What each one spent",
							picked: true,
							note: "Each row adds “$60 spent” under its name; one with nothing spent stays as today.",
							tradeoff: "the list grows a little taller.",
							recommended:
								"you see where the money went at the moment you'd decide to give it a budget.",
							screen: notBudgetedEach,
						},
						{
							name: "Option B · One total",
							note: "A line under the heading: “$140 spent in categories with no budget”.",
							tradeoff: "one number, but not which category it came from.",
							screen: notBudgetedTotal,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p52-older"
				title="P52 · Older transactions needing a category"
				tier="visual"
				sentence="The Band counts only this month's transactions needing a category, so older ones are never mentioned on Home (gap B7). Pick how they show."
			>
				<Fixed>
					one Band on Home, carrying the count and this month's amount (decision
					50). It leads to Organize, which groups every transaction that needs a
					category (§8.1).
				</Fixed>
				<NeedsLine>
					the Band shows when this month or an earlier one has a transaction
					needing a category; older ones are counted, not added to this month's
					amount. Already settled (decision 74): older transactions needing a
					category go on the Band's second line.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · On the Band's second line",
							picked: true,
							note: "“$228 of this month's spending and 6 more from earlier months”, on two lines.",
							tradeoff: "a longer second line.",
							recommended:
								"one Band still says everything that's waiting, and it already leads to all of them.",
							screen: olderOnBand,
						},
						{
							name: "Option A · Once this month's are done",
							note: "The Band stays for the older ones: “6 transactions from earlier months need a category”.",
							screen: olderOnly,
						},
						{
							name: "Option B · A second link",
							note: "A quieter terracotta link under the Band for the older ones.",
							tradeoff:
								"two next steps stacked, so the Band is no longer the one.",
							screen: olderLink,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p53-row"
				title="P53 · From a budget row to its transactions"
				tier="visual"
				sentence="Tapping a total to see what's behind it was the family's ask in the beta (#39, gap B8). Pick how a budget row leads to its transactions."
			>
				<Fixed>
					today a row opens its budget sheet (decision 38), Adjust changes
					budgets by round $10s (decision 48), and Transactions already filters
					by category and month.
				</Fixed>
				<NeedsLine>
					the list shows exactly what the row counts (that category and month,
					excluded ones left out, a late bill payment in the month it counts
					in), so it adds up to the row's amount.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A link in the budget sheet",
							picked: true,
							note: "“See the 9 transactions” under what's spent, above the amount.",
							tradeoff: "one more tap to reach the list.",
							recommended:
								"the row keeps its one job, and the link sits right under the spent amount it explains.",
							screen: sheetLink,
						},
						{
							name: "Option B · The row opens its transactions",
							note: "Tapping a row lists its transactions this month; the budget changes there through a link, or with Adjust.",
							tradeoff: "changing a budget, one tap today, becomes two.",
							screen: rowToList,
						},
						{
							name: "Option C · Two links in a row",
							note: "The name opens the transactions, and the amount opens the budget sheet.",
							tradeoff:
								"two targets in one row, a column of terracotta, and taller rows to fit 44px each.",
							screen: twoLinks,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
