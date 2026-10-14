// P125 (#95): a new family's first week, four ways, drawn for the owner's pick (proposal only: nothing in the
// app changes). Every picture is the family's app, with no demo banner, on one sample household: Chase linked
// Tue Oct 13 at 7 p.m., today Wed Oct 14, Eastern time. Where the app's own components draw the same at a
// phone's size they are used as they are (Band, TransactionRow, ProgressRow, CategoryIcon, FoldedRow,
// SheetFooter, MoneyInput, Button, Icon, WhyLink). The pencil states (a dashed amount, a dashed rule, a
// muted row) and the notebook's strokes drawn one at a time are prototypes in tokens, and each says in words
// what it is for a screen reader. The replays are proposals-only keyframes in app.css ("Proposals only (P125)").

import type { Child } from "hono/jsx";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { FoldedRow } from "../views/folded-row";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { SheetFooter } from "../views/sheet-footer";
import { TransactionRow } from "../views/transaction-row";
import { WhyLink } from "../views/why-link";
import { Fixed, Sheet } from "./proposal-parts";
import { EATING_OUT, TITLE, tx } from "./proposals-phase5-transactions";
import {
	Amount,
	Choice,
	Choices,
	HomeTop,
	money,
	Phone,
	Shot,
} from "./proposals-polish-4";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// The sample household, the same in every option. Amounts in cents; Aug and Sep in whole dollars.

type Budget = {
	name: string;
	icon: string;
	color: string;
	budgetCents: number;
	spentCents: number;
	/** August and September spending, in whole dollars, for the first six budgets. */
	aug?: number;
	sep?: number;
};

/** The twelve budgets Tally sets from August and September (14 categories; two spent nothing). */
const BUDGETS: Budget[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		budgetCents: 65000,
		spentCents: 24000,
		aug: 610,
		sep: 674,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		budgetCents: 32000,
		spentCents: 14600,
		aug: 296,
		sep: 340,
	},
	{
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		budgetCents: 18000,
		spentCents: 9600,
		aug: 176,
		sep: 172,
	},
	{
		name: "Car & Transport",
		icon: "car",
		color: "cat-slate",
		budgetCents: 18000,
		spentCents: 6000,
		aug: 184,
		sep: 169,
	},
	{
		name: "Rent",
		icon: "rent",
		color: "cat-brown",
		budgetCents: 160000,
		spentCents: 160000,
		aug: 1600,
		sep: 1600,
	},
	{
		name: "Utilities",
		icon: "utilities",
		color: "cat-ochre",
		budgetCents: 29000,
		spentCents: 0,
		aug: 288,
		sep: 276,
	},
	{
		name: "Subscriptions",
		icon: "subscriptions",
		color: "cat-blue",
		budgetCents: 4000,
		spentCents: 0,
	},
	{
		name: "Shopping",
		icon: "shopping",
		color: "cat-plum",
		budgetCents: 27000,
		spentCents: 21000,
	},
	{
		name: "Personal Care",
		icon: "personal-care",
		color: "cat-ochre",
		budgetCents: 7000,
		spentCents: 2200,
	},
	{
		name: "Health",
		icon: "health",
		color: "cat-brown",
		budgetCents: 5000,
		spentCents: 0,
	},
	{
		name: "Entertainment",
		icon: "entertainment",
		color: "cat-slate",
		budgetCents: 6000,
		spentCents: 0,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		budgetCents: 34000,
		spentCents: 11200,
	},
];

/** $1,411 safe to spend: the $4,050 of budgets, less $2,486 spent so far in October, less $153 of bills due this week. */
const BUDGETS_TOTAL = 405000;
const SPENT = 248600;
const BILLS_DUE = 15300;
const SAFE = BUDGETS_TOTAL - SPENT - BILLS_DUE;

const ACME = {
	...tx(
		901,
		"2026-10-09",
		"ACME CORP PAYROLL PPD ID 4432",
		-245000,
		undefined,
		{
			income: true,
		},
	),
	displayName: "Acme Corp",
};
const SAVINGS = {
	...tx(902, "2026-10-10", "ONLINE TRANSFER TO SAV ...5678", 50000, undefined, {
		excluded: true,
	}),
	displayName: "Transfer to Savings",
};
const BLUE_BOTTLE = {
	...tx(903, "2026-10-12", "SQ *BLUE BOTTLE COF 0217", 675, EATING_OUT),
	displayName: "Blue Bottle Coffee",
};

/** The evening's three bank lines, each with Tally's row under the bank's own text. */
const BANK_LINES = [
	{ bank: "ACME CORP PAYROLL PPD ID 4432", row: ACME },
	{ bank: "ONLINE TRANSFER TO SAV ...5678", row: SAVINGS },
	{ bank: "SQ *BLUE BOTTLE COF 0217", row: BLUE_BOTTLE },
];

const FAMILY_BAND = (
	<Band href="/transactions/organize" detail="$186 of this month's spending">
		86 need a category
	</Band>
);

// ---------------------------------------------------------------------------------------------
// Pieces that more than one option draws.

