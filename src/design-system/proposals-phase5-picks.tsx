// P91–P109 (spec §5, §6, §8.4, §8.5, decision 82): the owner's picks on the open questions of
// #198–#203 and #207, each drawn from the pictures the owner chose from. Every one is marked
// Picked: the owner decided by seeing, so none of them has options to weigh. A piece that is new
// (the stamp, the category bars, the month dots, the forecast chart, the "as of" tag, the amber
// bar) is drawn plainly here in tokens; it becomes a real component, through the catalog first,
// when its issue is built (DESIGN.md "Process for a UI change"). Where a drawing has no real
// component yet, it follows the owner's picture; where one exists, the real one draws it.

import type { Child } from "hono/jsx";
import type { BillStatus } from "../bills/status";
import { type CategorySummary, statusSentence } from "../budget";
import { formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import {
	BillRow,
	type BillRowData,
	BillStatusHeading,
} from "../views/bill-row";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { Switch } from "../views/switch";
import { TextInput } from "../views/text-input";
import { TimeZoneRow } from "../views/time-zone-row";
import { WhyLink } from "../views/why-link";
import { Fixed, Options, Replaces, Sheet, Title } from "./proposal-parts";
import { LedgerField } from "./proposals-forms";
import {
	bill,
	CAR,
	ELECTRIC,
	INTERNET,
	LineRow,
	RENT_CAT,
	toPay,
} from "./proposals-phase5-bills";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });
/** Safe to spend below $0: a minus sign and the amount, with cents only when it's under $1. */
const negative = (cents: number) =>
	`−${cents < 100 ? formatCents(cents) : whole(cents)}`;
const sum = (cents: number[]) => cents.reduce((s, c) => s + c, 0);

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style. Every total below is worked out from its rows, so each
// picture adds up.

type Row = {
	name: string;
	/** What the bars under a finished month's number call it (the picture's "Groc.", "Home"). */
	short: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

const CATS = {
	groceries: {
		name: "Groceries",
		short: "Groc.",
		icon: "groceries",
		color: "cat-blue",
	},
	eatingOut: {
		name: "Eating Out",
		short: "Eating",
		icon: "eating-out",
		color: "cat-plum",
	},
	gas: { name: "Gas", short: "Gas", icon: "gas", color: "cat-slate" },
	household: {
		name: "Household",
		short: "Home",
		icon: "household",
		color: "cat-brown",
	},
	utilities: {
		name: "Utilities",
		short: "Util.",
		icon: "utilities",
		color: "cat-ochre",
	},
	kids: { name: "Kids", short: "Kids", icon: "kids", color: "cat-ochre" },
	shopping: {
		name: "Clothing",
		short: "Cloth.",
		icon: "shopping",
		color: "cat-plum",
	},
	gifts: {
		name: "Gifts",
		short: "Gifts",
		icon: "donations",
		color: "cat-blue",
	},
	pets: {
		name: "Pets",
		short: "Pets",
		icon: "personal-care",
		color: "cat-brown",
	},
} as const;

const row = (
	cat: (typeof CATS)[keyof typeof CATS],
	spentCents: number,
	budgetCents: number,
): Row => ({ ...cat, spentCents, budgetCents });

const BUDGETS = {
	groceries: 70000,
	eatingOut: 25000,
	gas: 20000,
	household: 25000,
	utilities: 45000,
};
const BUDGET_CENTS = sum(Object.values(BUDGETS)); // $1,850

/** A month's budgeted rows, in Settings' order. */
const budgeted = (spent: [number, number, number, number, number]): Row[] => [
	row(CATS.groceries, spent[0], BUDGETS.groceries),
	row(CATS.eatingOut, spent[1], BUDGETS.eatingOut),
	row(CATS.gas, spent[2], BUDGETS.gas),
	row(CATS.household, spent[3], BUDGETS.household),
	row(CATS.utilities, spent[4], BUDGETS.utilities),
];

/** What Home counts for a month so far: the rows, spending with no budget, and uncategorized. */
type Month = {
	rows: Row[];
	noBudgetCents: number;
	uncategorizedCents: number;
	billsDueCents: number;
};
const spentOf = (m: Month) =>
	sum(m.rows.map((r) => r.spentCents)) + m.noBudgetCents + m.uncategorizedCents;
/** Spec §6: the whole budget, minus counted spending, minus bills due and unpaid. */
const safeOf = (m: Month) => BUDGET_CENTS - spentOf(m) - m.billsDueCents;

const summaries = (rows: Row[]): CategorySummary[] =>
	rows.map((r, i) => ({
		id: i + 1,
		name: r.name,
		budgetCents: r.budgetCents,
		spentCents: r.spentCents,
		leftCents: r.budgetCents - r.spentCents,
		over: r.spentCents > r.budgetCents,
	}));

// ---------------------------------------------------------------------------------------------
// Home's parts, as the route draws them.

/** Safe to spend's amount at HomeTop's phone size; it never breaks, so a "−" can't sit alone. */
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

/** "Safe to spend · Why?": the label, with the Why? the owner picked (P48 A). */
const safeLabel = (
	<p class="flex flex-wrap items-center gap-x-2 text-lg text-muted">
		Safe to spend
		<span aria-hidden="true">·</span>
		<WhyLink section="budget" topic="safe to spend" />
	</p>
);

/** The Budget heading with Adjust beside it, then its rows. */
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
				{adjust && <AdjustLink adjusting={false} href="#p91-past-month" />}
			</div>
			<ul class="mt-2 divide-y divide-rule">{children}</ul>
			{after}
		</section>
	);
}

const progressRows = (rows: Row[]) =>
	rows.map((r, i) => <ProgressRow {...r} href={`/budget/${i + 1}`} />);

/** A 4px bar on the track, in the given fill; `pct` is how much of the track it covers. */
function Bar({ pct, fill }: { pct: number; fill: string }) {
	return (
		<svg class="mt-2 h-1 w-full" aria-hidden="true">
			<rect width="100%" height="100%" rx="2" class="fill-rule" />
			<rect width={`${pct}%`} height="100%" rx="2" class={fill} />
		</svg>
	);
}

// ---------------------------------------------------------------------------------------------
// The month heading and its strip of dots (P92).

const STRIP = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"] as const;
type Short = (typeof STRIP)[number];
const FULL: Record<Short, string> = {
	May: "May",
	Jun: "June",
	Jul: "July",
	Aug: "August",
	Sep: "September",
	Oct: "October",
};

/** ‹ or ›: a 44px round link, or on this month's › a faded, dashed one with nothing to open. */
function MonthArrow({
	direction,
	to,
}: {
	direction: "previous" | "next";
	to?: Short;
}) {
	const icon = (
		<Icon
			name="chevron-right"
			class={`size-6 ${direction === "previous" ? "rotate-180" : ""}`}
		/>
	);
	if (!to) {
		return (
			<span
				aria-hidden="true"
				class="inline-flex size-11 items-center justify-center rounded-full border border-dashed border-rule text-muted/40"
			>
				{icon}
			</span>
		);
	}
	return (
		<a
			href="#p92-month-dots"
			aria-label={`${direction === "previous" ? "Previous" : "Next"} month, ${FULL[to]}`}
			class="inline-flex size-11 items-center justify-center rounded-full border border-muted text-ink no-underline"
		>
			{icon}
		</a>
	);
}

/**
 * The month's name with ‹ and › beside it, and under them (P92) a dot for every month from the
 * first with transactions to now. The month being looked at is a solid dot; this month's is ringed.
 */
