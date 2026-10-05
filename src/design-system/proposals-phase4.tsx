// P23–P32 (spec §11 Phase 4, features 6–8 and the AI suggestions): Trends, the net-worth chart,
// Documents, and merchant-name and new-category suggestions. Each option is drawn on a phone's
// first screen from the real components with demo-style data (today is Oct 5), so the owner can
// pick them all in one pass. Charts are inline SVG in tokens only, as the app will draw them
// (spec §8: no chart library). Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { BankGroup } from "../views/bank-group";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Icon } from "../views/icons";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

/** A rule the spec didn't settle until the owner's picks (decision 64). */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Spec line added (decision 64): </span>
			{children}
		</p>
	);
}

const dollars = (cents: number) => formatCents(cents, { wholeDollars: true });

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style. Six months, May to October; October is the 5 days so far.

const MONTHS = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"];

export const CATS = {
	groceries: { name: "Groceries", icon: "groceries", color: "cat-blue" },
	eatingOut: { name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	kids: { name: "Kids", icon: "kids", color: "cat-ochre" },
	gas: { name: "Gas", icon: "gas", color: "cat-slate" },
	household: { name: "Household", icon: "household", color: "cat-brown" },
} as const;
type Cat = (typeof CATS)[keyof typeof CATS];

type Trend = {
	cat: Cat;
	/** Spending per month in cents, May to October so far. */
	months: number[];
	/** Oct 1–5 against Sep 1–5, in cents. */
	soFar: [number, number];
};

const TRENDS: Trend[] = [
	{
		cat: CATS.groceries,
		months: [82000, 79000, 84500, 81000, 86000, 19600],
		soFar: [19600, 22400],
	},
	{
		// The demo's story (spec §9): Eating Out creeping up.
		cat: CATS.eatingOut,
		months: [21000, 24500, 28000, 31800, 36500, 9200],
		soFar: [9200, 6100],
	},
	{
		cat: CATS.kids,
		months: [26000, 24000, 30000, 28000, 25500, 6000],
		soFar: [6000, 4500],
	},
	{
		cat: CATS.gas,
		months: [18000, 17500, 19000, 17200, 18500, 4800],
		soFar: [4800, 5200],
	},
	{
		cat: CATS.household,
		months: [14000, 19000, 12000, 16000, 15000, 3000],
		soFar: [3000, 5800],
	},
];

const SO_FAR = { now: 124000, before: 133000 };

/**
 * Six months as vertical bars on ledger rules, with each month's amount above it. This month is
 * only part of a month, so it's an outline with a dashed edge ("not finished yet") and says "so far".
 */
function MonthBars({
	cents,
	months = MONTHS.slice(-cents.length),
}: {
	cents: number[];
	months?: string[];
}) {
	const max = Math.max(...cents);
	const w = 350;
	const h = 170;
	const top = 22;
	const bottom = 146;
	const slot = w / 6;
	return (
		<svg viewBox={`0 0 ${w} ${h}`} class="w-full" aria-hidden="true">
			{[0, 1, 2, 3].map((i) => (
				<line
					x1="0"
					x2={w}
					y1={top + ((bottom - top) / 3) * i}
					y2={top + ((bottom - top) / 3) * i}
					class="stroke-rule"
				/>
			))}
			{cents.map((c, i) => {
				const barH = Math.max(2, ((bottom - top) * c) / max);
				// A short history sits at the right, where the latest months are.
				const x = (i + 6 - cents.length) * slot + slot * 0.2;
				const bw = slot * 0.6;
				const last = i === cents.length - 1;
				return (
					<>
						<rect
							x={x}
							y={bottom - barH}
							width={bw}
							height={barH}
							class={last ? "fill-paper stroke-ink" : "fill-ink"}
							stroke-dasharray={last ? "3 3" : undefined}
						/>
						<text
							x={x + bw / 2}
							y={bottom - barH - 6}
							text-anchor="middle"
							font-size="11"
							class="fill-muted"
						>
							{dollars(c)}
						</text>
						<text
							x={x + bw / 2}
							y={h - 6}
							text-anchor="middle"
							font-size="12"
							class={last ? "fill-ink" : "fill-muted"}
						>
							{last ? "Oct so far" : months[i]}
						</text>
					</>
				);
			})}
		</svg>
	);
}

/** Six small bars for one category's row, last one dashed (this month so far). */
function MiniBars({ cents }: { cents: number[] }) {
	const max = Math.max(...cents);
	return (
		<svg viewBox="0 0 96 32" class="h-8 w-24 shrink-0" aria-hidden="true">
			<line x1="0" x2="96" y1="31.5" y2="31.5" class="stroke-rule" />
			{cents.map((c, i) => {
				const barH = Math.max(1, (30 * c) / max);
				const last = i === cents.length - 1;
				return (
					<rect
						x={i * 16 + 3}
						y={31 - barH}
						width="10"
						height={barH}
						class={last ? "fill-paper stroke-ink" : "fill-ink"}
						stroke-dasharray={last ? "2 2" : undefined}
					/>
				);
			})}
		</svg>
	);
}

/** P23 B: every category in a row, each with its own six small bars. */
function TrendRows() {
	return (
		<>
			<Title>Trends</Title>
			<p class="mt-4 text-sm text-muted">By category, May to October</p>
			<ul class="divide-y divide-rule border-y border-rule">
				{TRENDS.map((t) => (
					<li class="flex h-16 items-center gap-4">
						<CategoryIcon icon={t.cat.icon} color={t.cat.color} />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-lg leading-6">{t.cat.name}</span>
							<span class="block leading-6 text-muted">
								{dollars(t.months[4] ?? 0)} in September
							</span>
						</span>
						<MiniBars cents={t.months} />
					</li>
				))}
			</ul>
		</>
	);
}

/** Each category's monthly budget in cents (unchanged since May in the sample). */
const BUDGET: Record<string, number> = {
	Groceries: 90000,
	"Eating Out": 30000,
	Kids: 30000,
	Gas: 20000,
	Household: 15000,
};

/** The five full months (May to September) of a trend: this month isn't over, so it isn't judged. */
const full = (t: Trend) => t.months.slice(0, 5);
const under = (t: Trend) =>
	full(t).filter((c) => c <= (BUDGET[t.cat.name] ?? 0));
const overMonths = (t: Trend) =>
	full(t)
		.map((c, i) => (c > (BUDGET[t.cat.name] ?? 0) ? MONTHS[i] : null))
		.filter((m): m is string => m !== null);

/** A small heading for a group of rows, its icon first (a word and an icon, never color alone). */
function GroupHeading({
	icon,
	tone,
	children,
}: {
	icon: "check" | "arrow-up";
	tone: string;
	children?: Child;
}) {
	return (
		<h2 class="mt-5 flex items-center gap-2 text-sm text-muted">
			<span class={tone}>
				<Icon name={icon} class="size-4" />
			</span>
			{children}
		</h2>
	);
}

/** One category with a sentence about it and its six small bars. */
function InsightRow({ t, line }: { t: Trend; line: string }) {
	return (
		<li class="flex h-16 items-center gap-4">
			<CategoryIcon icon={t.cat.icon} color={t.cat.color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{t.cat.name}</span>
				<span class="block truncate leading-6 text-muted">{line}</span>
			</span>
			<MiniBars cents={t.months} />
		</li>
	);
}

const [GROCERIES, EATING_OUT, KIDS, GAS] = TRENDS as [
	Trend,
	Trend,
	Trend,
	Trend,
];

/** P23 D: good news first, then what's worth a look, then every category. */
const insightsBody = (
	<>
		<GroupHeading icon="check" tone="text-ok">
			Going well
		</GroupHeading>
		<ul class="divide-y divide-rule border-y border-rule">
			<InsightRow t={GROCERIES} line="5 months under budget" />
			<InsightRow t={KIDS} line="5 months under budget" />
			<InsightRow t={GAS} line="5 months under budget" />
		</ul>
		<GroupHeading icon="arrow-up" tone="text-ink">
			Worth a look
		</GroupHeading>
		<ul class="divide-y divide-rule border-y border-rule">
			<InsightRow t={EATING_OUT} line="Up 4 months running" />
		</ul>
		<p class="mt-5 text-sm text-muted">Every category, May to October</p>
		<ul class="divide-y divide-rule border-y border-rule">
			{TRENDS.slice(4).map((t) => (
				<InsightRow t={t} line={`${dollars(t.months[4] ?? 0)} in September`} />
			))}
		</ul>
	</>
);

const trendsInsights = (
	<>
		<Title>Trends</Title>
		{insightsBody}
	</>
);

/** Tally marks for good months: one stroke each, and the fifth crosses the four, as in the brand mark. */
function Tally({ n }: { n: number }) {
	return (
		<svg
			viewBox="0 0 28 28"
			class="size-8 shrink-0"
			fill="none"
			stroke-width="2.25"
			stroke-linecap="round"
			aria-hidden="true"
		>
			{[6, 11, 16, 21].slice(0, Math.min(n, 4)).map((x) => (
				<line x1={x} y1="5" x2={x} y2="23" class="stroke-ink" />
			))}
			{n >= 5 && <line x1="2" y1="19" x2="26" y2="9" class="stroke-accent" />}
		</svg>
	);
}

const goodMonths = TRENDS.reduce((s, t) => s + under(t).length, 0);

/** P23 E: a tally of the months each category stayed under its budget. */
const trendsTally = (
	<>
		<Title>Trends</Title>
		<p class="mt-4 text-lg text-muted">Months under budget since May</p>
		<p class="font-serif text-6xl font-semibold tracking-tight">
			{goodMonths} of {TRENDS.length * 5}
		</p>
		<p class="mt-1 font-serif text-lg italic">
			Groceries, Kids and Gas haven't gone over once.
		</p>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			{TRENDS.map((t) => {
				const over = overMonths(t);
				return (
					<li class="flex h-16 items-center gap-4">
						<CategoryIcon icon={t.cat.icon} color={t.cat.color} />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-lg leading-6">{t.cat.name}</span>
							<span class="block truncate leading-6 text-muted">
								{over.length === 0
									? "Every month"
									: `Over in ${over.join(" and ")}`}
							</span>
						</span>
						<Tally n={under(t).length} />
					</li>
				);
			})}
		</ul>
	</>
);

/** Six small bars against a dashed budget line; a month over it is brick, and the words say so. */
function BudgetBars({ t }: { t: Trend }) {
	const budget = BUDGET[t.cat.name] ?? 1;
	const max = Math.max(budget, ...t.months) * 1.05;
	const y = (c: number) => 31 - (30 * c) / max;
	return (
		<svg viewBox="0 0 96 32" class="h-8 w-24 shrink-0" aria-hidden="true">
			{t.months.map((c, i) => {
				const last = i === t.months.length - 1;
				const over = !last && c > budget;
				return (
					<rect
						x={i * 16 + 3}
						y={y(c)}
						width="10"
						height={31 - y(c)}
						class={
							last ? "fill-paper stroke-ink" : over ? "fill-over" : "fill-ink"
						}
						stroke-dasharray={last ? "2 2" : undefined}
					/>
				);
			})}
			<line
				x1="0"
				x2="96"
				y1={y(budget)}
				y2={y(budget)}
				stroke-dasharray="3 2"
				class="stroke-muted"
			/>
		</svg>
	);
}

/** P23 F: each category's months against its budget line. */
const trendsBudgetLine = (
	<>
		<Title>Trends</Title>
		<p class="mt-4 text-sm text-muted">
			Each month against its budget (dashed), May to October
		</p>
		<ul class="divide-y divide-rule border-y border-rule">
			{TRENDS.map((t) => {
				const over = overMonths(t);
				return (
					<li class="flex h-16 items-center gap-4">
						<CategoryIcon icon={t.cat.icon} color={t.cat.color} />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-lg leading-6">{t.cat.name}</span>
							<span class="flex items-center gap-1 truncate leading-6 text-muted">
								{over.length > 0 && (
									<span class="text-over">
										<Icon name="alert" class="size-4" />
									</span>
								)}
								{over.length === 0
									? "Under every month"
									: `Over in ${over.join(" and ")}`}
							</span>
						</span>
						<BudgetBars t={t} />
					</li>
				);
			})}
		</ul>
	</>
);

/** "Up $31" or "Down $28", with its arrow: a change in words, never color alone (and not a status). */
function Change({ now, then }: { now: number; then: number }) {
	const up = now > then;
	return (
		<span class="flex shrink-0 items-center gap-1 text-lg">
			<Icon name={up ? "arrow-up" : "arrow-down"} class="size-4" />
			{up ? "Up" : "Down"} {dollars(Math.abs(now - then))}
		</span>
	);
}

const byChange = [...TRENDS].sort(
	(a, b) =>
		Math.abs(b.soFar[0] - b.soFar[1]) - Math.abs(a.soFar[0] - a.soFar[1]),
);

/** The serif headline and its sentence: this month so far against the same days last month. */
const soFarTop = (
	<>
		<p class="mt-4 text-lg text-muted">Spent so far in October</p>
		<p class="font-serif text-6xl font-semibold tracking-tight">
			{dollars(SO_FAR.now)}
		</p>
		<p class="mt-1 font-serif text-lg italic">
			{dollars(SO_FAR.before - SO_FAR.now)} less than by this time in September.
		</p>
	</>
);

/** P24 A: the headline, then each category's change, biggest first. */
const compareList = (
	<>
		<Title>Trends</Title>
		{soFarTop}
		<p class="mt-5 text-sm text-muted">Oct 1–5 against Sep 1–5</p>
		<ul class="divide-y divide-rule border-y border-rule">
			{byChange.map((t) => (
				<li class="flex h-16 items-center gap-4">
					<CategoryIcon icon={t.cat.icon} color={t.cat.color} />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-lg leading-6">{t.cat.name}</span>
						<span class="block leading-6 text-muted">
							{dollars(t.soFar[0])}, was {dollars(t.soFar[1])}
						</span>
					</span>
					<Change now={t.soFar[0]} then={t.soFar[1]} />
				</li>
			))}
		</ul>
	</>
);

/** Two horizontal bars for one category: this month so far (ink) over last month's same days (rule). */
function PairBars({
	now,
	then,
	max,
}: {
	now: number;
	then: number;
	max: number;
}) {
	return (
		<svg viewBox="0 0 300 18" class="mt-1 w-full" aria-hidden="true">
			<rect x="0" y="0" width={(300 * now) / max} height="7" class="fill-ink" />
			<rect
				x="0"
				y="10"
				width={(300 * then) / max}
				height="7"
				class="fill-rule"
			/>
		</svg>
	);
}

/** P24 B: the headline, then paired bars for each category. */
const compareBars = (
	<>
		<Title>Trends</Title>
		{soFarTop}
		<p class="mt-5 flex items-center gap-4 text-sm text-muted">
			<span class="flex items-center gap-1">
				<span class="inline-block h-2 w-4 bg-ink" />
				Oct 1–5
			</span>
			<span class="flex items-center gap-1">
				<span class="inline-block h-2 w-4 bg-rule" />
				Sep 1–5
			</span>
		</p>
		<ul class="divide-y divide-rule border-y border-rule">
			{byChange.map((t) => (
				<li class="py-2">
					<p class="flex justify-between text-lg">
						<span>{t.cat.name}</span>
						<span>{dollars(t.soFar[0])}</span>
					</p>
					<PairBars now={t.soFar[0]} then={t.soFar[1]} max={22400} />
				</li>
			))}
		</ul>
	</>
);

/** P23 B and P24 A together on desktop: the same single column, wider (DESIGN.md: one measure). */
const trendsDesktop = (
	<>
		<Title>Trends</Title>
		{soFarTop}
		{insightsBody}
	</>
);

// ---------------------------------------------------------------------------------------------
// P25–P26: the net-worth chart and balances on Accounts.

/** Net worth at each week's end, May to today, in whole dollars. */
const NET = [
	19800, 19950, 20100, 19700, 20300, 20600, 20450, 20900, 21200, 21050, 20800,
	21400, 21700, 21600, 22000, 21850, 22300, 22600, 22400, 22900, 23100, 22800,
	23200, 23400,
];

const BANKS = [
	{
		name: "Chase",
		accounts: [
			{
				id: 1,
				name: "Checking",
				mask: "4410",
				type: "depository",
				balanceCents: 624000,
				isLiability: false,
			},
			{
				id: 2,
				name: "Savings",
				mask: "8812",
				type: "depository",
				balanceCents: 1850000,
				isLiability: false,
			},
		],
	},
	{
		name: "Capital One",
		accounts: [
			{
				id: 3,
				name: "Quicksilver",
				mask: "1029",
				type: "credit",
				balanceCents: 134000,
				isLiability: true,
			},
		],
	},
];
const NET_CENTS = 624000 + 1850000 - 134000;

/** A line through the weekly net worth, on the ledger rules, with where it started and today. */
function NetLine() {
	const w = 350;
	const min = 19000;
	const max = 24000;
	const y = (v: number) => 10 + ((max - v) / (max - min)) * 100;
	const pts = NET.map(
		(v, i) => `${((w - 8) * i) / (NET.length - 1) + 4},${y(v).toFixed(1)}`,
	).join(" ");
	return (
		<svg viewBox={`0 0 ${w} 140`} class="mt-4 w-full" aria-hidden="true">
			{[10, 43, 76, 110].map((ly) => (
				<line x1="0" x2={w} y1={ly} y2={ly} class="stroke-rule" />
			))}
			<polyline points={pts} fill="none" stroke-width="2" class="stroke-ink" />
			<circle
				cx={w - 4}
				cy={y(NET[NET.length - 1] ?? 0)}
				r="4"
				class="fill-ink"
			/>
			<text x="0" y="134" font-size="12" class="fill-muted">
				May
			</text>
			<text x={w} y="134" font-size="12" text-anchor="end" class="fill-muted">
				Today
			</text>
		</svg>
	);
}

/** Month-end net worth as bars, today's month dashed. */
function NetBars() {
	const ends = [20300, 21200, 21700, 22300, 23100, 23400];
	return (
		<div class="mt-4">
			<MonthBars cents={ends.map((d) => d * 100)} />
		</div>
	);
}

/** Accounts' top as the app draws it, with the chart where today's ruled space is. */
function AccountsWith({ chart, sentence }: { chart: Child; sentence: string }) {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">Accounts</h1>
			<p class="mt-3 text-lg text-muted">Net worth</p>
			<p class="font-serif text-6xl font-semibold tracking-tight">
				{dollars(NET_CENTS)}
			</p>
			<p class="mt-1 font-serif text-lg italic">{sentence}</p>
			{chart}
		</>
	);
}

const SINCE_MAY = "Up $3,600 since May.";

/** P25 A: a line in today's ruled space. */
const netLine = (
	<>
		<AccountsWith chart={<NetLine />} sentence={SINCE_MAY} />
		{BANKS.map((b) => (
			<BankGroup {...b} />
		))}
	</>
);

/** P25 B: month-end bars. */
const netBars = (
	<>
		<AccountsWith chart={<NetBars />} sentence={SINCE_MAY} />
		{BANKS.map((b) => (
			<BankGroup {...b} />
		))}
	</>
);

/** P26 B: each account row with its own small line. */
function SparkRow({
	name,
	mask,
	cents,
	pts,
	credit,
}: {
	name: string;
	mask: string;
	cents: number;
	pts: string;
	credit?: boolean;
}) {
	return (
		<li class="flex h-16 items-center gap-3">
			<Icon name={credit ? "card" : "bank"} class="size-7" />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{name}</span>
				<span class="block leading-6 text-muted">••{mask}</span>
			</span>
			<svg viewBox="0 0 64 24" class="h-6 w-16 shrink-0" aria-hidden="true">
				<polyline
					points={pts}
					fill="none"
					stroke-width="1.5"
					class="stroke-ink"
				/>
			</svg>
			<span class="shrink-0 text-lg">{formatCents(cents)}</span>
		</li>
	);
}

const accountSparks = (
	<>
		<AccountsWith chart={<NetLine />} sentence={SINCE_MAY} />
		<section class="mt-8">
			<h2 class="text-muted">Chase</h2>
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				<SparkRow
					name="Checking"
					mask="4410"
					cents={624000}
					pts="0,14 10,8 20,16 30,10 40,18 50,9 64,12"
				/>
				<SparkRow
					name="Savings"
					mask="8812"
					cents={1850000}
					pts="0,20 16,18 32,14 48,9 64,4"
				/>
			</ul>
		</section>
	</>
);

/** P26 C: an account's own page, reached by tapping its row. */
const accountPage = (
	<>
		<p class="inline-flex min-h-11 items-center text-accent">Accounts</p>
		<p class="text-sm text-muted">Chase · ••8812</p>
		<Title>Savings</Title>
		<p class="mt-2 font-serif text-6xl font-semibold tracking-tight">
			{dollars(1850000)}
		</p>
		<p class="mt-1 font-serif text-lg italic">Up $2,100 since May.</p>
		<NetLine />
	</>
);

// ---------------------------------------------------------------------------------------------
// P27–P28: Documents.

type Doc = { name: string; meta: string; note?: string };
const DOCS: Doc[] = [
	{
		name: "chase-statement-sep.pdf",
		meta: "Added Oct 2 · 412 KB",
		note: "September statement",
	},
	{ name: "costco-receipt-0909.pdf", meta: "Added Sep 9 · 88 KB" },
	{
		name: "chase-statement-aug.pdf",
		meta: "Added Sep 3 · 398 KB",
		note: "August statement",
	},
];

/** One document: its name (a link that downloads it), its note, and when it was added and its size. */
function DocRow({ doc, end }: { doc: Doc; end?: Child }) {
	return (
		<li class="flex min-h-16 items-center gap-3 py-2">
			<span class="min-w-0 flex-1">
				<a href="#p27-documents" class="block truncate text-lg leading-6">
					{doc.name}
				</a>
				{doc.note && <span class="block leading-6">{doc.note}</span>}
				<span class="block leading-6 text-muted">{doc.meta}</span>
			</span>
			{end}
		</li>
	);
}

const docList = (
	<ul class="mt-4 divide-y divide-rule border-y border-rule">
		{DOCS.map((d) => (
			<DocRow
				doc={d}
				end={
					<Button kind="text" type="button">
						Delete
					</Button>
				}
			/>
		))}
	</ul>
);

const docsWithButton = (
	<>
		<Title>Documents</Title>
		<p class="mt-2 text-muted">Statements and receipts, as PDFs.</p>
		<div class="mt-3">
			<Button kind="secondary" type="button">
				Add a document
			</Button>
		</div>
		{docList}
	</>
);

/** The upload form: the file, an optional note, and Upload. */
const uploadFields = (
	<>
		<TextInput
			id="p27-file"
			label="PDF file"
			type="file"
			accept="application/pdf"
			hint="Up to 10 MB."
			surface="paper"
		/>
		<TextInput id="p27-note" label="Note (optional)" surface="paper" />
	</>
);

/** P27 A: Add a document opens the form in a bottom sheet. */
const uploadSheet = (
	<Sheet behind={docsWithButton}>
		<h2 class="font-serif text-4xl font-semibold tracking-tight">
			Add a document
		</h2>
		{uploadFields}
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				Upload
			</Button>
		</div>
	</Sheet>
);

/** P27 B: the form always at the top of the page. */
const uploadInline = (
	<>
		<Title>Documents</Title>
		<div class="mt-4 flex flex-col gap-3 border-b border-rule pb-4">
			{uploadFields}
			<div>
				<Button type="button">Upload</Button>
			</div>
		</div>
		<ul class="divide-y divide-rule">
			{DOCS.slice(0, 2).map((d) => (
				<DocRow
					doc={d}
					end={
						<Button kind="text" type="button">
							Delete
						</Button>
					}
				/>
			))}
		</ul>
	</>
);

/** P28 A: Delete turns its row into the confirm step, in place. */
const deleteInRow = (
	<>
		<Title>Documents</Title>
		<div class="mt-3">
			<Button kind="secondary" type="button">
				Add a document
			</Button>
		</div>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			<li class="flex flex-col gap-2 bg-band px-3 py-3">
				<p role="alert" class="text-lg">
					Delete chase-statement-sep.pdf? This can't be undone.
				</p>
				<div class="flex items-center gap-3">
					<Button kind="secondary" type="button">
						Delete it
					</Button>
					<Button kind="text" type="button">
						Keep
					</Button>
				</div>
			</li>
			{DOCS.slice(1).map((d) => (
				<DocRow
					doc={d}
					end={
						<Button kind="text" type="button">
							Delete
						</Button>
					}
				/>
			))}
		</ul>
	</>
);

/** P28 B: Delete goes to a confirm page, as Disconnect a bank does (decision 59). */
const deletePage = (
	<>
		<p class="inline-flex min-h-11 items-center text-accent">Documents</p>
		<Title>Delete this document?</Title>
		<p class="mt-3 text-lg">chase-statement-sep.pdf</p>
		<p class="text-muted">September statement · Added Oct 2 · 412 KB</p>
		<p class="mt-3">The file is deleted for good. This can't be undone.</p>
		<div class="mt-5 grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Keep it
			</Button>
			<Button type="button" class="w-full">
				Delete it
			</Button>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// P29–P30: AI suggestions in Settings.

/** A list row whose merchant has a suggested name: the suggestion shows with a dashed underline (not decided yet). */
export function SuggestedRow({
	name,
	cents,
	cat,
	maybe,
	plain,
}: {
	name: string;
	cents: number;
	cat?: Cat;
	/** P29 B: the tidied name stays and the caption line offers the suggestion. */
	maybe?: string;
	/** A name nobody is guessing at (P87): no dashed underline. */
	plain?: boolean;
}) {
	return (
		<li class="flex h-16 items-center gap-4">
			{cat ? (
				<CategoryIcon icon={cat.icon} color={cat.color} />
			) : (
				<span class="shrink-0 text-muted">
					<Icon name="circle-dashed" class="size-7" />
				</span>
			)}
			<span class="min-w-0 flex-1">
				<span
					class={`block truncate text-lg leading-6 ${maybe || plain ? "" : "underline decoration-muted decoration-dashed underline-offset-4"}`}
				>
					{name}
				</span>
				<span class="block truncate leading-6 text-muted">
					{cat?.name ?? "Needs category"}
					{maybe && ` · Maybe “${maybe}”`}
				</span>
			</span>
			<span class="shrink-0 text-lg">
				{formatCents(cents, { signed: true })}
			</span>
		</li>
	);
}

/** P29 A: suggested names show in the list, dashed, until someone keeps or changes them. */
const namesInList = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">
			Dashed names are suggestions. Tap one to keep it or pick another.
		</p>
		<ul class="mt-2 divide-y divide-rule">
			<SuggestedRow
				name="Blue Bottle Coffee"
				cents={650}
				cat={CATS.eatingOut}
			/>
			<SuggestedRow name="Amazon" cents={3418} cat={CATS.household} />
			<li class="flex h-16 items-center gap-4">
				<CategoryIcon icon="groceries" color="cat-blue" />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">Trader Joe's</span>
					<span class="block leading-6 text-muted">Groceries</span>
				</span>
				<span class="shrink-0 text-lg">$82.17</span>
			</li>
			<SuggestedRow name="Lupita's Taqueria" cents={2240} />
		</ul>
	</>
);

/** P29 B: the tidied name stays, and the caption line offers the suggestion. */
const namesMaybe = (
	<>
		<Title>Transactions</Title>
		<ul class="mt-2 divide-y divide-rule">
			<SuggestedRow
				name="Blue bottle cof"
				cents={650}
				cat={CATS.eatingOut}
				maybe="Blue Bottle Coffee"
			/>
			<SuggestedRow
				name="Amzn mktp"
				cents={3418}
				cat={CATS.household}
				maybe="Amazon"
			/>
			<li class="flex h-16 items-center gap-4">
				<CategoryIcon icon="groceries" color="cat-blue" />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">Trader Joe's</span>
					<span class="block leading-6 text-muted">Groceries</span>
				</span>
				<span class="shrink-0 text-lg">$82.17</span>
			</li>
			<SuggestedRow name="Lupitas taq" cents={2240} maybe="Lupita's Taqueria" />
		</ul>
	</>
);

/**
 * Up to three suggested names as chips, the bank's tidied name, and a field for your own. `names`
 * and `keep` draw another merchant. With `source` (P87 A) the muted line that says where the
 * suggestions came from goes under them, and the tidied name moves below that line.
 */
export function NameChoices({
	id,
	names = ["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"],
	keep = "Blue bottle cof",
	source,
}: {
	id: string;
	names?: string[];
	keep?: string;
	source?: Child;
}) {
	const suggested = names.map((n, i) => (
		<Chip type="radio" name={id} value={String(i + 1)} checked={i === 0}>
			{n}
		</Chip>
	));
	const tidied = (
		<Chip type="radio" name={id} value="tidied" checked={names.length === 0}>
			Keep “{keep}”
		</Chip>
	);
	return (
		<fieldset class="flex flex-col gap-2">
			<legend class="text-base text-ink">Name</legend>
			{source ? (
				<>
					<div class="flex flex-col gap-1">
						<div class="flex flex-wrap gap-2">{suggested}</div>
						{source}
					</div>
					<div class="flex flex-wrap gap-2 pt-1">{tidied}</div>
				</>
			) : (
				<div class="flex flex-wrap gap-2">
					{suggested}
					{tidied}
				</div>
			)}
			<TextInput id={`${id}-own`} label="Or your own" surface="paper" />
			<p class="text-sm text-muted">
				For all 9 transactions from this merchant.
			</p>
		</fieldset>
	);
}

/** The edit panel over a list: the bank's text and the amount, the name's part as `children`, Cancel and Save. */
export function NamesPanel({
	behind,
	children,
}: {
	behind: Child;
	children?: Child;
}) {
	return (
		<Sheet behind={behind}>
			<div>
				<p class="text-sm text-muted">SQ *BLUE BOTTLE COF 0412</p>
				<p class="font-serif text-4xl font-semibold">−$6.50</p>
			</div>
			{children}
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
}

/** Both: the edit panel's name choice. */
const namesPanel = (
	<NamesPanel behind={namesInList}>
		<NameChoices id="p29-panel" />
	</NamesPanel>
);

/** Both: when there's time, a Band on Settings leads to one merchant at a time, like Organize. */
const namesOneAtATime = (
	<>
		<p class="inline-flex min-h-11 items-center text-accent">Settings</p>
		<Title>Merchant names</Title>
		<p class="mt-1 text-muted">1 of 12 · 9 transactions</p>
		<p class="mt-4 text-sm text-muted">The bank says</p>
		<p class="mb-4 text-lg">SQ *BLUE BOTTLE COF 0412</p>
		<NameChoices id="p29-flow" />
		<div class="mt-4 grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Skip
			</Button>
			<Button type="button" class="w-full">
				Save and next
			</Button>
		</div>
	</>
);

const namesBand = (
	<>
		<Title>Settings</Title>
		<div class="mt-4">
			<Band href="#p29-names" detail="Suggested names; you choose">
				12 merchant names to check
			</Band>
		</div>
		<h2 class="mt-5 font-serif text-3xl font-semibold">Categories</h2>
		<ul class="mt-2 divide-y divide-rule border-y border-rule">
			{[CATS.groceries, CATS.eatingOut, CATS.kids].map((c) => (
				<li class="flex min-h-11 items-center gap-4 py-2">
					<CategoryIcon icon={c.icon} color={c.color} />
					<span class="flex-1 text-lg">{c.name}</span>
					<Icon name="chevron-right" class="size-5" />
				</li>
			))}
		</ul>
	</>
);

function pet(id: number, name: string, cents: number): ListRow {
	return {
		id,
		date: "2026-09-14",
		amountCents: cents,
		rawName: name,
		displayName: name,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: null,
		categoryName: null,
		categoryIcon: null,
		categoryColor: null,
	};
}
const PET_ROWS = [
	pet(1, "Chewy", 6412),
	pet(2, "Banfield Pet Hospital", 18900),
	pet(3, "Petsmart", 2399),
];

const AMAZON_GIFT = { ...pet(4, "Amazon", 4520), date: "2026-09-20" };

/**
 * P30 A: the suggestion as a dashed row (not decided yet) under Categories, open to its
 * transactions, each ticked to go in. An unticked one is sorted again right away, with an optional
 * note to help; the note field shows only while it's unticked (CSS, no script).
 */
const categoryInline = (
	<>
		<Title>Settings</Title>
		<h2 class="mt-4 font-serif text-3xl font-semibold">Categories</h2>
		<details
			open
			class="mt-3 rounded-control border border-dashed border-ink px-3"
		>
			<summary class="flex min-h-11 list-none items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
				<Icon name="tag" class="size-6" />
				<span class="min-w-0 flex-1">
					<span class="block text-lg">Suggested: Pet Care</span>
					<span class="block text-muted">Untick any that don't belong.</span>
				</span>
			</summary>
			<ul class="divide-y divide-rule border-t border-rule">
				{PET_ROWS.map((r) => (
					<SelectableTransactionRow row={r} checked />
				))}
				<SelectableTransactionRow row={AMAZON_GIFT} />
			</ul>
			<TextInput
				id="p30-note"
				label="A note for Amazon (optional)"
				value="Birthday present"
				hint="Tally sorts it again right away, with your note."
				surface="paper"
			/>
			<div class="flex items-center gap-3 py-3">
				<Button kind="secondary" type="button">
					Create Pet Care with 3
				</Button>
				<Button kind="text" type="button">
					Dismiss
				</Button>
			</div>
		</details>
	</>
);

// ---------------------------------------------------------------------------------------------
// P32: category suggestions where people already are (the owner's ask on P29).

/**
 * A row needing a category, with Jev's best guess (below its threshold) or a new category on its
 * caption line. With a `line` (P89's "what it was", P90 B), the caption runs on after the guess
 * and wraps instead of being cut off, so the row grows past 64px when it needs to.
 */
export function MaybeRow({
	name,
	cents,
	maybe,
	line,
}: {
	name: string;
	cents: number;
	maybe?: string;
	line?: string;
}) {
	return (
		<li
			class={
				maybe && line
					? "flex min-h-16 items-center gap-4 py-2"
					: "flex h-16 items-center gap-4"
			}
		>
			<span class="shrink-0 text-muted">
				<Icon name="circle-dashed" class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{name}</span>
				<span class="flex min-w-0 items-center gap-2 leading-6">
					{maybe && line ? (
						<span class="min-w-0 text-sm leading-6">
							<span class="rounded-control border border-dashed border-ink px-2 text-ink">
								Maybe {maybe}
							</span>
							<span class="text-muted"> · {line}</span>
						</span>
					) : maybe ? (
						<span class="truncate rounded-control border border-dashed border-ink px-2 text-sm text-ink">
							Maybe {maybe}
						</span>
					) : (
						<span class="shrink-0 rounded-control bg-band px-2 text-sm text-ink">
							Needs category
						</span>
					)}
				</span>
			</span>
			<span class="shrink-0 text-lg">
				{formatCents(cents, { signed: true })}
			</span>
		</li>
	);
}

const maybeList = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">4 transactions needing a category in October</p>
		<ul class="mt-2 divide-y divide-rule">
			<MaybeRow name="Lupita's Taqueria" cents={2240} maybe="Eating Out" />
			<MaybeRow
				name="Banfield Pet Hospital"
				cents={18900}
				maybe="new: Pet Care"
			/>
			<MaybeRow name="Shell" cents={4410} maybe="Gas" />
			<MaybeRow name="Venmo" cents={6000} />
		</ul>
	</>
);

const plainList = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">4 transactions needing a category in October</p>
		<ul class="mt-2 divide-y divide-rule">
			<MaybeRow name="Lupita's Taqueria" cents={2240} />
			<MaybeRow name="Banfield Pet Hospital" cents={18900} />
			<MaybeRow name="Shell" cents={4410} />
			<MaybeRow name="Venmo" cents={6000} />
		</ul>
	</>
);