/** A figure Tally hasn't inked yet: a muted dollar sign and a dashed rule, read aloud as `words`. */
function blank(words: string) {
	return (
		<p class="font-serif text-6xl font-semibold tracking-tight whitespace-nowrap">
			<span class="text-muted">$</span>{" "}
			<span class="inline-block h-[0.8em] w-36 border-b-2 border-dashed border-muted" />
			<span class="sr-only">{words}</span>
		</p>
	);
}

/** A bank's line with a pencil strike drawn across it, and Tally's row under it. The replay names the classes that draw the strike and fade the row in. */
function BankLine({
	bank,
	row,
	strike = "",
	rows = "",
}: {
	bank: string;
	row: ReturnType<typeof tx>;
	strike?: string;
	rows?: string;
}) {
	return (
		<div>
			<p class="text-sm text-muted">
				<span class="sr-only">The bank sent </span>
				<span class="relative inline-block">
					{bank}
					<span
						aria-hidden="true"
						class={`absolute inset-x-0 top-1/2 h-px origin-left bg-muted ${strike}`}
					/>
				</span>
			</p>
			<ul class={`mt-1 border-y border-rule ${rows}`}>
				<TransactionRow row={row} />
			</ul>
		</div>
	);
}

/** One line of the entry: its name, what Tally wrote, and a muted second line. A dashed blank stands for what isn't written yet. */
function EntryLine({
	label,
	value,
	sub,
	blankValue = false,
	ruled = false,
}: {
	label: string;
	value?: Child;
	sub?: Child;
	blankValue?: boolean;
	ruled?: boolean;
}) {
	return (
		<li class={`py-3 ${ruled ? "border-t border-ink" : ""}`}>
			<div class="flex items-baseline justify-between gap-3">
				<span class="text-lg">{label}</span>
				{blankValue && (
					<span class="inline-block h-px w-24 border-b-2 border-dashed border-muted">
						<span class="sr-only">Not filled in yet</span>
					</span>
				)}
			</div>
			{value && <p class="text-base">{value}</p>}
			{sub && <p class="text-sm text-muted">{sub}</p>}
		</li>
	);
}

/** A budget row as Home draws it: the real ProgressRow, in a list. */
function BudgetRows({ rows }: { rows: Budget[] }) {
	return (
		<ul class="divide-y divide-rule">
			{rows.map((r) => (
				<ProgressRow {...r} />
			))}
		</ul>
	);
}

/** A budget the pencil has set but the ink hasn't: the amount in muted words, a dashed track, a muted fill, no status colour. */
function PencilRow({ budget }: { budget: Budget }) {
	const { fillPct } = barGeometry(budget.spentCents, budget.budgetCents);
	return (
		<li class="flex items-start gap-4 py-3">
			<CategoryIcon icon={budget.icon} color={budget.color} />
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline justify-between gap-3">
					<span class="text-lg text-muted">
						<span class="sr-only">Pencilled in, not kept yet: </span>
						{budget.name}
					</span>
					<span class="tabular-nums text-muted">
						{money(budget.spentCents)} of{" "}
						<span class="border-b border-dashed border-muted">
							{money(budget.budgetCents)}
						</span>
					</span>
				</div>
				<p class="text-sm text-muted">
					Aug {money((budget.aug ?? 0) * 100)} · Sep{" "}
					{money((budget.sep ?? 0) * 100)}
				</p>
				<svg class="mt-2 h-1 w-full" aria-hidden="true">
					<rect
						width="100%"
						height="100%"
						rx="2"
						fill="none"
						stroke-dasharray="3 2"
						class="stroke-muted"
					/>
					<rect width={`${fillPct}%`} height="100%" rx="2" class="fill-muted" />
				</svg>
			</div>
		</li>
	);
}

/** A ticked round: the 44px ink tick on a budget Tally has kept on. */
function Tick() {
	return (
		<span
			aria-hidden="true"
			class="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-paper"
		>
			<Icon name="check" class="size-5" />
		</span>
	);
}

/**
 * The notebook of LedgerIllustration, with its tally strokes drawn one at a time: `strokes` of the five,
 * in pencil (muted) until `ink`. `replay` draws the fifth across the four and turns all five to ink, with
 * proposal-only classes in app.css. The strokes are the illustration's own, in the same places.
 */
const STROKE_LINES = [
	[46, 38, 46, 60],
	[53, 38, 53, 60],
	[60, 38, 60, 60],
	[67, 38, 67, 60],
	[41, 56, 72, 42],
];

function Notebook({
	strokes,
	ink = false,
	replay = false,
}: {
	strokes: number;
	ink?: boolean;
	replay?: boolean;
}) {
	return (
		<svg
			class="size-32 shrink-0"
			viewBox="0 0 120 120"
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<g class="stroke-ink" transform="rotate(-6 56 58)">
				<rect x="26" y="16" width="58" height="80" rx="4" />
				{[26, 36, 46, 56, 66, 76, 86].map((y) => (
					<circle cx="26" cy={y} r="3.5" />
				))}
				{STROKE_LINES.slice(0, replay ? 5 : strokes).map(
					([x1, y1, x2, y2], i) => (
						<line
							x1={x1}
							y1={y1}
							x2={x2}
							y2={y2}
							class={
								replay
									? `stroke-ink proposal-first-stroke${i === 4 ? " proposal-first-cross" : ""}`
									: ink
										? "stroke-ink"
										: "stroke-muted"
							}
						/>
					),
				)}
			</g>
			{/* The pencil the illustration draws beside the notebook, as LedgerIllustration does. */}
			<g class="stroke-accent fill-paper">
				<path d="M96 26 L106 30 L88 96 L78 92 Z" />
				<path d="M78 92 L88 96 L80 106 Z" />
				<line x1="94" y1="33" x2="104" y2="37" />
				<line x1="104" y1="16" x2="110" y2="8" />
				<line x1="96" y1="12" x2="98" y2="4" />
			</g>
		</svg>
	);
}