function MonthNav({
	viewing,
	strip = true,
	first = "May",
}: {
	viewing: Short;
	strip?: boolean;
	first?: Short;
}) {
	const i = STRIP.indexOf(viewing);
	const prev = viewing === first ? undefined : STRIP[i - 1];
	const next = STRIP[i + 1];
	return (
		<div>
			<div class="flex items-center gap-3">
				<MonthArrow direction="previous" to={prev} />
				<h1 class="font-serif text-2xl font-semibold tracking-tight">
					{FULL[viewing]}
				</h1>
				<MonthArrow direction="next" to={next} />
			</div>
			{strip && (
				<nav aria-label="Months" class="mt-2">
					<ol class="flex">
						{STRIP.slice(STRIP.indexOf(first)).map((m) => {
							const now = m === "Oct";
							const here = m === viewing;
							return (
								<li>
									<a
										href="#p92-month-dots"
										aria-current={here ? "page" : undefined}
										class="flex min-h-11 w-11 flex-col items-center gap-0.5 text-sm text-muted no-underline"
									>
										<span
											aria-hidden="true"
											class={`size-8 rounded-full ${here ? "bg-ink" : "bg-muted/45"} ${now ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""}`}
										/>
										<span aria-hidden="true">{m}</span>
										<span class="sr-only">
											{FULL[m]}
											{now ? ", this month" : ""}
										</span>
									</a>
								</li>
							);
						})}
					</ol>
				</nav>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// P91: how a past month ended. The stamp, and one small bar for every budgeted category.

/** A tilted stamp: "Under" in green or "Over" in brick, the word carrying the status. */
function Stamp({ kind }: { kind: "under" | "over" }) {
	return (
		<span
			class={`inline-block -rotate-3 rounded-control border-2 px-3 py-0.5 text-xl font-extrabold tracking-widest uppercase ${kind === "under" ? "border-ok text-ok" : "border-over text-over"}`}
		>
			{kind === "under" ? "Under" : "Over"}
			<span class="sr-only"> budget</span>
		</span>
	);
}

/** The tallest a bar is drawn, as a multiple of its budget. A bar over it is capped, and its "+$X" says the rest. */
const BAR_CAP = 1.25;

/**
 * How tall a bar is against its dashed budget line, as a multiple of the budget: never NaN or
 * Infinity, and never past the cap. Spending against a $0 budget is over by all of it, so it draws at
 * the cap; nothing spent (or only refunds) draws as an empty bar.
 */
export function endBarRatio(spentCents: number, budgetCents: number) {
	if (spentCents <= 0) return { ratio: 0, capped: false };
	if (budgetCents <= 0) return { ratio: BAR_CAP, capped: true };
	const ratio = spentCents / budgetCents;
	return ratio > BAR_CAP
		? { ratio: BAR_CAP, capped: true }
		: { ratio, capped: false };
}

/**
 * One bar per budgeted category, each against its own budget, which is the dashed line. A category
 * that went over pokes above the line in brick and says by how much; a bar is capped inside the
 * chart, so its "+$X" is always in view above it. "budget" sits in the right margin, clear of every bar.
 */
function EndBars({ rows }: { rows: Row[] }) {
	const W = 350;
	const left = 4;
	const areaRight = 292;
	const base = 112;
	const unit = 72;
	const width = 42;
	const n = rows.length;
	const step = n > 1 ? Math.min(66, (areaRight - left - width) / (n - 1)) : 66;
	const x0 = left + (areaRight - left - ((n - 1) * step + width)) / 2;
	const lineY = base - unit;
	const words = rows
		.map((r) => `${r.name} ${whole(r.spentCents)} of ${whole(r.budgetCents)}`)
		.join(", ");
	return (
		<svg
			viewBox={`0 0 ${W} 142`}
			class="mt-4 w-full"
			role="img"
			aria-label={`Spent against each budget: ${words}`}
		>
			<line
				x1={left}
				x2={areaRight}
				y1={lineY}
				y2={lineY}
				class="stroke-muted"
				stroke-width="1"
				stroke-dasharray="4 4"
			/>
			<text x={areaRight + 6} y={lineY + 5} class="fill-muted text-sm">
				budget
			</text>
			{rows.map((r, i) => {
				const over = r.spentCents > r.budgetCents;
				const h = Math.max(
					3,
					Math.round(endBarRatio(r.spentCents, r.budgetCents).ratio * unit),
				);
				const x = x0 + i * step;
				return (
					<g>
						<rect
							x={x}
							y={base - h}
							width={width}
							height={h}
							rx="3"
							class={over ? "fill-over" : "fill-muted/60"}
						/>
						{over && (
							<text
								x={x + width / 2}
								y={base - h - 6}
								text-anchor="middle"
								class="fill-over text-sm font-semibold"
							>
								+{whole(r.spentCents - r.budgetCents)}
							</text>
						)}
						<text
							x={x + width / 2}
							y={base + 20}
							text-anchor="middle"
							class="fill-muted text-sm"
						>
							{r.short}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

/** September, finished: under budget, with Eating Out over. Kids had no budget. */
const SEPTEMBER: Month = {
	rows: budgeted([63600, 28600, 19200, 21000, 41000]),
	noBudgetCents: 3000,
	uncategorizedCents: 0,
	billsDueCents: 0,
};
/** July, finished: Eating Out and Gas over, and Kids had $62 with no budget. */
const JULY: Month = {
	rows: budgeted([68400, 28600, 21200, 21000, 43800]),
	noBudgetCents: 6200,
	uncategorizedCents: 0,
	billsDueCents: 0,
};
/** May, the first month with transactions in the demo: it ended $340 under. */
const MAY: Month = {
	rows: budgeted([59800, 21400, 17600, 12000, 40200]),
	noBudgetCents: 0,
	uncategorizedCents: 0,
	billsDueCents: 0,
};
/** A month with a $0 budget that still spent $45, and Eating Out far over: the bars cap, and each says by how much. */
const STRETCH: Month = {
	rows: [
		...budgeted([61000, 90000, 15000, 18000, 40000]),
		row(CATS.gifts, 4500, 0),
	],
	noBudgetCents: 0,
	uncategorizedCents: 0,
	billsDueCents: 0,
};
/** A finished month's number: its budgets minus its spending; a goal and plans never change it. */
const endedBy = (m: Month) => BUDGET_CENTS - spentOf(m);

/** The top of a finished month's Home: its number and stamp, the bars, and the way back. */
function PastTop({
	viewing,
	month,
	strip = true,
}: {
	viewing: Short;
	month: Month;
	strip?: boolean;
}) {
	const by = endedBy(month);
	const over = by < 0;
	return (
		<>
			<MonthNav viewing={viewing} strip={strip} />
			<p class="mt-4 text-lg text-muted">{FULL[viewing]} ended</p>
			<div class="flex items-center gap-4">
				<Headline tone={over ? "text-over" : ""}>
					{whole(Math.abs(by))}
				</Headline>
				<Stamp kind={over ? "over" : "under"} />
			</div>
			<EndBars rows={month.rows} />
			<a href="#p91-past-month" class="inline-flex min-h-11 items-center">
				Back to October
			</a>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P93: a finished month's rows. Read-only: no links, no sheet, no "left".

/** One finished row: "spent / budget" and a bar, brick with the alert icon when it went over. */
function PastRow({ r }: { r: Row }) {
	const over = r.spentCents > r.budgetCents;
	const { fillPct } = barGeometry(r.spentCents, r.budgetCents);
	return (
		<li class="flex items-start gap-4 py-3">
			<CategoryIcon icon={r.icon} color={r.color} />
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3">
					<span class="text-lg">{r.name}</span>
					<span class={`ml-auto text-right text-lg ${over ? "text-over" : ""}`}>
						{whole(r.spentCents)}{" "}
						<span class="text-muted">/ {whole(r.budgetCents)}</span>
					</span>
				</div>
				<Bar pct={fillPct} fill={over ? "fill-over" : "fill-muted/60"} />
				{over && (
					<p class="mt-1 flex items-center justify-end gap-1 text-over">
						<Icon name="alert" class="size-5" />
						{whole(r.spentCents - r.budgetCents)} over
						<span class="sr-only"> budget</span>
					</p>
				)}
			</div>
		</li>
	);
}

/** The finished month's Not budgeted list: each category and what it spent, with nothing to open. */
function PastNotBudgeted({
	items,
}: {
	items: { name: string; icon: string; color: string; cents: number }[];
}) {
	return (
		<>
			<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
			<ul class="divide-y divide-rule">
				{items.map((c) => (
					<li class="flex min-h-11 items-center gap-4 py-2">
						<CategoryIcon icon={c.icon} color={c.color} />
						<span class="min-w-0 flex-1 truncate text-lg">{c.name}</span>
						<span class="text-lg">{whole(c.cents)}</span>
					</li>
				))}
			</ul>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// The Home top of a month in progress, with what each pick changes passed in.

function Top({
	nav = <MonthNav viewing="Oct" strip={false} />,
	amount,
	tag,
	status,
	bank,
	forecast,
	band,
}: {
	nav?: Child;
	amount: Child;
	/** Beside the amount: P96's "as of Oct 2". */
	tag?: Child;
	status: string;
	/** P96's line for a bank that's behind; it comes before the forecast. */
	bank?: Child;
	forecast?: Child;
	band?: Child;
}) {
	return (
		<>
			{nav}
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					{safeLabel}
					<div class="flex flex-wrap items-center gap-x-3">
						{amount}
						{tag}
					</div>
				</div>
				{/* The picture is a phone: without this, LedgerIllustration's lg: size crowds the amount. */}
				<div class="shrink-0 lg:[&>svg]:size-28">
					<LedgerIllustration />
				</div>
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			{bank}
			{forecast}
			<HowLink section="budget" />
			{band && <div class="mt-4">{band}</div>}
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P94: Safe to spend below $0.

/** October gone over: Groceries and Eating Out are over, and bills due take Safe to spend to −$40. */
const BELOW: Month = {
	rows: budgeted([74200, 28600, 19800, 8200, 44000]),
	noBudgetCents: 0,
	uncategorizedCents: 0,
	billsDueCents: 14200,
};
/** …and the same month with $40 less spent in Household, so it ends 40¢ below $0. */
const JUST_BELOW: Month = {
	...BELOW,
	rows: budgeted([74200, 28600, 19800, 4240, 44000]),
};
const OVER_SENTENCE =
	"Over budget this month. Spending more takes it further over.";

const belowZero = (m: Month) => (
	<>
		<Top
			amount={<Headline tone="text-over">{negative(-safeOf(m))}</Headline>}
			status={OVER_SENTENCE}
		/>
		<Budget>{progressRows(m.rows)}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P95: the forecast. A small line chart of the month's spending so far, dashed on to the month's
// end, against the dashed budget line.

type Pace = {
	/** Today's day of the month, and how many days the month has. */
	day: number;
	daysInMonth: number;
	/** Counted spending so far (refunds already taken off), and the part of it that paid a bill. */
	soFarCents: number;
	paysBillsCents: number;
	/** The part of it that paid a planned expense: a one-off, like a bill, so it isn't projected either. */
	paysPlansCents: number;
	/** Refunds received so far: they lower the spending so far but are never projected forward. */
	refundsCents: number;
	/** Bills due this month that aren't paid. */
	billsDueCents: number;
};
/** Money out so far that doesn't pay a bill or a plan, with refunds added back, so the pace never projects them. */
const everydayOut = (p: Pace) =>
	p.soFarCents - p.paysBillsCents - p.paysPlansCents + p.refundsCents;
/** The rule: spending so far, plus the bills still due, plus the everyday pace times the days left. */
const forecastEnd = (p: Pace) =>
	p.soFarCents +
	p.billsDueCents +
	Math.round((everydayOut(p) * (p.daysInMonth - p.day)) / p.day);

/** How the days of spending ran up to today: a plain shape, scaled so it ends on the real total. */
const WEIGHTS = [3, 5, 1, 7, 2, 9, 4, 1, 6, 8, 2, 5, 1, 7, 4];
const cumulative = (total: number, days: number) => {
	const w = WEIGHTS.slice(0, days);
	const all = sum(w);
	let seen = 0;
	return w.map((x, i) => {
		seen += x;
		return i === w.length - 1 ? total : Math.round((total * seen) / all);
	});
};

/** Oct 15, on pace to finish under: the pace is $45 a day, and $205 in bills is still due. */
const UNDER_MONTH: Month = {
	rows: budgeted([29000, 21000, 9200, 6000, 8300]),
	noBudgetCents: 4000,
	uncategorizedCents: 3000,
	billsDueCents: 20500,
};
const UNDER_PACE: Pace = {
	day: 15,
	daysInMonth: 31,
	soFarCents: spentOf(UNDER_MONTH),
	paysBillsCents: 13000, // Swim lessons $60 and Internet $70
	paysPlansCents: 0,
	refundsCents: 0,
	billsDueCents: UNDER_MONTH.billsDueCents,
};
/** Oct 15, on pace to finish over: Eating Out is already $25 over and the pace is $53 a day. */
const OVER_MONTH: Month = {
	rows: budgeted([38000, 27500, 11000, 6000, 8300]),
	noBudgetCents: 1000,
	uncategorizedCents: 700,
	billsDueCents: 20500,
};
const OVER_PACE: Pace = { ...UNDER_PACE, soFarCents: spentOf(OVER_MONTH) };

/** The chart and its one sentence. An amount under rounds down and one over rounds up. */
function Forecast({ pace }: { pace: Pace }) {
	const end = forecastEnd(pace);
	const diff = BUDGET_CENTS - end;
	const under = diff >= 0;
	const shown = under
		? Math.floor(diff / 100) * 100
		: Math.ceil(-diff / 100) * 100;
	const left = 10;
	const right = 340;
	const top = 34;
	const base = 142;
	const ymax = Math.max(BUDGET_CENTS, end, pace.soFarCents);
	const x = (d: number) =>
		left + ((d - 1) / (pace.daysInMonth - 1)) * (right - left);
	const y = (c: number) => base - (c / ymax) * (base - top);
	const line = cumulative(pace.soFarCents, pace.day)
		.map((c, i) => `${x(i + 1).toFixed(1)},${y(c).toFixed(1)}`)
		.join(" ");
	return (
		<figure class="mt-3">
			<svg
				viewBox="0 0 350 172"
				class="w-full"
				role="img"
				aria-label={`Spending in October so far, and where it ends at this pace: ${whole(shown)} ${under ? "under" : "over"} the ${whole(BUDGET_CENTS)} budget by Oct ${pace.daysInMonth}`}
			>
				<line
					x1={left}
					x2={right}
					y1={y(BUDGET_CENTS)}
					y2={y(BUDGET_CENTS)}
					class="stroke-muted"
					stroke-width="1"
					stroke-dasharray="4 4"
				/>
				<text x={left} y={y(BUDGET_CENTS) - 7} class="fill-muted text-sm">
					budget {whole(BUDGET_CENTS)}
				</text>
				<polyline
					points={line}
					fill="none"
					class="stroke-ink"
					stroke-width="2.5"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
				<line
					x1={x(pace.day)}
					y1={y(pace.soFarCents)}
					x2={x(pace.daysInMonth)}
					y2={y(end)}
					class={under ? "stroke-ok" : "stroke-over"}
					stroke-width="2.5"
					stroke-dasharray="6 5"
					stroke-linecap="round"
				/>
				<circle
					cx={x(pace.day)}
					cy={y(pace.soFarCents)}
					r="4.5"
					class="fill-ink"
				/>
				<circle
					cx={x(pace.daysInMonth)}
					cy={y(end)}
					r="5.5"
					class={under ? "fill-ok" : "fill-over"}
				/>
				<text x={left} y="166" class="fill-muted text-sm">
					Oct 1
				</text>
				<text x={right} y="166" text-anchor="end" class="fill-muted text-sm">
					Oct {pace.daysInMonth}
				</text>
			</svg>
			<figcaption class="mt-2 flex flex-wrap items-baseline gap-x-2">
				<span
					class={`inline-flex items-center gap-1.5 font-serif text-4xl font-semibold ${under ? "text-ok" : "text-over"}`}
				>
					{!under && <Icon name="alert" class="size-6" />}
					{whole(shown)} {under ? "under" : "over"}
				</span>
				<span class="text-lg text-muted">
					by Oct {pace.daysInMonth}, at this pace
				</span>
			</figcaption>
		</figure>
	);
}

/** The worked rule under the drawing, so the owner can check the picture adds up. */
const workedPace = (p: Pace) => {
	const everyday = everydayOut(p);
	const left = p.daysInMonth - p.day;
	const perDay = Math.round(everyday / p.day);
	return `Oct ${p.day}: ${whole(p.soFarCents)} spent, ${whole(p.billsDueCents)} in bills still due, and ${whole(Math.round((everyday * left) / p.day))} more at about ${whole(perDay)} a day for ${left} days, so ${whole(forecastEnd(p))} against ${whole(BUDGET_CENTS)}.`;
};

const withForecast = (m: Month, p: Pace) => (
	<>
		<Top
			amount={<Headline>{whole(safeOf(m))}</Headline>}
			status={statusSentence(summaries(m.rows))}
			forecast={<Forecast pace={p} />}
		/>
		<Budget>{progressRows(m.rows.slice(0, 3))}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P96: a bank that's behind.

/** A dashed tag on Safe to spend: the number is as of that day. */
function AsOf({ date }: { date: string }) {
	return (
		<span class="inline-flex min-h-8 items-center rounded-full border border-dashed border-muted px-3 text-sm text-muted">
			as of {date}
		</span>
	);
}

/** A soft brick-tinted line with the bank icon, what happened, and a Fix button to Accounts. */
function BankBehind({ words }: { words: string }) {
	return (
		<div class="mt-3 flex items-center gap-3 rounded-control border border-over/20 bg-over/10 py-2 pr-2 pl-3">
			<span class="shrink-0 text-over">
				<Icon name="bank" class="size-6" />
			</span>
			<p class="min-w-0 flex-1 text-pretty">{words}</p>
			<Button href="/accounts" kind="secondary" class="shrink-0 px-4">
				Fix<span class="sr-only"> the bank in Accounts</span>
			</Button>
		</div>
	);
}

const bankBehind = (words: string) => (
	<>
		<Top
			amount={<Headline>{whole(safeOf(UNDER_MONTH))}</Headline>}
			tag={<AsOf date="Oct 12" />}
			status={statusSentence(summaries(UNDER_MONTH.rows))}
			bank={<BankBehind words={words} />}
			forecast={<Forecast pace={UNDER_PACE} />}
		/>
		<Budget>{progressRows(UNDER_MONTH.rows.slice(0, 2))}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P97: older ones need a category.

/** Oct 5, in the demo's style: 12 need a category this month ($228), and some from earlier months. */
const FIVE_OCT: Month = {
	rows: budgeted([31200, 28600, 18600, 3000, 12000]),
	noBudgetCents: 14000,
	uncategorizedCents: 22800,
	billsDueCents: 14200,
};

/** The Band's first line carries a small "+1 older" chip; the second line is this month's amount. */
function OlderBand({ older, count }: { older: number; count: number }) {
	return (
		<a
			href="#p97-older-chip"
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-lg text-ink no-underline"
		>
			<span class="min-w-0">
				<span class="flex flex-wrap items-center gap-x-2">
					<span>
						{count}
						<span class="sr-only"> transactions</span> need a category
					</span>
					<span class="rounded-full bg-rule px-2.5 py-0.5 text-sm text-ink">
						+{older} older
						<span class="sr-only"> from earlier months</span>
					</span>
				</span>
				<span class="block text-base text-muted">
					{whole(FIVE_OCT.uncategorizedCents)} of this month's spending
				</span>
			</span>
			<Icon name="chevron-right" />
		</a>
	);
}

const olderHome = (band: Child) => (
	<>
		<Top
			amount={<Headline>{whole(safeOf(FIVE_OCT))}</Headline>}
			status={statusSentence(summaries(FIVE_OCT.rows))}
			band={band}
		/>
		<Budget>{progressRows(FIVE_OCT.rows.slice(0, 2))}</Budget>
	</>
);

// ---------------------------------------------------------------------------------------------
// P98: budget rows. Refunds outweighing spending, nearly spent, and a $0 budget.

/** A row as ProgressRow lays it out, with the bar's fill and the amount given. */
function StateRow({
	cat,
	amount,
	pct,
	fill,
	caption,
}: {
	cat: { name: string; icon: string; color: string };
	amount: Child;
	pct: number;
	fill: string;
	caption?: string;
}) {
	return (
		<li>
			<a
				href="#p98-row-states"
				class="flex items-start gap-4 py-3 text-ink no-underline"
			>
				<CategoryIcon icon={cat.icon} color={cat.color} />
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline justify-between gap-x-3">
						<span>
							<span class="block text-lg">{cat.name}</span>
							{caption && <span class="block text-muted">{caption}</span>}
						</span>
						<span class="ml-auto text-right text-lg">{amount}</span>
					</div>
					<Bar pct={pct} fill={fill} />
				</div>
			</a>
		</li>
	);
}

/** Home's Not budgeted rows: what each spent, or "+$15" in green when its refunds outweigh it. */
function NotBudgetedRow({
	cat,
	line,
	action = "Add a budget",
}: {
	cat: { name: string; icon: string; color: string };
	line?: Child;
	action?: string;
}) {
	return (
		<li>
			<a
				href="#p98-row-states"
				class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline"
			>
				<CategoryIcon icon={cat.icon} color={cat.color} />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg">{cat.name}</span>
					{line}
				</span>
				<span class="text-accent">{action}</span>
			</a>
		</li>
	);
}

/** "+$20" in green: more came back than went out. The plus sign and the words carry it, not color. */
const backWords = (cents: number) => (
	<span class="text-ok">
		+{whole(cents)}
		<span class="sr-only"> back: refunds outweigh spending</span>
	</span>
);

const rowStates = (
	<Budget
		after={
			<>
				<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
				<ul class="divide-y divide-rule">
					<NotBudgetedRow
						cat={CATS.pets}
						line={<span class="block text-ok">{backWords(1500)}</span>}
					/>
					<NotBudgetedRow
						cat={CATS.kids}
						line={<span class="block text-muted">{whole(6000)} spent</span>}
					/>
				</ul>
			</>
		}
	>
		{/* Nearly spent: 80% or more and not over, so the bar is amber (cat-ochre stands in for the new token). */}
		<StateRow
			cat={CATS.groceries}
			amount={
				<>
					{whole(55300)} of {whole(65000)}
					<span class="sr-only">, nearly spent</span>
				</>
			}
			pct={barGeometry(55300, 65000).fillPct}
			fill="fill-cat-ochre"
		/>
		{/* Refunds outweigh spending: "+$20" in green and an empty bar. */}
		<StateRow
			cat={CATS.shopping}
			caption={`${whole(25000)} budget`}
			amount={backWords(2000)}
			pct={0}
			fill="fill-ok"
		/>
		{/* A $0 budget with nothing spent: no warning, an empty bar. */}
		<StateRow
			cat={CATS.gifts}
			amount={
				<>
					{whole(0)} of {whole(0)}
				</>
			}
			pct={0}
			fill="fill-ok"
		/>
	</Budget>
);

// ---------------------------------------------------------------------------------------------
// P99: the budget sheet's link to its transactions.

const behindBudget = (
	<Budget adjust={false}>
		<StateRow
			cat={CATS.groceries}
			amount={
				<>
					{whole(55300)} of {whole(65000)}
				</>
			}
			pct={barGeometry(55300, 65000).fillPct}
			fill="fill-cat-ochre"
		/>
		<ProgressRow
			{...row(CATS.eatingOut, 15000, 25000)}
			href="#p99-sheet-link"
		/>
		<ProgressRow {...row(CATS.gifts, 0, 0)} href="#p99-sheet-link" />
	</Budget>
);

/** "12 transactions ›": a pill button under what's spent, shown only when there are some. */
function TransactionsButton({ count }: { count: number }) {
	return (
		<a
			href="#p99-sheet-link"
			class="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full border border-ink px-4 font-medium text-ink no-underline"
		>
			{count} transactions
			<Icon name="chevron-right" class="size-5" />
		</a>
	);
}

function BudgetSheet({
	cat,
	spent,
	count,
	value,
}: {
	cat: { name: string; icon: string; color: string };
	spent: number;
	count: number;
	value: string;
}) {
	return (
		<Sheet behind={behindBudget}>
			<div class="flex items-center gap-3">
				<CategoryIcon icon={cat.icon} color={cat.color} />
				<h2 class="font-serif text-3xl font-semibold">{cat.name}</h2>
			</div>
			<div>
				<p class="text-muted">{formatCents(spent)} spent so far in October</p>
				{count > 0 && <TransactionsButton count={count} />}
			</div>
			<div class="flex flex-col gap-4 border-t border-rule pt-4">
				<MoneyInput
					id={`p99-${cat.name.toLowerCase()}`}
					name="budget"
					label="Budget from October on"
					value={value}
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
}

// ---------------------------------------------------------------------------------------------
// P100: taking the savings goal away.

/** A row under Home's Budget list, the savings goal's: the bank icon, "Savings" and what it says. */
function GoalNotBudgeted() {
	return (
		<>
			<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
			<ul class="divide-y divide-rule">
				<li>
					<a
						href="#p100-goal-away"
						class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline"
					>
						<span class="shrink-0 text-ink">
							<Icon name="bank" class="size-7" />
						</span>
						<span class="min-w-0 flex-1 truncate text-lg">Savings</span>
						<span class="text-accent">Set a goal</span>
					</a>
				</li>
				<NotBudgetedRow
					cat={CATS.kids}
					line={<span class="block text-muted">{whole(6000)} spent</span>}
				/>
			</ul>
		</>
	);
}

const goalGone = (
	<>
		<Top
			amount={<Headline>{whole(safeOf(FIVE_OCT))}</Headline>}
			status={statusSentence(summaries(FIVE_OCT.rows))}
		/>
		<Budget after={<GoalNotBudgeted />}>
			{progressRows(FIVE_OCT.rows.slice(0, 2))}
		</Budget>
	</>
);

const goalSheetAtZero = (
	<Sheet behind={goalGone}>
		<div class="flex items-center gap-3">
			<Icon name="bank" class="size-7" />
			<h2 class="font-serif text-3xl font-semibold">Savings</h2>
		</div>
		<p class="text-muted">
			Set aside from Safe to spend at the start of every month.
		</p>
		<div class="flex flex-col gap-4 border-t border-rule pt-4">
			<MoneyInput
				id="p100-goal"
				name="goal"
				label="Save each month, from October on"
				value="0.00"
			/>
			<p class="text-muted">
				A goal of $0 takes the goal away from October on.
			</p>
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

// ---------------------------------------------------------------------------------------------
// Bills, for P101–P106 (planned expenses and the bills total).

const BILLS_TODAY = "2026-10-05";
const NOV_TODAY = "2026-11-05";
const RENT_PAID = bill(6, "Rent", 120000, "paid", "2026-10-01", RENT_CAT);

type Plan = { name: string; cents: number; line: string; paid?: boolean };

/** One planned expense, shaped like a BillRow: the tag icon, its name, a muted line and the amount. */
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

const plannedHeading = (
	<h2 class="flex items-center gap-2 text-sm text-muted">
		<span class="text-muted">
			<Icon name="tag" class="size-4" />
		</span>
		Planned
	</h2>
);

/** A status group: its heading, with a total at the right when it has one, then its rows. */
function Group({
	status,
	heading,
	total,
	children,
}: {
	status?: BillStatus;
	heading?: Child;
	total?: string;
	children?: Child;
}) {
	return (
		<section class="mt-4">
			<div class="flex items-center justify-between gap-3">
				{heading ?? <BillStatusHeading status={status ?? "due"} />}
				{total && <span class="text-sm text-muted">{total}</span>}
			</div>
			<ul class="divide-y divide-rule">{children}</ul>
		</section>
	);
}

const bills = (list: BillRowData[], today = BILLS_TODAY) =>
	list.map((b) => <BillRow bill={b} today={today} />);

/** Bills' title, sentence, a quiet line when given, and the two buttons. */
function BillsHead({
	sentence,
	quiet,
	band,
}: {
	sentence: string;
	quiet?: string;
	band?: Child;
}) {
	return (
		<>
			<Title>Bills</Title>
			<p class="mt-2 font-serif text-lg italic">{sentence}</p>
			{quiet && <p class="mt-1 text-muted">{quiet}</p>}
			{band}
			<div class="mt-3 flex flex-wrap gap-3">
				<Button kind="secondary" type="button">
					Add a bill
				</Button>
				<Button kind="secondary" type="button">
					Plan an expense
				</Button>
			</div>
		</>
	);
}

const CAR_REGISTRATION: Plan = {
	name: "Car registration",
	cents: 18000,
	line: "Set aside for October",
};

// P101: linking a plan's payment. Money out from the plan's month and the next, closest amount first.

const PAYMENTS = [
	{ name: "DMV", date: "Nov 3", cents: 18000 },
	{ name: "Costco", date: "Oct 30", cents: 21200 },
	{ name: "Shell", date: "Nov 2", cents: 4500 },
];

const planLink = (
	<>
		<a href="#p101-plan-link" class="inline-flex min-h-11 items-center">
			Bills
		</a>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			Car registration
		</h1>
		<p class="text-lg">
			{formatCents(CAR_REGISTRATION.cents)} · {CAR_REGISTRATION.line}
		</p>
		<section class="mt-6 border-t border-rule pt-4">
			<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
			<p class="mt-2 text-lg">
				To October's Car registration, {formatCents(CAR_REGISTRATION.cents)}.
			</p>
			<p class="mt-1 text-muted">
				Money out in October and November, closest amount first.
			</p>
			<fieldset class="mt-4">
				<legend>Payment</legend>
				<div class="mt-1 flex flex-col gap-2">
					{PAYMENTS.map((p, i) => (
						<Chip
							type="radio"
							name="p101-payment"
							value={p.name}
							checked={i === 0}
						>
							{`${p.name} · ${p.date} · ${formatCents(p.cents)}`}
						</Chip>
					))}
				</div>
			</fieldset>
			<div class="mt-4">
				<Button type="button">Link payment</Button>
			</div>
		</section>
	</>
);

// P102: the plan's own sheet.

const NOV_PLAN: Plan = {
	name: "Car registration",
	cents: 18000,
	line: "Set aside for November",
};

/** Delete, in brick: the word says what it does, and it's an outline so it isn't the loud button. */
const DeleteButton = (
	<button
		type="button"
		class="inline-flex min-h-11 items-center rounded-control border border-over px-5 text-over"
	>
		Delete
	</button>
);

function PlanSheet({ paid }: { paid?: boolean }) {
	return (
		<Sheet
			top={paid ? "top-44" : undefined}
			behind={<BillsHead sentence={toPay(1, ELECTRIC.amountCents)} />}
		>
			<h2 class="font-serif text-3xl font-semibold tracking-tight">
				Car registration
			</h2>
			<div class="flex flex-col gap-2">
				<TextInput
					id={`p102-name-${paid ? "paid" : "open"}`}
					label="What it's for"
					value={NOV_PLAN.name}
					surface="paper"
				/>
				<LedgerField
					big
					prefix="$"
					id={`p102-amount-${paid ? "paid" : "open"}`}
					name="amount"
					label="Amount"
					value="180.00"
					inputmode="decimal"
				/>
				<label class="flex flex-col gap-1">
					<span>Month</span>
					<select
						name={`p102-month-${paid ? "paid" : "open"}`}
						class="min-h-11 rounded-control border border-rule bg-paper px-3"
					>
						<option selected>November 2026</option>
						<option>December 2026</option>
						<option>January 2027</option>
					</select>
				</label>
				{paid && (
					<div class="flex items-center justify-between gap-3 border-t border-rule pt-3">
						<p class="min-w-0">
							<span class="block text-sm text-muted">Paid by</span>
							DMV · Nov 3 · {formatCents(18000)}
						</p>
						<Button kind="secondary" type="button" class="shrink-0 px-4">
							Unlink
							<span class="sr-only"> the DMV payment</span>
						</Button>
					</div>
				)}
			</div>
			<div class="flex flex-wrap gap-3">
				<Button type="button">Save</Button>
				{DeleteButton}
				<Button kind="text" type="button">
					Cancel
				</Button>
			</div>
		</Sheet>
	);
}

// P103: once it's paid, a plan shows with the paid bills.

const HOLIDAY: Plan = {
	name: "Holiday gifts",
	cents: 40000,
	line: "Set aside from December",
};
const RENT_NOV = bill(6, "Rent", 120000, "paid", "2026-11-01", RENT_CAT);
const ELECTRIC_NOV: BillRowData = { ...ELECTRIC, dueDate: "2026-11-08" };

const planPaid = (
	<>
		<BillsHead sentence={toPay(1, ELECTRIC_NOV.amountCents)} />
		<Group status="due">{bills([ELECTRIC_NOV], NOV_TODAY)}</Group>
		<Group heading={plannedHeading}>
			<PlannedRow plan={HOLIDAY} />
		</Group>
		<Group status="paid">
			{bills([RENT_NOV], NOV_TODAY)}
			<PlannedRow plan={{ ...NOV_PLAN, line: "Paid Nov 3" }} />
		</Group>
	</>
);

// P104: the Planned group's own total; plans aren't in the monthly bills total.

const MONTHLY_BILLS =
	ELECTRIC.amountCents +
	INTERNET.amountCents +
	CAR.amountCents +
	RENT_PAID.amountCents;
const STILL_TO_PAY =
	ELECTRIC.amountCents + INTERNET.amountCents + CAR.amountCents;

const planTotals = (
	<>
		<BillsHead
			sentence={toPay(1, ELECTRIC.amountCents)}
			quiet={`${whole(MONTHLY_BILLS)} a month in bills, ${whole(STILL_TO_PAY)} still to pay in October`}
		/>
		<Group status="due" total={formatCents(ELECTRIC.amountCents)}>
			{bills([ELECTRIC])}
		</Group>
		<Group
			status="upcoming"
			total={`${formatCents(INTERNET.amountCents + CAR.amountCents)} this month`}
		>
			{bills([INTERNET, CAR])}
		</Group>
		<Group heading={plannedHeading} total={formatCents(CAR_REGISTRATION.cents)}>
			<PlannedRow plan={CAR_REGISTRATION} />
		</Group>
		<Group status="paid" total={formatCents(RENT_PAID.amountCents)}>
			{bills([RENT_PAID])}
		</Group>
	</>
);

// P105: a plan unpaid when its month ends. The Band asks about one at a time.

/** The Band's two actions and a dot for each plan waiting; the first dot is the one being asked. */
function PlanBand({ plan, of }: { plan: string; of: number }) {
	return (
		<div class="mt-3 bg-band px-4 py-3">
			<p class="text-lg">{plan} wasn't paid</p>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<Button type="button">Move to Nov</Button>
				<Button kind="secondary" type="button">
					Drop
				</Button>
				<span class="ml-auto flex items-center gap-1.5">
					{Array.from({ length: of }, (_, i) => (
						<span
							aria-hidden="true"
							class={`size-2.5 rounded-full ${i === 0 ? "bg-ink" : "bg-muted/40"}`}
						/>
					))}
					<span class="sr-only">1 of {of} plans that weren't paid</span>
				</span>
			</div>
		</div>
	);
}

const planUnpaid = (
	<>
		<BillsHead
			sentence={toPay(1, ELECTRIC_NOV.amountCents)}
			band={<PlanBand plan="Car registration" of={2} />}
		/>
		<Group status="due">{bills([ELECTRIC_NOV], NOV_TODAY)}</Group>
		<Group heading={plannedHeading}>
			<PlannedRow plan={CAR_REGISTRATION} />
			<PlannedRow
				plan={{
					name: "Lawn service",
					cents: 9000,
					line: "Set aside for October",
				}}
			/>
		</Group>
	</>
);

// P106: a part-paid bill in a group's total.

const RENT_PART = bill(6, "Rent", 120000, "overdue", "2026-10-01", RENT_CAT);
const RENT_PAID_SO_FAR = 60000;
const RENT_LEFT = RENT_PART.amountCents - RENT_PAID_SO_FAR;
const PART_MONTHLY =
	RENT_PART.amountCents +
	ELECTRIC.amountCents +
	INTERNET.amountCents +
	CAR.amountCents;
const PART_TO_PAY =
	RENT_LEFT + ELECTRIC.amountCents + INTERNET.amountCents + CAR.amountCents;

const partPaidTotal = (
	<>
		<BillsHead
			sentence={toPay(2, RENT_LEFT + ELECTRIC.amountCents)}
			quiet={`${whole(PART_MONTHLY)} a month in bills, ${whole(PART_TO_PAY)} still to pay in October`}
		/>
		<Group status="overdue" total={formatCents(RENT_LEFT)}>
			<LineRow
				bill={RENT_PART}
				line={`Part paid: ${whole(RENT_PAID_SO_FAR)} of ${whole(RENT_PART.amountCents)}`}
			/>
		</Group>
		<Group status="due" total={formatCents(ELECTRIC.amountCents)}>
			{bills([ELECTRIC])}
		</Group>
		<Group
			status="upcoming"
			total={`${formatCents(INTERNET.amountCents + CAR.amountCents)} this month`}
		>
			{bills([INTERNET, CAR])}
		</Group>
	</>
);

// ---------------------------------------------------------------------------------------------
// P107–P109: the reconnect email.

/** A round initial for each person the email goes to: A, S and J. */
const PEOPLE = [
	{ initial: "A", look: "bg-accent", email: "alex@example.com" },
	{ initial: "S", look: "bg-ok", email: "sam@example.com" },
	{ initial: "J", look: "bg-muted", email: "jo@example.com" },
];

const emailSettings = (
	<>
		<div class="flex min-h-11 items-center gap-4 border-b border-rule py-2 text-accent">
			<Icon name="plus" class="size-5" />
			Add category
		</div>
		<section class="mt-8 border-t border-rule pt-6">
			<h2 class="font-serif text-3xl font-semibold">Household</h2>
			<div class="mt-3 border-t border-rule">
				<TimeZoneRow zone="America/New_York" id="p107-time-zone" />
				<Switch
					id="p107-emails"
					name="bank_emails"
					label="Bank sign-in emails"
					checked
				/>
				<div class="flex items-center gap-2 pb-1">
					<p class="sr-only">Goes to {PEOPLE.map((p) => p.email).join(", ")}</p>
					<ul aria-hidden="true" class="flex -space-x-2">
						{PEOPLE.map((p) => (
							<li
								class={`flex size-8 items-center justify-center rounded-full border-2 border-paper text-sm font-semibold text-paper ${p.look}`}
							>
								{p.initial}
							</li>
						))}
					</ul>
				</div>
				{/* A plain disclosure, drawn open: each address with its own Remove. */}
				<details open class="group pb-3">
					<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
						<Icon name="chevron" class="size-5 group-open:rotate-90" />
						Who gets them
					</summary>
					<p class="text-muted">
						Everyone who has signed in to Tally in the last 90 days.
					</p>
					<ul class="divide-y divide-rule border-y border-rule">
						{PEOPLE.map((p) => (
							<li class="flex min-h-11 items-center justify-between gap-3">
								<span class="min-w-0 truncate">{p.email}</span>
								<Button kind="text" type="button" class="shrink-0">
									Remove<span class="sr-only"> {p.email}</span>
								</Button>
							</li>
						))}
					</ul>
				</details>
				<Button type="button">Save</Button>
			</div>
		</section>
	</>
);

/** A small envelope, drawn like the icons beside it (the icon set has no mail). */
const Mail = () => (
	<svg
		class="size-5"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<rect width="20" height="16" x="2" y="4" rx="2" />
		<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
	</svg>
);

/** One step on the line: a round icon above its words. */
function Step({
	words,
	tone = "text-muted",
	children,
}: {
	words: string;
	tone?: string;
	children?: Child;
}) {
	return (
		<li class="flex w-16 flex-col items-center gap-2 text-center">
			<span
				class={`flex size-11 items-center justify-center rounded-full border border-rule ${tone}`}
			>
				{children}
			</span>
			<span class="text-sm">{words}</span>
		</li>
	);
}

const emailWhen = (
	<>
		<Title>When it's sent</Title>
		<ol class="mt-6 flex items-start justify-between">
			<Step words="Bank breaks" tone="text-over">
				<Icon name="bank" class="size-5" />
			</Step>
			<li aria-hidden="true" class="mt-5 h-px flex-1 bg-rule" />
			<Step words="That night">
				<Mail />
			</Step>
			<li aria-hidden="true" class="mt-5 h-px flex-1 bg-rule" />
			<Step words="3 days later">
				<Mail />
			</Step>
			<li aria-hidden="true" class="mt-5 h-px flex-1 bg-rule" />
			<Step words="Fixed" tone="text-ok">
				<Icon name="check" class="size-5" />
			</Step>
		</ol>
		<p class="mt-6 text-lg">
			At the nightly run after a bank needs attention, then every 3 days until
			it's fixed.
		</p>
	</>
);

const emailBody = (
	<>
		<div class="border-b border-rule pb-3">
			<p class="text-sm text-muted">
				From Tally · to dana@example.com · Mon, Oct 5
			</p>
			<p class="mt-1 text-xl font-semibold">Chase needs you to sign in again</p>
		</div>
		<div class="mt-4 rounded-sheet border border-rule p-5">
			<p class="flex items-center gap-2 text-xl font-semibold">
				<span class="text-over">
					<Icon name="bank" class="size-6" />
				</span>
				Chase needs signing in
			</p>
			<ul class="mt-3 flex flex-wrap gap-2">
				{["9921", "4410"].map((mask) => (
					<li class="rounded-full bg-band px-3 py-1 text-lg">
						<span class="sr-only">ending in </span>
						<span aria-hidden="true">••</span>
						{mask}
					</li>
				))}
			</ul>
			<p class="mt-3">Last synced Oct 2</p>
			<div class="mt-4">
				<Button href="/accounts">Open Accounts</Button>
			</div>
			<p class="mt-4 text-muted">Turn off in Settings</p>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------

const DECISION = "decision 82";

/** P91–P109 on the proposals page: the owner's picks of Oct 6, each drawn as it will be built. */
export function Phase5PicksProposals() {
	return (
		<>
			<Specimen
				id="p91-past-month"
				title="P91 · How a past month ended"
				tier="visual"
				sentence="A finished month's Home says how it ended with a stamp, and shows how each category did with a bar. The drawing is the owner's pick (#198)."
			>
				<Fixed>
					a month is the YYYY-MM of Plaid's dates, and a category's budget for a
					month is its latest amount set on or before it (§6). A finished month
					has no Band and no Adjust.
				</Fixed>
				<NeedsLine settled={DECISION}>
					A finished month's number is its budgets minus its spending. The
					savings goal and plans don't change it. The stamp says Under or Over,
					and a category that went over pokes above the dashed budget line in
					brick with how far.
				</NeedsLine>
				<Replaces>
					P46 A's sentence (“Every category stayed under its budget.”) and its
					check and “under budget” words.
				</Replaces>
				<Options
					options={[
						{
							name: "September, under budget",
							picked: true,
							note: "$86 with a green Under stamp; Eating Out pokes over the line by $36. The bars are each category against its own budget.",
							screen: <PastTop viewing="Sep" month={SEPTEMBER} />,
						},
						{
							name: "July, over budget",
							note: "The same, for a month that ended over: the number in brick with an Over stamp, and two categories over the line.",
							screen: <PastTop viewing="Jul" month={JULY} />,
						},
						{
							name: "A $0 budget and a far-over category",
							note: "A bar never grows past a quarter above the line, so its “+$650” stays in view; spending against a $0 budget is over by all of it.",
							screen: <PastTop viewing="Jun" month={STRETCH} />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p92-month-dots"
				title="P92 · Which months open"
				tier="visual"
				sentence="‹ and › sit beside the month's name, and a strip of dots under them runs from the first month with transactions to now. The drawing is the owner's pick (#198)."
			>
				<Fixed>
					each arrow is a 44px link named for where it goes, and a finished
					month is its own URL (for example /?month=2026-09), so it all works
					without JavaScript (#198).
				</Fixed>
				<NeedsLine settled={DECISION}>
					› is faded on this month and ‹ on the first month with transactions.
					This month's dot is ringed, and a dot opens that month. Any other
					month in the address, a future one or one before the first, opens this
					month.
				</NeedsLine>
				<Options
					options={[
						{
							name: "On this month",
							picked: true,
							note: "‹ opens September, › is faded and dashed. October's dot is solid and ringed.",
							screen: (
								<>
									<Top
										nav={<MonthNav viewing="Oct" />}
										amount={<Headline>{whole(safeOf(FIVE_OCT))}</Headline>}
										status={statusSentence(summaries(FIVE_OCT.rows))}
									/>
									<Budget>{progressRows(FIVE_OCT.rows.slice(0, 2))}</Budget>
								</>
							),
						},
						{
							name: "On the first month",
							note: "May is the first month with transactions, so ‹ is faded and the strip starts at May.",
							screen: <PastTop viewing="May" month={MAY} />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p93-past-rows"
				title="P93 · A past month's rows"
				tier="visual"
				sentence="A finished month's rows show what each category spent against its budget, and open nothing. The drawing is the owner's pick (#198). Drawn scrolled to the Budget list."
			>
				<Fixed>
					a finished month shows that month's own rows: a category's budget is
					its latest amount set on or before it, and an archived category shows
					for any month it has spending in (§6, §7).
				</Fixed>
				<NeedsLine settled={DECISION}>
					Each row shows “spent / budget” and a bar, with no link, no sheet and
					no “left”. Its Not budgeted categories are listed with what each
					spent.
				</NeedsLine>
				<Options
					options={[
						{
							name: "September's rows",
							picked: true,
							note: "Eating Out is brick, with the alert icon and “$36 over”. Kids had no budget and spent $30.",
							screen: (
								<Budget
									adjust={false}
									after={
										<PastNotBudgeted
											items={[
												{
													name: "Kids",
													icon: CATS.kids.icon,
													color: CATS.kids.color,
													cents: SEPTEMBER.noBudgetCents,
												},
											]}
										/>
									}
								>
									{SEPTEMBER.rows.map((r) => (
										<PastRow r={r} />
									))}
								</Budget>
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p94-negative"
				title="P94 · Safe to spend below $0"
				tier="visual"
				sentence="When bills and spending pass the whole budget, Safe to spend shows the negative number. The drawing is the owner's pick (#199)."
			>
				<Fixed>
					Safe to spend is the whole budget minus counted spending minus bills
					due or overdue and unpaid, so it can be below $0 (§6). At exactly $0
					Home says “$0”. The forecast (P95) sits under the sentence from day 7,
					and is left out of this drawing.
				</Fixed>
				<NeedsLine settled={DECISION}>
					Below $0 the number is negative and brick (“−$40”), with Why? beside
					the label. Cents show only when it's under $1 (“−$0.40”). The words
					that say it is over budget are the sentence under it.
				</NeedsLine>
				<Replaces>
					P47 A's headline (“$120” with “over” in brick under it) and P47's $0
					with a brick over-budget line.
				</Replaces>
				<Options
					options={[
						{
							name: "Below $0",
							picked: true,
							note: "“Safe to spend · Why?” over a brick “−$40”.",
							screen: belowZero(BELOW),
						},
						{
							name: "Just below $0",
							note: "Cents show when it's under $1: “−$0.40”.",
							screen: belowZero(JUST_BELOW),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p95-forecast"
				title="P95 · The forecast"
				tier="visual"
				sentence="Under the sentence, a small chart says where the month ends at this pace. The drawing is the owner's pick of the daily amount's three ways (#199)."
			>
				<Fixed>
					code calculates every number (§2, rule 6), and charts are server-drawn
					SVG with a text alternative (§8.1). The forecast shows from day 7 of
					the month.
				</Fixed>
				<NeedsLine settled={DECISION}>
					The forecast is where the month ends if everyday spending keeps its
					pace, counting the bills still due: the spending so far, plus the
					bills still due, plus the everyday pace times the days left. The pace
					counts only money out that doesn't pay a bill or a plan, per day so
					far: those and refunds already received count in the spending so far
					but are never projected forward. The line is dashed from today to the
					month's end against the dashed budget line, and the end point is green
					when under and brick when over.
				</NeedsLine>
				<Replaces>
					P50 A's daily amount (“About $15.03 a day for the 27 days left.”).
				</Replaces>
				<p class="max-w-prose text-sm text-muted">{workedPace(UNDER_PACE)}</p>
				<Options
					options={[
						{
							name: "On pace to finish under",
							picked: true,
							note: "The end point is green: “$120 under by Oct 31, at this pace”.",
							screen: withForecast(UNDER_MONTH, UNDER_PACE),
						},
						{
							name: "On pace to finish over",
							note: "The end point is brick, with the alert icon: the same chart, over the line.",
							screen: withForecast(OVER_MONTH, OVER_PACE),
						},
					]}
				/>
				<p class="max-w-prose text-sm text-muted">{workedPace(OVER_PACE)}</p>
			</Specimen>

			<Specimen
				id="p96-bank-behind"
				title="P96 · A bank that's behind"
				tier="visual"
				sentence="A bank that stopped updating keeps its alert, with a quieter look: a tag on the number and a soft line with a Fix button. The drawing is the owner's pick (#199)."
			>
				<Fixed>
					a connected bank that needs attention or hasn't synced for 3 days is
					flagged on Home with a link to Accounts, because Safe to spend may be
					too high (§8.5, decision 72). The Band keeps its job.
				</Fixed>
				<NeedsLine settled={DECISION}>
					A dashed “as of Oct 2” tag sits on Safe to spend. Under it a soft
					brick-tinted line with the bank icon says “Chase stopped updating Oct
					2” or “Chase needs signing in”, with a Fix button that opens Accounts.
					It has no playful words, and it comes before the forecast.
				</NeedsLine>
				<Replaces>
					P37 A's look: the plain alert-icon line and its Check Accounts link.
				</Replaces>
				<Options
					options={[
						{
							name: "A bank that stopped updating",
							picked: true,
							note: "The tag on the number, then “Chase stopped updating Oct 12”, then the forecast.",
							screen: bankBehind("Chase stopped updating Oct 12"),
						},
						{
							name: "A bank that needs signing in",
							note: "The same, for a bank whose login has to be redone.",
							screen: bankBehind("Chase needs signing in"),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p97-older-chip"
				title="P97 · Older ones need a category"
				tier="visual"
				sentence="The Band counts older transactions that need a category with a small chip. The drawing is the owner's pick (#199)."
			>
				<Fixed>
					one Band on Home, which leads to Organize and its second line carries
					this month's amount (decision 50). Older ones are counted, not added
					to this month's amount.
				</Fixed>
				<NeedsLine settled={DECISION}>
					The Band reads “12 need a category” with a small “+1 older” chip. Once
					this month's are done it stays for the older ones.
				</NeedsLine>
				<Replaces>
					P52 A's second-line words (“and 6 more from earlier months”).
				</Replaces>
				<Options
					options={[
						{
							name: "This month's and older ones",
							picked: true,
							note: "“12 need a category” and a “+1 older” chip, with “$228 of this month's spending” under them.",
							screen: olderHome(<OlderBand count={12} older={1} />),
						},
						{
							name: "Only older ones left",
							note: "Once this month's are done: P52 A's “6 transactions from earlier months need a category”, with no second line.",
							screen: olderHome(
								<Band href="#p97-older-chip">
									6 transactions from earlier months need a category
								</Band>,
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p98-row-states"
				title="P98 · Refunds, nearly spent and $0 budgets"
				tier="visual"
				sentence="Three states of a budget row: more came back than went out, nearly spent, and a $0 budget. The drawing is the owner's pick (#200). Drawn scrolled to the Budget list."
			>
				<Fixed>
					a row is green until it's over, brick when over with the alert icon
					and its words (§6, DESIGN.md), and a row opens its budget sheet
					(decision 38). Amber is a new colour: its token joins app.css,
					DESIGN.md and the catalog, with its contrast, in the PR that builds
					this (here the ochre token stands in).
				</Fixed>
				<NeedsLine settled={DECISION}>
					A category whose refunds outweigh its spending shows “+$20” in green
					with an empty bar; a Not budgeted row shows the same. At 80% or more
					of the budget the bar turns amber. A $0 budget with nothing spent
					shows no warning.
				</NeedsLine>
				<Replaces>
					P49 A's “$14 left” under the bar (the bar now turns amber instead).
				</Replaces>
				<Options
					options={[
						{
							name: "Nearly spent, refunds and a $0 budget",
							picked: true,
							note: "Groceries at 85% has an amber bar. Clothing's refund outweighs its spending, so “+$20”. Gifts has a $0 budget and no warning. Pets under Not budgeted shows “+$15”.",
							screen: rowStates,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p99-sheet-link"
				title="P99 · The sheet's link to transactions"
				tier="visual"
				sentence="A budget's sheet links to the transactions behind its spent amount, only when there are some. The drawing is the owner's pick (#200)."
			>
				<Fixed>
					a budget row opens its sheet (decision 38), and Transactions already
					filters by category and month.
				</Fixed>
				<NeedsLine settled={DECISION}>
					The link is a button, “12 transactions ›”, shown only when there are
					some. Excluded transactions aren't counted, so the list it opens adds
					up to the row's amount.
				</NeedsLine>
				<Replaces>P53 A's link words (“See the 9 transactions”).</Replaces>
				<Options
					options={[
						{
							name: "With transactions",
							picked: true,
							note: "A pill button under “$553.00 spent so far in October”, above the amount.",
							screen: (
								<BudgetSheet
									cat={CATS.groceries}
									spent={55300}
									count={12}
									value="650.00"
								/>
							),
						},
						{
							name: "With none",
							note: "A category with nothing counted this month has no button.",
							screen: (
								<BudgetSheet
									cat={CATS.gifts}
									spent={0}
									count={0}
									value="0.00"
								/>
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p100-goal-away"
				title="P100 · Taking the savings goal away"
				tier="visual"
				sentence="A savings goal set to $0 is removed, and goes back to waiting under Not budgeted. The drawing is the owner's pick (#201)."
			>
				<Fixed>
					a goal is a monthly amount from a month on, like a budget (§5); before
					one is set the row waits under Not budgeted as “Set a goal” (P54 A,
					decision 74). A budget can be changed but not removed (§7).
				</Fixed>
				<NeedsLine settled={DECISION}>
					Setting the goal to $0 from a month on removes it. Adjust's − and +
					don't change it; only its sheet does.
				</NeedsLine>
				<Options
					options={[
						{
							name: "The sheet at $0, and Home after",
							picked: true,
							note: "Save at $0 and the Savings line leaves the Budget list. It waits under Not budgeted as “Set a goal”.",
							screen: goalSheetAtZero,
						},
						{
							name: "Home once it's gone",
							note: "The same Home without the sheet over it.",
							screen: goalGone,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p101-plan-link"
				title="P101 · Linking a plan's payment"
				tier="visual"
				sentence="A plan's own page lists the payments it could be paid by, closest amount first. The drawing is the owner's pick (#202)."
			>
				<Fixed>
					a payment pays one bill or one plan, never both, and the link step
					shows a field error if it already pays one (§5, §6.1).
				</Fixed>
				<NeedsLine settled={DECISION}>
					The picker lists money out from the plan's month and the next, not
					already paying a bill or a plan, closest amount first. An excluded
					payment can be linked, and counts once linked, the same rule as bills
					(§8.5).
				</NeedsLine>
				<Options
					options={[
						{
							name: "The plan's page, October",
							picked: true,
							note: "DMV ($180) is closest, then Costco ($212), then Shell ($45).",
							screen: planLink,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p102-plan-sheet"
				title="P102 · Changing or deleting a plan"
				tier="visual"
				sentence="A plan's own sheet changes what it's for, its amount and its month, deletes it, and unlinks a payment. The drawing is the owner's pick (#202)."
			>
				<Fixed>
					Plan an expense takes the plain big amount field (decision 79), and a
					sheet's Cancel and Save are always visible (P72 A).
				</Fixed>
				<NeedsLine settled={DECISION}>
					A plan has no category: a linked payment keeps its own, and
					planned_expenses.category_id leaves §5. Deleting a plan deletes it;
					unlinking a payment sets the plan aside again.
				</NeedsLine>
				<Replaces>
					P55 A's category column (§5): the sheet never had a Category field.
				</Replaces>
				<Options
					options={[
						{
							name: "A plan not yet paid",
							picked: true,
							note: "What it's for, Amount, Month, then Save, Delete and Cancel.",
							screen: <PlanSheet />,
						},
						{
							name: "A plan that's been paid",
							note: "The same, with the payment it was paid by and an Unlink button.",
							screen: <PlanSheet paid />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p103-plan-paid"
				title="P103 · A plan once it's paid"
				tier="visual"
				sentence="Once a payment is linked, a plan shows with the paid bills. The drawing is the owner's pick (#202)."
			>
				<Fixed>
					a bill that's paid shows under Paid this month, with a check in its
					heading (§8.2).
				</Fixed>
				<NeedsLine settled={DECISION}>
					Once paid, a plan shows in Paid this month with the paid bills, not
					under Planned.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Paid this month, with the bills",
							picked: true,
							note: "Rent and Car registration under one check. Holiday gifts is still planned, for December.",
							screen: planPaid,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p104-plan-totals"
				title="P104 · Totals with plans"
				tier="visual"
				sentence="The Planned group has its own total, and plans aren't in the monthly bills total. The drawing is the owner's pick (#202)."
			>
				<Fixed>
					Bills shows a quiet total under its sentence and a total under each
					group (P60 A and B, decision 74).
				</Fixed>
				<NeedsLine settled={DECISION}>
					The Planned group's heading ends with its own total. Plans aren't in
					the monthly bills total or in “still to pay”: here $1,530 is the four
					bills, and Car registration's $180 sits apart.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Planned has its own total",
							picked: true,
							note: "“$180.00” at the end of the Planned heading; the line under the sentence counts bills only.",
							screen: planTotals,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p105-plan-unpaid"
				title="P105 · A plan unpaid when its month ends"
				tier="visual"
				sentence="On the 1st, a Band on Bills asks about one unpaid plan at a time. The drawing is the owner's pick (#202)."
			>
				<Fixed>
					a plan unpaid when its month ends stays set aside until it's answered,
					and the question comes before the repeat-charge Band, one Band at a
					time (decision 74).
				</Fixed>
				<NeedsLine settled={DECISION}>
					The Band asks about one plan: “Car registration wasn't paid”, with
					Move to Nov (its month becomes this one) and Drop (it's deleted), and
					a dot for each plan waiting.
				</NeedsLine>
				<Replaces>
					P55 A's Band words (“Move it to November?”, Move it, Drop it).
				</Replaces>
				<Options
					options={[
						{
							name: "One plan at a time",
							picked: true,
							note: "Two plans are waiting, so two dots; the first is dark.",
							screen: planUnpaid,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p106-part-paid-total"
				title="P106 · Part paid, in a group's total"
				tier="visual"
				sentence="A group's total counts what's left of a part-paid bill, and the monthly total counts it in full. The drawing is the owner's pick (#207)."
			>
				<Fixed>
					a part-paid bill stays in the group its due date puts it in and says
					“Part paid: $600 of $1,200” (P78 A, decision 80), and counts in full
					in the monthly total (decision 79).
				</Fixed>
				<NeedsLine settled={DECISION}>
					Each status group's heading total counts what's left of a part-paid
					bill: Overdue says $600.00, not $1,200.00. The monthly total still
					counts the rent in full.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Rent, half paid",
							picked: true,
							note: "Overdue ends with “$600.00”; the line under the sentence counts the rent as $1,200 a month and $600 still to pay.",
							screen: partPaidTotal,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p107-email-settings"
				title="P107 · The reconnect email's switch"
				tier="visual"
				sentence="One household switch in Settings turns the bank sign-in emails off, and shows who they go to as initials, with each address and a Remove under a plain disclosure. The drawing is the owner's pick (#203)."
			>
				<Fixed>
					the switch is the Switch component built for P41 B, with a Save
					(decisions 73 and 79), and one household shares one setting (§3,
					decision 5).
				</Fixed>
				<NeedsLine settled={DECISION}>
					“Bank sign-in emails” is on to start. It goes to everyone who has
					signed in to Tally in the last 90 days: Tally notes each verified
					sign-in address the first time it sees it and updates its last_seen_at
					at each sign-in (household_members, §5). There's nothing to confirm
					first (decision 86). Anyone in the family can remove an address, like
					the people list (decision 81), so a person who has left stops getting
					the email; a removed address comes back only if that person signs in
					again, which needs Cloudflare Access.
				</NeedsLine>
				<Replaces>
					P56's “Both · Settings” picture (a Reminders section with “Email me”
					and one address).
				</Replaces>
				<Options
					options={[
						{
							name: "In Settings",
							picked: true,
							family: true,
							note: "Under Household, after the time zone: the switch, on, a round initial for each person it goes to, and a plain disclosure (drawn open) listing each address with Remove.",
							screen: emailSettings,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p108-email-when"
				title="P108 · When the reconnect email is sent"
				tier="visual"
				sentence="The first email goes at the nightly run after a bank needs attention, then one every 3 days until it's fixed. The drawing is the owner's pick (#203)."
			>
				<Fixed>
					the nightly run already syncs each bank and skips one that needs
					reconnecting (§4); the demo has no banks and never sends.
				</Fixed>
				<NeedsLine settled={DECISION}>
					When the last one went is a nullable column on plaid_items
					(reconnect_emailed_at, §5). No email goes for a fixed or a
					disconnected bank.
				</NeedsLine>
				<Options
					options={[
						{
							name: "The schedule",
							picked: true,
							family: true,
							note: "The bank breaks, an email that night, another 3 days later, and none once it's fixed.",
							screen: emailWhen,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p109-email"
				title="P109 · The reconnect email"
				tier="visual"
				sentence="The email names the bank and its accounts, says when it last synced, and has one button. The drawing is the owner's pick (#203)."
			>
				<Fixed>
					the email is a Hono JSX template with no new dependency (decision 79),
					sent with Resend through plain fetch, with Cloudflare's own email as
					the fallback (decision 86, which replaces decision 79's order), and it
					never carries amounts, balances or transaction details.
				</Fixed>
				<NeedsLine settled={DECISION}>
					The bank, its account endings as chips, the last synced date, one
					“Open Accounts” button, and “Turn off in Settings” in muted words with
					no link.
				</NeedsLine>
				<Replaces>P56 B's body and its “Turn these emails off” link.</Replaces>
				<Options
					options={[
						{
							name: "The email",
							picked: true,
							family: true,
							note: "As it reads on a phone, with Chase's two accounts as chips.",
							screen: emailBody,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