/** Both: in the edit panel the suggestion is the first chip, marked Suggested, with how sure Jev was. */
const maybePanel = (
	<Sheet behind={maybeList}>
		<div>
			<p class="text-sm text-muted">TST* LUPITAS TAQ</p>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Lupita's Taqueria
			</h2>
			<p class="font-serif text-4xl font-semibold">−$22.40</p>
		</div>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-base text-ink">Category</legend>
			<div class="flex flex-wrap gap-2">
				<span class="rounded-full border border-dashed border-ink">
					<Chip
						type="radio"
						name="p32"
						value="2"
						icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
					>
						Eating Out · Suggested
					</Chip>
				</span>
				{[CATS.groceries, CATS.kids, CATS.gas, CATS.household].map((c) => (
					<Chip
						type="radio"
						name="p32"
						value={c.name}
						icon={<CategoryIcon icon={c.icon} color={c.color} />}
					>
						{c.name}
					</Chip>
				))}
			</div>
			<p class="text-sm text-muted">Tally's guess · 64% sure</p>
		</fieldset>
	</Sheet>
);

/** P30 B: its own page from a Band on Settings. */
const categoryPage = (
	<>
		<p class="inline-flex min-h-11 items-center text-accent">Settings</p>
		<p class="text-sm text-muted">Suggested category</p>
		<Title>Pet Care</Title>
		<p class="mt-2 text-lg">
			None of your categories fit these 3 transactions.
		</p>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{PET_ROWS.map((r) => (
				<TransactionRow row={r} />
			))}
		</ul>
		<TextInput
			id="p30-name"
			label="Name"
			value="Pet Care"
			surface="paper"
			class="mt-1"
		/>
		<div class="mt-4 flex items-center justify-between gap-3">
			<Button type="button">Create category</Button>
			<Button kind="text" type="button">
				Dismiss
			</Button>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// P31: empty and early states (decision 54's EmptyState).

const docsEmpty = (
	<>
		<Title>Documents</Title>
		<EmptyState
			kind="add"
			sentence="No documents yet."
			hint="Keep statements and receipts here as PDFs."
		>
			<Button type="button">Add a document</Button>
		</EmptyState>
	</>
);

const trendsEarly = (
	<>
		<Title>Trends</Title>
		<p class="mt-4 text-lg">All spending</p>
		<MonthBars cents={[286000, 124000]} />
		<p class="mt-2 text-muted">
			Trends fill in as months pass. Tally started in September.
		</p>
	</>
);

/** Today's ruled space, with a line saying when the chart starts (AccountsTop's says "arrives later"). */
const netEarly = (
	<>
		<AccountsWith
			sentence="Tally started following your balances today."
			chart={
				<>
					<div
						aria-hidden="true"
						class="mt-6 flex h-20 flex-col justify-between"
					>
						<div class="border-t border-rule" />
						<div class="border-t border-rule" />
						<div class="border-t border-rule" />
						<div class="border-t border-rule" />
						<div class="border-t border-rule" />
					</div>
					<p class="mt-2 text-sm text-muted">
						The chart starts tomorrow, with a second day of balances.
					</p>
				</>
			}
		/>
		<BankGroup {...(BANKS[0] as (typeof BANKS)[number])} />
	</>
);

// ---------------------------------------------------------------------------------------------
// P33: "Why?" links beside what a rule decides, and How Tally works in the family app (decision 65).

type WhyLook = "word" | "mark";

/** A prototype of the "Why?" link: the word in terracotta, or a small circled question mark. */
function Why({ look, topic }: { look: WhyLook; topic: string }) {
	return look === "word" ? (
		<a
			href="#p33-why"
			aria-label={`Why: ${topic}`}
			class="inline-flex min-h-11 items-center text-sm"
		>
			Why?
		</a>
	) : (
		<a
			href="#p33-why"
			class="inline-flex size-11 shrink-0 items-center justify-center text-accent"
		>
			<span class="sr-only">Why: {topic}</span>
			<svg
				viewBox="0 0 24 24"
				class="size-5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.75"
				stroke-linecap="round"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="9" />
				<path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
				<line x1="12" y1="17" x2="12" y2="17.01" />
			</svg>
		</a>
	);
}

/** A group heading with its "Why?" after it. */
function WhyHeading({
	icon,
	tone,
	look,
	children,
}: {
	icon: "check" | "arrow-up";
	tone: string;
	look: WhyLook;
	children: string;
}) {
	return (
		<h2 class="mt-3 flex items-center gap-2 text-sm text-muted">
			<span class={tone}>
				<Icon name={icon} class="size-4" />
			</span>
			{children}
			{look === "word" && <span aria-hidden="true">·</span>}
			<Why look={look} topic={children.toLowerCase()} />
		</h2>
	);
}

/** Trends with its hints: How this works under the title, Why? after the sentence and each group. */
function trendsWhy(look: WhyLook) {
	return (
		<>
			<Title>Trends</Title>
			<a href="#p33-why" class="inline-flex min-h-11 items-center text-sm">
				How this works
			</a>
			<p class="text-lg text-muted">Spent so far in October</p>
			<p class="font-serif text-6xl font-semibold tracking-tight">
				{dollars(SO_FAR.now)}
			</p>
			<p class="mt-1 flex flex-wrap items-center gap-x-2 font-serif text-lg italic">
				{dollars(SO_FAR.before - SO_FAR.now)} less than by this time in
				September.
				<span class="font-sans not-italic">
					<Why look={look} topic="this month against last" />
				</span>
			</p>
			<WhyHeading icon="check" tone="text-ok" look={look}>
				Going well
			</WhyHeading>
			<ul class="divide-y divide-rule border-y border-rule">
				<InsightRow t={GROCERIES} line="5 months under budget" />
				<InsightRow t={KIDS} line="5 months under budget" />
			</ul>
			<WhyHeading icon="arrow-up" tone="text-ink" look={look}>
				Worth a look
			</WhyHeading>
			<ul class="divide-y divide-rule border-y border-rule">
				<InsightRow t={EATING_OUT} line="Up 4 months running" />
			</ul>
		</>
	);
}

/** Transactions with a suggested name, and the edit panel's guess line, each with its Why?. */
function transactionsWhy(look: WhyLook) {
	return (
		<Sheet
			behind={
				<>
					<Title>Transactions</Title>
					<p class="mt-2 flex flex-wrap items-center gap-x-2 text-muted">
						Dashed names are suggestions.
						<Why look={look} topic="suggested names" />
					</p>
					<ul class="divide-y divide-rule">
						<SuggestedRow
							name="Blue Bottle Coffee"
							cents={650}
							cat={CATS.eatingOut}
						/>
						<MaybeRow
							name="Lupita's Taqueria"
							cents={2240}
							maybe="Eating Out"
						/>
					</ul>
				</>
			}
		>
			<div>
				<p class="text-sm text-muted">TST* LUPITAS TAQ</p>
				<h2 class="font-serif text-4xl font-semibold tracking-tight">
					Lupita's Taqueria
				</h2>
				<p class="font-serif text-4xl font-semibold">−$22.40</p>
			</div>
			<div class="flex flex-wrap gap-2">
				<span class="rounded-full border border-dashed border-ink">
					<Chip
						type="radio"
						name={`p33-${look}`}
						value="2"
						icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
					>
						Eating Out · Suggested
					</Chip>
				</span>
				<Chip
					type="radio"
					name={`p33-${look}`}
					value="1"
					icon={<CategoryIcon icon="groceries" color="cat-blue" />}
				>
					Groceries
				</Chip>
			</div>
			<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
				Tally's guess · 64% sure
				{look === "word" && <span aria-hidden="true">·</span>}
				<Why look={look} topic="Tally's guess" />
			</p>
		</Sheet>
	);
}

/** Both: where a Why? leads, as the family sees it: their own numbers, no architecture part. */
const howFamily = (
	<>
		<Title>How Tally works</Title>
		<p class="mt-2 text-muted">
			Each part of Tally in a sentence, worked out with your numbers.
		</p>
		<h2 class="mt-6 font-serif text-3xl font-semibold">Trends</h2>
		<p class="mt-2">
			Trends compares this month with last month and shows which categories are
			going well.
		</p>
		<ul class="mt-3 list-disc pl-5">
			<li>
				This month so far is compared with the same days of last month (Oct 1–5
				against Sep 1–5).
			</li>
			<li>Going well: under budget 3 or more months running.</li>
			<li>Worth a look: spending up 3 or more months running.</li>
		</ul>
		<p class="mt-4 bg-band px-4 py-3">
			<span class="font-semibold">With your numbers: </span>Groceries was under
			its $900 budget in May, June, July, August and September, so it's going
			well.
		</p>
	</>
);

/** P23–P33 on the proposals page, picked (decisions 64 and 65). */
export function Phase4Proposals() {
	return (
		<>
			<Specimen
				id="p23-trends"
				title="P23 · The 6-month chart on Trends"
				tier="visual"
				sentence="Spending by category over the last 6 months, drawn to make budgeting feel worth it. Pick how it's drawn."
			>
				<Fixed>
					the server draws charts as inline SVG, no library (§8), with a title,
					a description and the numbers for screen readers (§9). Category colors
					are for icons only (DESIGN.md), so bars are ink. The 6 months include
					this one so far, dashed (the owner's pick); it isn't judged against
					its budget until it's over.
				</Fixed>
				<NeedsLine>
					the sentences in D and E are worked out by code, not AI: "under budget
					N months running" (3 or more) and "up N months in a row" (3 or more).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option B · A small chart per category",
							note: "The one you liked: every category as a row, with six small bars and last month's total.",
							tradeoff:
								"it shows the shape, but says nothing about how you did.",
							screen: <TrendRows />,
						},
						{
							name: "Option D · Going well, then worth a look",
							note: "Good news first (under budget 5 months running), then the one trend to watch, then every category with its bars.",
							tradeoff:
								"the order changes as months pass, so a category moves around.",
							recommended:
								"it opens with what's going right, which is what brings someone back tomorrow, and still shows every trend.",
							screen: trendsInsights,
						},
						{
							name: "Option E · A tally of good months",
							note: "Each category earns a tally mark for every month under budget; five closes the gate in terracotta, like the logo.",
							tradeoff:
								"playful and on-brand, but it shows wins, not amounts (P24 has those).",
							screen: trendsTally,
						},
						{
							name: "Option F · Against the budget line",
							note: "Each category's six bars against a dashed budget line; a month over it is brick, and the words say which.",
							tradeoff: "honest at a glance, but more brick on the page.",
							screen: trendsBudgetLine,
						},
						{
							name: "D with P24 A, on desktop",
							note: "Desktop keeps the one column (DESIGN.md), only wider; P24's headline comes first.",
							desktop: true,
							screen: trendsDesktop,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p24-compare"
				title="P24 · This month against last month"
				tier="visual"
				sentence="How this month's spending compares with last month's. Pick the layout; it sits at the top of Trends."
			>
				<Fixed>
					a change is a word and an arrow, never color alone, and spending more
					isn't a status, so it stays ink (green and brick mean on track and
					over budget).
				</Fixed>
				<NeedsLine>
					what "last month" is while this one isn't over (drawn: the same days,
					Oct 1–5 against Sep 1–5, so early in a month doesn't always look low).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A headline and the changes",
							note: "What's spent so far as the serif number, a sentence comparing it, then each category's change, biggest first.",
							tradeoff: "words and numbers, no picture of the gap.",
							recommended:
								"one number first and plain words after, as Home does; the 6-month chart is the picture.",
							screen: compareList,
						},
						{
							name: "Option B · Paired bars",
							note: "The same headline, then two thin bars per category: this month and last.",
							tradeoff:
								"the gap is visible, but it's a second chart on one screen.",
							screen: compareBars,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p25-net-worth"
				title="P25 · The net-worth chart"
				tier="visual"
				sentence="Net worth over time on More → Accounts, in the ruled space waiting for it today. Pick its form."
			>
				<Fixed>
					net worth adds every account's balance, debt negative, leaving out the
					Cash account and disconnected banks (decision 60, §8.1). It's drawn
					from balance_history, one balance per account per day (§5).
				</Fixed>
				<NeedsLine>
					how far back it goes (drawn: 6 months, like Trends).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line",
							note: "One line through each week, on the ledger rules, from May to today, with a sentence of the change.",
							tradeoff:
								"no amounts on the chart; the headline and sentence carry them.",
							recommended:
								"balances move daily, so a line is honest, and it fills today's ruled space quietly.",
							screen: netLine,
						},
						{
							name: "Option B · Month-end bars",
							note: "Net worth at the end of each month as bars, this month dashed.",
							tradeoff:
								"the same shape as Trends, but it hides moves inside a month.",
							screen: netBars,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p26-balances"
				title="P26 · Each account's balance"
				tier="visual"
				sentence="Where an account's own balance history shows, if anywhere. The net-worth chart is above each option."
			>
				<Fixed>
					today's balances stay in the bank groups as they are (P11, P12).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Balances only",
							note: "Rows keep today's balance; only net worth gets a chart (P25's drawings).",
							tradeoff: "one account's history isn't shown.",
							recommended:
								"the spec asks for a net-worth chart; per-account history is a later idea.",
							screen: netLine,
						},
						{
							name: "Option B · A small line per account",
							note: "Each account row adds a small line of its balance.",
							tradeoff: "busy on a phone and squeezes the name.",
							screen: accountSparks,
						},
						{
							name: "Option C · An account's own page",
							note: "Tapping an account opens its balance and its chart.",
							tradeoff: "a new page and a new link on every row.",
							screen: accountPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p27-documents"
				title="P27 · Documents and adding one"
				tier="visual"
				sentence="More → Documents lists stored PDFs, newest first; tapping a name downloads it. Pick where Add lives."
			>
				<Fixed>
					PDFs only, kept in R2 with their details in D1 (§5): name, size, who
					added it, when, and a note. Uploading is a plain form post, so it
					needs no script.
				</Fixed>
				<NeedsLine>the largest file allowed (drawn: 10 MB).</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Add a document opens a sheet",
							note: "A secondary button under the title opens the file and note in the bottom sheet.",
							tradeoff: "one tap before the form.",
							recommended:
								"the same as Add a bill and Add cash, and the list is the one thing on the page.",
							screen: uploadSheet,
						},
						{
							name: "Option B · The form on the page",
							note: "The file, note and Upload always at the top.",
							tradeoff:
								"no tap, but the form pushes the list down every visit.",
							screen: uploadInline,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p28-delete"
				title="P28 · Deleting a document"
				tier="visual"
				sentence="Delete removes the file for good, so it asks first. Pick where it asks."
			>
				<Fixed>
					a second step before anything is deleted, and Delete is a terracotta
					text action (DESIGN.md), never beside a primary.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · In the row",
							note: "Delete turns its row into the question, with Delete it and Keep.",
							tradeoff: "the question is small, in a row.",
							recommended:
								"it asks where you tapped, without leaving the list; one file is less than a whole bank.",
							screen: deleteInRow,
						},
						{
							name: "Option B · A confirm page",
							note: "Delete opens a page naming the file, like Disconnect a bank.",
							tradeoff: "a page for a small, common action.",
							screen: deletePage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p29-names"
				title="P29 · Merchant name suggestions"
				tier="visual"
				sentence="Suggested names show where you already are, and you choose one (or your own) whenever it suits you; a review flow in Settings is there when you have time. Pick how a suggestion shows in the list."
			>
				<Fixed>
					suggestions come only through src/ai/suggest-name.ts, made once per
					bank name and kept (§7). A name applies to every transaction from that
					merchant, and a person's own name always wins. Nothing is renamed
					without a tap.
				</Fixed>
				<NeedsLine>
					up to three suggested names per merchant (§5 has room for one), and a
					suggestion showing in the list before anyone accepts it (§7 says
					Settings only).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · The suggestion as the name, dashed",
							note: "The list shows the suggested name with a dashed underline (not decided yet); tapping opens the choice.",
							tradeoff:
								"the list reads well from day one, but a guess shows before anyone agrees to it.",
							recommended:
								"clean names straight away, the dash says it's only a suggestion, and keeping it is one tap.",
							screen: namesInList,
						},
						{
							name: "Option B · “Maybe …” on the caption line",
							note: "The tidied name stays; the line under it says “Maybe Blue Bottle Coffee”.",
							tradeoff:
								"nothing shown is a guess, but the list still reads like a bank statement.",
							screen: namesMaybe,
						},
						{
							name: "Both · Choosing in the edit panel",
							note: "Up to three suggestions as chips, keep the bank's name, or type your own.",
							screen: namesPanel,
						},
						{
							name: "Both · When you have time",
							note: "A Band on Settings leads to one merchant at a time, like Organize, with the same choices.",
							screen: namesOneAtATime,
						},
						{
							name: "Both · The Band on Settings",
							note: "How the review is found; it shows only while names are waiting.",
							screen: namesBand,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p30-new-category"
				title="P30 · A suggested new category"
				tier="visual"
				sentence="When Jev says none of the categories fit, Workers AI suggests a new one from those transactions; a person creates it or dismisses it. Your pick (A), now with a tick on each transaction."
			>
				<Fixed>
					Settings shows each suggestion with the transactions behind it, and
					nothing is created without a person (§7). A new category gets the tag
					icon and the next color, and Jev offers it from then on.
				</Fixed>
				<NeedsLine>
					each transaction is ticked to go in the new category (a person's
					choice); an unticked one is asked about again right away, after the
					page has answered, not overnight (§7 runs Jev only nightly), with its
					note if one is added (Jev isn't told the note today). Product words
					never name Jev; it's "Tally".
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Under Categories",
							note: "A dashed row under the categories, open to its transactions, each ticked to go in; untick one and add a note to have it sorted again.",
							tradeoff: "it sits in the list, so a long list hides it.",
							recommended:
								"your pick; a wrong one is one untick away, and the note helps it land somewhere better.",
							screen: categoryInline,
						},
						{
							name: "Option B · Its own page",
							note: "A page with the transactions, a name to edit, and Create or Dismiss.",
							tradeoff:
								"the name can be changed first, but it's one more page.",
							screen: categoryPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p32-category-maybe"
				title="P32 · Category suggestions where you are"
				tier="visual"
				sentence="Like names, a category suggestion shows in the list as you use the app: Jev's best guess when it wasn't sure enough, or a suggested new category. Pick whether the list shows it."
			>
				<Fixed>
					Jev's pick is already kept with its confidence when it's below the
					threshold (§7, #49), so showing it needs no new AI call. Rows stay one
					link to their panel, so the choice is made in the panel.
				</Fixed>
				<NeedsLine>
					a guess below the threshold shows as a suggestion, never applied
					without a tap.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · “Maybe …” on the row",
							note: "A row needing a category swaps its tag for a dashed “Maybe Eating Out” (or “Maybe new: Pet Care”); the dashed icon still says it needs one.",
							tradeoff: "one more thing on the row.",
							recommended:
								"you see the guess while scanning, and saying yes is two taps.",
							screen: maybeList,
						},
						{
							name: "Option B · Only in the panel",
							note: "Rows stay as today; the suggestion waits in the panel.",
							tradeoff:
								"a calmer list, but the help is hidden until you open a row.",
							screen: plainList,
						},
						{
							name: "Both · The edit panel",
							note: "The suggestion is the first chip, dashed and marked Suggested, with how sure Jev was.",
							screen: maybePanel,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p33-why"
				title="P33 · Why? links"
				tier="visual"
				sentence="A small link beside anything a rule decides, to the part of How Tally works that explains it (decision 65). The owner picked A, the word."
			>
				<Fixed>
					where they go (decision 65): How this works under each screen's title,
					and a Why? after the trends sentence, Going well, Worth a look, the
					net-worth sentence, the suggested-names line, Tally's guess and a
					suggested category. Each is a 44px link with its own name for screen
					readers ("Why? going well"). How Tally works is in the family app too,
					with your numbers and without the architecture part.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · The word “Why?”",
							note: "Terracotta “Why?” after the label, separated by a dot, like How this works.",
							tradeoff: "a few more words on the screen.",
							recommended:
								"terracotta already means “you can tap this”, and a word says what it does without guessing.",
							screen: trendsWhy("word"),
						},
						{
							name: "Option A · Transactions and the panel",
							note: "The same word after the suggested-names line and Tally's guess.",
							screen: transactionsWhy("word"),
						},
						{
							name: "Option B · A small circled ?",
							note: "A terracotta question mark in a circle after the label.",
							tradeoff:
								"quieter, but an icon alone has to be learned, and a ? can read as help or an error.",
							screen: trendsWhy("mark"),
						},
						{
							name: "Option B · Transactions and the panel",
							note: "The same mark after the suggested-names line and Tally's guess.",
							screen: transactionsWhy("mark"),
						},
						{
							name: "Both · Where a Why? leads",
							note: "How Tally works in the family app: the rule in plain words and a worked example with your numbers.",
							family: true,
							screen: howFamily,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p31-empty"
				title="P31 · Empty and early states"
				tier="visual"
				sentence="What each new screen shows before it has anything to show. Sign off as drawn."
			>
				<Fixed>
					an empty list is EmptyState (decision 54); one thing to start uses the
					add sign and the screen's own primary action (decision 55). With no
					suggestions to check, Settings leaves those sections out.
				</Fixed>
				<Options
					options={[
						{
							name: "Documents, none yet",
							note: "The add drawing, one sentence, a hint, and Add a document.",
							screen: docsEmpty,
						},
						{
							name: "Trends, one month in",
							note: "The months it has, and a line saying more fill in.",
							screen: trendsEarly,
						},
						{
							name: "Net worth, before history",
							note: "The ruled space, saying when the chart starts, until there are two days of balances.",
							screen: netEarly,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