/** A screen's top with the notebook beside its headline, for option C's setup (in place of Home's own drawing). */
function StrokesTop({
	label,
	headline,
	strokes,
	ink = false,
	status,
	band,
	children,
}: {
	label: Child;
	headline: Child;
	strokes: number;
	ink?: boolean;
	status: Child;
	band?: Child;
	children?: Child;
}) {
	return (
		<>
			<div class="mt-2 flex items-center justify-between gap-4">
				<div class="min-w-0">
					<p class="text-lg text-muted">{label}</p>
					{headline}
				</div>
				<div class="flex flex-col items-center">
					<Notebook strokes={strokes} ink={ink} />
					{!ink && (
						<p class="text-sm text-muted">Your first tally: {strokes} of 5</p>
					)}
				</div>
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			{band && <div class="mt-4">{band}</div>}
			{children}
		</>
	);
}

/** Home's top with a pencil amount, as the pencil states draw it: the label, the figure and its words. */
function PencilTop({
	label,
	amount,
	status,
	children,
}: {
	label: Child;
	amount: Child;
	status: Child;
	children?: Child;
}) {
	return (
		<>
			<div class="mt-2">
				<p class="text-lg text-muted">
					{label} · <WhyLink section="budget" topic="safe to spend" />
				</p>
				{amount}
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			{children}
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// Option A · The Opening Entry (recommended): the first page of the books, written from the last 90 days.

const aBefore = (
	<>
		<div class="flex items-center justify-between gap-4">
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Let Tally read first.
			</h1>
			<div class="shrink-0 [&>svg]:size-24">
				<LedgerIllustration />
			</div>
		</div>
		<p class="mt-4 text-lg">
			Link your bank and Tally reads your last 90 days: what you're paid, what
			comes back every month and where the rest goes. Then it writes you a first
			budget. You won't type a number.
		</p>
		<div class="mt-5">
			<Button type="button" class="w-full">
				Link a bank
			</Button>
		</div>
		<p class="mt-2 text-sm text-muted">
			Tally can only read your bank. It can't move money.
		</p>
		<h2 class="mt-6 text-sm font-medium text-muted">What Tally fills in</h2>
		<ul class="mt-2 divide-y divide-rule border-y border-rule">
			{["Paid", "Comes back every month", "Left out", "Where it goes"].map(
				(label) => (
					<li class="flex min-h-11 items-center justify-between gap-3 py-2">
						<span class="text-lg">{label}</span>
						<span class="inline-block h-px w-24 border-b-2 border-dashed border-muted">
							<span class="sr-only">Not filled in yet</span>
						</span>
					</li>
				),
			)}
			<li class="flex min-h-11 items-center justify-between gap-3 border-t border-ink py-2">
				<span class="text-lg">A first budget</span>
				<span class="inline-block h-px w-24 border-b-2 border-dashed border-muted">
					<span class="sr-only">Not filled in yet</span>
				</span>
			</li>
		</ul>
	</>
);

const aEvening = (
	<>
		<h1 class="font-serif text-4xl font-semibold tracking-tight">
			Your last 90 days
		</h1>
		<p class="mt-3 font-serif text-lg italic">
			Tally sorts the rest tonight. Your first budget will be ready by about 6
			a.m.
		</p>
		<p class="mt-1 text-muted">Nothing for you to do until then.</p>
		<h2 class="mt-6 font-serif text-2xl font-semibold">Three of your lines</h2>
		<div class="mt-3 flex flex-col gap-4">
			{BANK_LINES.map(({ bank, row }) => (
				<BankLine bank={bank} row={row} />
			))}
		</div>
	</>
);

const aEntry = (
	<>
		<h2 class="font-serif text-2xl font-semibold">Tally's entry</h2>
		<ul class="mt-2 divide-y divide-rule border-y border-rule">
			<EntryLine
				label="Paid"
				value="$2,450 every other Friday, from Acme Corp"
				sub="7 paychecks since Jul 17"
			/>
			<EntryLine
				label="Comes back every month"
				value="8 charges, about $2,062"
				sub="Harbor Property, Geico, Spectrum and 5 more"
			/>
			<EntryLine label="Left out" value="6 moves between your own accounts" />
			<EntryLine label="Named" value="31 stores, from your bank's text" />
			<EntryLine
				label="Where it goes"
				blankValue
				sub="50 of 412 sorted. The rest tonight."
			/>
			<EntryLine
				label="A first budget"
				blankValue
				sub="Ready by about 6 a.m."
				ruled
			/>
		</ul>
	</>
);

const aMorning = (
	<HomeTop
		label="Safe to spend"
		why={false}
		amount={blank("Not worked out yet")}
		status={
			<>
				In a typical month, $4,900 came in and about $4,310 went out. ·{" "}
				<WhyLink section="budget" topic="what came in and went out" />
			</>
		}
		howLink={false}
	>
		<p class="mt-3 text-sm text-muted">
			From Chase, Jul 16 to Oct 13. Tally sorted 362 overnight.
		</p>
	</HomeTop>
);

const aFirstBudget = (
	<>
		<div class="flex items-center justify-between gap-3">
			<h2 class="font-serif text-3xl font-semibold">A first budget</h2>
			<Button kind="text" type="button">
				Adjust
			</Button>
		</div>
		<p class="mt-2 text-sm text-muted">
			Each line is what that category spent in a typical month, August and
			September, raised to the next $10. ·{" "}
			<WhyLink section="budget" topic="a first budget" />
		</p>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{BUDGETS.slice(0, 6).map((b) => (
				<li class="flex min-h-14 items-center gap-3 py-2">
					<Tick />
					<CategoryIcon icon={b.icon} color={b.color} />
					<div class="min-w-0 flex-1">
						<p class="text-lg">{b.name}</p>
						<p class="text-sm text-muted">
							Aug {money((b.aug ?? 0) * 100)} · Sep {money((b.sep ?? 0) * 100)}
						</p>
					</div>
					<span class="tabular-nums">{money(b.budgetCents)}</span>
				</li>
			))}
			<li class="flex min-h-14 items-center gap-3 py-2">
				<span class="flex size-11 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-muted">
					<Icon name="circle-dashed" class="size-5 text-muted" />
					<span class="sr-only">Not ticked yet</span>
				</span>
				<div class="min-w-0 flex-1">
					<p class="text-lg">Needs a category</p>
					<p class="text-sm text-muted">
						86 transactions Tally wasn't sure of · about $320 a month
					</p>
				</div>
			</li>
		</ul>
	</>
);

/** The rest of the first budget, as a picture of its own: the bills, the totals and the one button. */
const aFirstBudgetTail = (
	<>
		<div class="mt-3">
			<FoldedRow label="Bills · 8" value="about $2,062 a month" />
		</div>
		<div class="mt-4 flex items-baseline justify-between gap-3 border-t border-ink pt-3">
			<p class="text-lg">Budgets</p>
			<p class="tabular-nums">$4,050 a month</p>
		</div>
		<div class="mt-3 flex items-baseline justify-between gap-3 border-t border-ink pt-3">
			<p class="text-2xl font-semibold">Safe to spend today</p>
			<p class="text-2xl font-semibold tabular-nums">{money(SAFE)}</p>
		</div>
		<div class="mt-2 border-b-[3px] border-double border-ink" />
		<div class="mt-4">
			<Button type="button" class="w-full">
				Start with this budget
			</Button>
		</div>
		<p class="mt-3 text-sm text-muted">
			Untick any you'd rather leave out. Once set, a budget can be changed on
			Home but not removed.
		</p>
		<p class="mt-2">
			<a
				href="#p125-first-week"
				class="inline-flex min-h-11 items-center text-accent"
			>
				Set my own instead
			</a>
		</p>
	</>
);

const aHome = (
	<>
		<HomeTop
			label="Safe to spend"
			amount={<Amount>{money(SAFE)}</Amount>}
			status="Your first budget, from your own August and September."
			band={FAMILY_BAND}
		>
			<h2 class="mt-8 font-serif text-3xl font-semibold">Budget</h2>
			<div class="mt-2">
				<BudgetRows rows={BUDGETS.slice(0, 4)} />
			</div>
		</HomeTop>
	</>
);

const aHomeRest = <BudgetRows rows={BUDGETS.slice(4)} />;

/** The three strikes, in turn: each starts 200 ms after the one above it (app.css, "Proposals only (P125)"). */
const STRIKES = [
	"proposal-first-strike",
	"proposal-first-strike-later",
	"proposal-first-strike-last",
];

/** Option A's replay: the three bank lines are struck in turn, and Tally's rows fade in under them. */
const aReplay = (
	<>
		<h2 class="font-serif text-2xl font-semibold">Three of your lines</h2>
		<div class="mt-3 flex flex-col gap-4">
			{BANK_LINES.map(({ bank, row }, i) => (
				<BankLine
					bank={bank}
					row={row}
					strike={STRIKES[i]}
					rows="proposal-first-rows"
				/>
			))}
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// Option B · Pencil, then ink: the whole Home pencilled in from the history, and one tap inks it.

const bBefore = (
	<PencilTop
		label="Safe to spend"
		amount={blank("Not pencilled in yet")}
		status="Link your bank, and Tally pencils in your whole budget from your last 90 days."
	>
		<div class="mt-6">
			<Band
				href="/accounts"
				detail="Tally can only read it. It can't move money."
			>
				Link a bank
			</Band>
		</div>
	</PencilTop>
);

const bEvening = (
	<PencilTop
		label="Safe to spend"
		amount={blank("Not pencilled in yet")}
		status="Reading Chase. Tally pencils in your budget once it has sorted your 90 days: by about 6 a.m."
	>
		<p class="mt-3 text-muted">Nothing for you to do until then.</p>
	</PencilTop>
);

const PENCIL_NOTES = [
	"Paid $2,450 every other Friday by Acme Corp.",
	"8 charges come back every month, about $2,062.",
	"6 moves between your own accounts are left out; they aren't spending.",
	"38 stores have cleaner names, dashed until you keep them.",
];

/** The pencilled amount, as the replay and the morning picture both draw it: muted, dashed underneath. */
const pencilAmount = (
	<p class="font-serif text-6xl font-semibold tracking-tight whitespace-nowrap text-muted underline decoration-dashed underline-offset-8">
		{money(SAFE)}
		<span class="sr-only">, pencilled in, not kept yet</span>
	</p>
);

const bMorning = (
	<>
		<h1 class="font-serif text-2xl font-semibold tracking-tight">October</h1>
		<div class="mt-2">
			<p class="text-lg text-muted">
				Safe to spend · in pencil ·{" "}
				<WhyLink section="budget" topic="safe to spend" />
			</p>
			{pencilAmount}
		</div>
		<p class="mt-3 font-serif text-lg italic">
			Pencilled in from your August and September. Ink it in when it looks
			right.
		</p>
		<div class="mt-4 space-y-2 border-l border-dashed border-muted pl-3 text-sm text-muted">
			{PENCIL_NOTES.map((line) => (
				<p>{line}</p>
			))}
		</div>
		<div class="mt-4">
			<Band href="/" detail="12 budgets and 8 bills, all from your history">
				Ink in this budget
			</Band>
		</div>
		<ul class="mt-4 divide-y divide-rule">
			{BUDGETS.slice(0, 2).map((b) => (
				<PencilRow budget={b} />
			))}
		</ul>
	</>
);

/** The pencilled Home behind the ink-in sheet: its figure and its first words, from the top. */
const bBehind = (
	<>
		<h1 class="font-serif text-2xl font-semibold tracking-tight">October</h1>
		<div class="mt-2">
			<p class="text-lg text-muted">
				Safe to spend · in pencil ·{" "}
				<WhyLink section="budget" topic="safe to spend" />
			</p>
			{pencilAmount}
		</div>
		<p class="mt-3 font-serif text-lg italic">
			Pencilled in from your August and September.
		</p>
	</>
);

const bInkSheet = (
	<>
		<h2 class="font-serif text-2xl font-semibold">Ink in this budget</h2>
		<div>
			<p class="font-serif text-4xl font-semibold tracking-tight">$4,050</p>
			<p class="text-muted">a month</p>
		</div>
		<p class="text-sm text-muted">
			What each category spent in a typical month, August and September, raised
			to the next $10. · <WhyLink section="budget" topic="a first budget" />
		</p>
		<ul class="divide-y divide-rule border-y border-rule">
			<li>
				<FoldedRow label="Budgets · 12 categories" />
			</li>
			<li>
				<FoldedRow label="Bills · 8, about $2,062 a month" />
			</li>
		</ul>
		<p class="text-sm text-muted">
			Safe to spend becomes {money(SAFE)}. Untick any you'd rather leave out:
			once set, a budget can be changed but not removed.
		</p>
		<SheetFooter>
			<Button kind="secondary" type="button">
				Cancel
			</Button>
			<Button type="button">Ink it in</Button>
		</SheetFooter>
	</>
);

const bInked = (
	<HomeTop
		label="Safe to spend"
		amount={<Amount>{money(SAFE)}</Amount>}
		status="Inked in. Tap any line to change it."
		band={FAMILY_BAND}
	>
		<div class="mt-6">
			<BudgetRows rows={BUDGETS.slice(0, 3)} />
		</div>
	</HomeTop>
);

/** Option B's replay: the pencilled amount inks in, its dashed rule turns solid, and the two bars fill. */
const bReplay = (
	<>
		<p class="text-lg">Safe to spend</p>
		<p class="relative font-serif text-6xl font-semibold tracking-tight whitespace-nowrap text-ink proposal-first-ink-text">
			{money(SAFE)}
			<span
				aria-hidden="true"
				class="absolute inset-x-0 -bottom-1 border-b-2 border-dashed border-muted opacity-0 proposal-first-pencil-off"
			/>
			<span
				aria-hidden="true"
				class="absolute inset-x-0 -bottom-1 border-b-2 border-ink proposal-first-ink-on"
			/>
		</p>
		<ul class="mt-6 divide-y divide-rule">
			{BUDGETS.slice(0, 2).map((b) => {
				const { fillPct } = barGeometry(b.spentCents, b.budgetCents);
				return (
					<li class="py-3">
						<div class="flex items-baseline justify-between gap-3">
							<span class="text-lg">{b.name}</span>
							<span class="tabular-nums text-muted">
								{money(b.spentCents)} of {money(b.budgetCents)}
							</span>
						</div>
						<svg class="mt-2 h-1 w-full" aria-hidden="true">
							<rect
								width="100%"
								height="100%"
								rx="2"
								fill="none"
								stroke-dasharray="3 2"
								class="stroke-muted"
							/>
							<rect
								width={`${fillPct}%`}
								height="100%"
								rx="2"
								class="fill-muted"
							/>
							<rect
								width={`${fillPct}%`}
								height="100%"
								rx="2"
								class="fill-ink proposal-first-bar"
							/>
						</svg>
					</li>
				);
			})}
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// Option C · The notebook fills in: each real step pencils a stroke, and the fifth crosses the four.

const cWelcome = (
	<StrokesTop
		label="Welcome to Tally"
		headline={<h1 class={TITLE}>One thing today.</h1>}
		strokes={0}
		status="Tally does the reading; you make the calls."
		band={
			<Band
				href="/accounts"
				detail="Tally can only read it. It can't move money."
			>
				Link your bank
			</Band>
		}
	/>
);

const cSpent = (
	<StrokesTop
		label={
			<>
				Spent so far · <WhyLink section="budget" topic="spent so far" />
			</>
		}
		headline={<Amount>{money(SPENT)}</Amount>}
		strokes={1}
		status="That's all for today. Tally sorts what it's sure of by tomorrow, so these will be fewer."
		band={FAMILY_BAND}
	/>
);

/** The budget walk: one category at a time, over Home with two strokes drawn. */
const cWalkBehind = (
	<StrokesTop
		label={
			<>
				Spent so far · <WhyLink section="budget" topic="spent so far" />
			</>
		}
		headline={<Amount>{money(SPENT)}</Amount>}
		strokes={2}
		status="Two. Budgets are next."
	/>
);

const cWalkSheet = (
	<>
		<p class="text-sm text-muted">Budget 1 of 12</p>
		<h2 class="font-serif text-2xl font-semibold">Rent</h2>
		<MoneyInput
			id="walk-rent"
			name="rent"
			label="Rent, a month"
			value="1600.00"
			lastMonthCents={160000}
			averageCents={160000}
		/>
		<p>
			<a
				href="#p125-first-week"
				class="inline-flex min-h-11 items-center text-accent"
			>
				Skip this one
			</a>
		</p>
		<SheetFooter>
			<Button kind="secondary" type="button">
				Cancel
			</Button>
			<Button type="button">Save and next</Button>
		</SheetFooter>
	</>
);

const cFour = (
	<StrokesTop
		label={
			<>
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</>
		}
		headline={<Amount>{money(SAFE)}</Amount>}
		strokes={4}
		status="Four. The fifth draws itself tomorrow, when you look in."
	/>
);

const cFive = (
	<StrokesTop
		label={
			<>
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</>
		}
		headline={<Amount>{money(SAFE)}</Amount>}
		strokes={5}
		ink
		status="Five. You're set up, and from here Tally just keeps count."
	/>
);

/** Option C's replay: the fifth stroke draws across the four, and all five turn from pencil to ink. */
const cReplay = (
	<>
		<p class="text-lg text-muted">Your first tally</p>
		<div class="mt-2 flex justify-center">
			<Notebook strokes={5} replay />
		</div>
		<p class="mt-3 text-center font-serif text-xl italic">
			Five. You're set up.
		</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// Option D · Kitchen-table sitting: a few plain questions after last month is sorted; each answer is a line.

const dMorning = (
	<HomeTop
		amount={blank("Not worked out yet")}
		status="Tally sorted 362 overnight and has 14 questions for you. Safe to spend is written in at the end."
		howLink={false}
		band={
			<Band href="/questions" detail="About three minutes. Most are one tap.">
				14 questions from Tally
			</Band>
		}
	/>
);

const DLEDGER_LINES = [
	"Chase · 412 lines · Jul 16 to Oct 13",
	"Moves between your accounts · 6 left out",
	"Paychecks · $4,900 in September",
];

const dQuestion = (
	<>
		<div class="flex items-baseline justify-between gap-3">
			<h1 class="text-lg font-semibold">Your first page</h1>
			<p class="text-sm text-muted">4 of 14</p>
		</div>
		<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
			{DLEDGER_LINES.map((line) => (
				<li class="py-2 text-muted">{line}</li>
			))}
			<li class="py-2 text-ink">Costco · Groceries</li>
		</ul>
		<p class="mt-6 text-sm text-muted">
			Groceries · $610 in August · $674 in September
		</p>
		<p class="mt-2">
			<span class="inline-flex items-center rounded-full border border-dashed border-muted px-3 py-1 text-sm text-muted">
				$650 a month<span class="sr-only">Suggested, not kept yet</span>
			</span>
		</p>
		<h2 class="mt-3 font-serif text-2xl font-semibold">
			Make it the Groceries budget, from October on?
		</h2>
		<p class="mt-2 text-sm text-muted">
			Tally's suggestion: what Groceries spent in a typical month, raised to the
			next $10.
		</p>
		<div class="mt-4">
			<Button type="button" class="w-full">
				Yes, $650 a month
			</Button>
		</div>
		<details class="mt-3">
			<summary class="inline-flex min-h-11 cursor-pointer items-center text-ink">
				Another amount
			</summary>
		</details>
		<div class="mt-1">
			<Button kind="text" type="button">
				Not now
			</Button>
		</div>
	</>
);

const dTotalPicture = (
	<>
		<h1 class="text-lg font-semibold">Your first page</h1>
		<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
			{DLEDGER_LINES.map((line) => (
				<li class="py-2 text-muted">{line}</li>
			))}
			<li class="py-2 text-ink">Costco · Groceries</li>
		</ul>
		<div class="mt-4 flex justify-between border-t border-ink pt-3">
			<span class="text-lg">Budgets</span>
			<span class="tabular-nums">$4,050</span>
		</div>
		<div class="flex justify-between">
			<span class="text-lg">Spent so far in October</span>
			<span class="tabular-nums">−$2,486</span>
		</div>
		<div class="flex justify-between">
			<span class="text-lg">Bills still due this week</span>
			<span class="tabular-nums">−$153</span>
		</div>
		<div class="mt-2 border-b-[3px] border-double border-ink" />
		<p class="mt-4 text-lg text-muted">
			Safe to spend · <WhyLink section="budget" topic="safe to spend" />
		</p>
		<p class="font-serif text-6xl font-semibold tracking-tight">
			{money(SAFE)}
		</p>
		<p class="mt-3 font-serif text-lg italic">
			That's October, in your own numbers. Home keeps it up to date from here.
		</p>
		<div class="mt-6">
			<Button type="button" class="w-full">
				Go to Home
			</Button>
		</div>
	</>
);

/** Option D's replay: the new answer's line is written into the ledger, then the total is ruled off. */
const dReplay = (
	<>
		<h1 class="text-lg font-semibold">Your first page</h1>
		<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
			<li class="flex justify-between py-2 proposal-first-line">
				<span>Groceries, from October</span>
				<span class="tabular-nums">$650 a month</span>
			</li>
			{DLEDGER_LINES.map((line) => (
				<li class="py-2 text-muted">{line}</li>
			))}
		</ul>
		<div class="mt-4 flex justify-between border-t border-ink pt-3">
			<span class="text-lg">Budgets</span>
			<span class="tabular-nums">$4,050</span>
		</div>
		<div class="flex justify-between">
			<span class="text-lg">Spent so far in October</span>
			<span class="tabular-nums">−$2,486</span>
		</div>
		<div class="flex justify-between">
			<span class="text-lg">Bills still due this week</span>
			<span class="tabular-nums">−$153</span>
		</div>
		<div class="proposal-first-rule mt-2 border-b-[3px] border-double border-ink" />
		<p class="mt-4 text-lg text-muted">
			Safe to spend · <WhyLink section="budget" topic="safe to spend" />
		</p>
		<p class="font-serif text-6xl font-semibold tracking-tight proposal-first-amount">
			{money(SAFE)}
		</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// The page: four options, each with its pictures and one replay.

/** P125 on the proposals page: the four ways a new family's first week can go, drawn for the owner's pick. */
export function PolishRoundDProposals() {
	return (
		<Specimen
			id="p125-first-week"
			title="P125 · A new family's first week"
			tier="visual"
			sentence="Four ways a new family's first week can go, from linking a bank to a Home that's just Home. Each option is the family's app, on the same Chase household. Pick one."
		>
			<Fixed>
				Tally only suggests and a person decides (decision 101): nothing is
				saved until someone says yes; no cookies, and nothing remembered about a
				person beyond what the household's data says; the demo keeps P124 A;
				anything taught stays in How Tally works; no new client JavaScript.
			</Fixed>
			<Choices>
				<Choice
					name="Option A · The Opening Entry"
					width="w-full"
					note="Tally reads your last 90 days first and writes the first page of your books, ending in a budget you keep with one tap."
					cost="a first-budget rule (a spec line), a Home that is the entry until a budget exists, and checking for the import's end (htmx polling, a new pattern here)."
					why="a family sees its own numbers the first evening, and the first budget comes from their own months, not from a guess."
					recommended
				>
					<Shot caption="Before a bank: Home, with no figure yet">
						<Phone label="Option A, before a bank" demo={false} tab="home">
							{aBefore}
						</Phone>
					</Shot>
					<Shot caption="That evening: three of the bank's lines, struck, with Tally's row under each">
						<Phone label="Option A, that evening" demo={false} tab="home">
							{aEvening}
						</Phone>
					</Shot>
					<Shot caption="That evening, further down: Tally's entry, line by line">
						<Phone
							label="Option A, that evening, the entry"
							demo={false}
							scrolled
							tab="home"
						>
							{aEntry}
						</Phone>
					</Shot>
					<Shot caption="Next morning: Home's top, with the figure still to come">
						<Phone label="Option A, next morning" demo={false} tab="home">
							{aMorning}
						</Phone>
					</Shot>
					<Shot caption="Next morning, scrolled: A first budget, ticked">
						<Phone
							label="Option A, a first budget"
							demo={false}
							scrolled
							tab="home"
						>
							{aFirstBudget}
						</Phone>
					</Shot>
					<Shot caption="Next morning, scrolled further: the bills, the total, and the one button">
						<Phone
							label="Option A, first budget, the total"
							demo={false}
							scrolled
							tab="home"
						>
							{aFirstBudgetTail}
						</Phone>
					</Shot>
					<Shot caption="After the tap: Home, with Safe to spend and the first four budgets">
						<Phone label="Option A, Home after the tap" demo={false} tab="home">
							{aHome}
						</Phone>
					</Shot>
					<Shot caption="After the tap, scrolled: the other eight budgets">
						<Phone
							label="Option A, Home's other budgets"
							demo={false}
							scrolled
							tab="home"
						>
							{aHomeRest}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 6 seconds: each bank line is struck through in turn, then Tally's row shows under it">
						<Phone
							label="Option A, replay: the bank lines struck through"
							demo={false}
							scrolled
							tab="home"
						>
							{aReplay}
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="Option B · Pencil, then ink"
					recommended={false}
					width="w-full"
					note="Tally pencils your whole Home in from your history, dashed like every Tally guess, and one tap inks it in."
					cost="a first-budget rule (a spec line) and pencil versions of Home's number and rows; no new page."
					why="every number looks like a guess until someone keeps it, so nothing reads as settled before it is."
				>
					<Shot caption="Before a bank: the amount is a pencil blank, and one link">
						<Phone label="Option B, before a bank" demo={false} tab="home">
							{bBefore}
						</Phone>
					</Shot>
					<Shot caption="That evening: still a blank, and when it will be ready">
						<Phone label="Option B, that evening" demo={false} tab="home">
							{bEvening}
						</Phone>
					</Shot>
					<Shot caption="Next morning: Home pencilled in, with Tally's notes and two pencil rows">
						<Phone label="Option B, pencilled in" demo={false} tab="home">
							{bMorning}
						</Phone>
					</Shot>
					<Shot caption="Ink it in: a sheet over the pencilled Home">
						<Phone label="Option B, the ink-in sheet" demo={false} tab="home">
							<Sheet behind={bBehind} top="top-40">
								{bInkSheet}
							</Sheet>
						</Phone>
					</Shot>
					<Shot caption="Inked in: the same Home, in ink, with its bars in their colours">
						<Phone label="Option B, inked in" demo={false} tab="home">
							{bInked}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 5 seconds: the pencilled amount inks in, its dashed rule turns solid, and the bars fill">
						<Phone
							label="Option B, replay: the pencil inks in"
							demo={false}
							tab="home"
						>
							{bReplay}
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="Option C · The notebook fills in"
					recommended={false}
					width="w-full"
					note="Each real step pencils one stroke into Home's notebook drawing; the morning after the fourth, the fifth crosses them and Home is just Home."
					cost="a kept record of the five steps, a budget walk, and checking for the import's end (htmx polling)."
					why="a family sees the setup as one drawing that finishes itself, with no checklist to tick."
				>
					<Shot caption="Welcome: the notebook with a blank page">
						<Phone label="Option C, welcome" demo={false} tab="home">
							{cWelcome}
						</Phone>
					</Shot>
					<Shot caption="That evening: one stroke, for the bank">
						<Phone label="Option C, that evening" demo={false} tab="home">
							{cSpent}
						</Phone>
					</Shot>
					<Shot caption="The budget walk: a sheet over Home, with two strokes">
						<Phone label="Option C, the budget walk" demo={false} tab="home">
							<Sheet behind={cWalkBehind} top="top-40">
								{cWalkSheet}
							</Sheet>
						</Phone>
					</Shot>
					<Shot caption="Four strokes, and Safe to spend">
						<Phone label="Option C, four strokes" demo={false} tab="home">
							{cFour}
						</Phone>
					</Shot>
					<Shot caption="Thursday: the fifth stroke crosses the four, and all five are ink">
						<Phone label="Option C, five strokes" demo={false} tab="home">
							{cFive}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 6 seconds: the fifth stroke draws across the four, and all five turn to ink">
						<Phone
							label="Option C, replay: the fifth stroke"
							demo={false}
							tab="home"
						>
							{cReplay}
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="Option D · Kitchen-table sitting"
					recommended={false}
					width="w-full"
					note="Once Tally has sorted last month, it asks a few plain questions one at a time; each answer is written as a ledger line, and the sitting ends by ruling off your first Safe to spend."
					cost="a question page, a first-budget rule (a spec line) and one kept date for when the sitting ends."
					why="a family answers one small question at a time, and each answer is a line they can read back."
				>
					<Shot caption="Next morning: 14 questions, and Safe to spend written in at the end">
						<Phone label="Option D, next morning" demo={false} tab="home">
							{dMorning}
						</Phone>
					</Shot>
					<Shot caption="A question page: the ledger so far, and one question with one tap">
						<Phone label="Option D, a question page" demo={false} tab="home">
							{dQuestion}
						</Phone>
					</Shot>
					<Shot caption="The total: the ledger, and Safe to spend ruled off">
						<Phone label="Option D, the total" demo={false} tab="home">
							{dTotalPicture}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 6 seconds: a new answer is written in, then the total is ruled off">
						<Phone
							label="Option D, replay: a new answer and the total"
							demo={false}
							tab="home"
						>
							{dReplay}
						</Phone>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}
