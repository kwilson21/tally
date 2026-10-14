// P125 (#95): a new family's first week, five ways, drawn for the owner's pick (proposal only: nothing in the
// app changes). Every picture is the family's app, with no demo banner, on one sample household: Chase linked
// Tue Oct 13 at 7 p.m., today Wed Oct 14, Eastern time. Where the app's own components draw the same at a
// phone's size they are used as they are (Band, ProgressRow, CategoryIcon, FoldedRow,
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

/** Tally's part: six lines, each a promise until Tally has found it. A found line has its fact and the bank's own line that proves it (or a muted sub). */
type PartLine = {
	promise: string;
	found?: {
		label: string;
		fact: string;
		/** The bank's own line, struck through, and the name Tally gives it. */
		proof?: { bank: string; name: string };
		/** A muted second line for a find with no bank line to prove it. */
		sub?: string;
	};
};

const TALLY_LINES: PartLine[] = [
	{
		promise: "Find your paycheck",
		found: {
			label: "Found your paycheck",
			fact: "$2,450 every other Friday, from Acme Corp",
			proof: { bank: ACME.rawName, name: ACME.displayName },
		},
	},
	{
		promise: "Spot your bills",
		found: {
			label: "Spotted your bills",
			fact: "8 that come back every month, about $2,062",
			sub: "Harbor Property, Geico, Spectrum and 5 more",
		},
	},
	{
		promise: "Leave out your transfers",
		found: {
			label: "Left out your transfers",
			fact: "6 moves between your own accounts, so they don't count as spending",
			proof: { bank: SAVINGS.rawName, name: SAVINGS.displayName },
		},
	},
	{
		promise: "Name your stores",
		found: {
			label: "Named your stores",
			fact: "38 stores, from your bank's text",
			proof: { bank: BLUE_BOTTLE.rawName, name: BLUE_BOTTLE.displayName },
		},
	},
	{ promise: "Sort your spending" },
	{ promise: "Write your first budget" },
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

/** The promise: its label in muted words, and a dashed blank for what isn't found yet. `cls` adds the replay's classes. */
function PromiseRow({ label, cls = "" }: { label: string; cls?: string }) {
	return (
		<div class={`flex min-h-11 items-center justify-between gap-3 py-1 ${cls}`}>
			<span class="text-lg text-muted">{label}</span>
			<span class="inline-block h-px w-24 border-b-2 border-dashed border-muted">
				<span class="sr-only">Not done yet</span>
			</span>
		</div>
	);
}

/** What Tally found: its label in ink, the fact, and the bank's own line struck through, with Tally's name beside it (or a muted sub). `cls` names the replay's classes for each part. */
function FoundLines({
	found,
	cls = {},
}: {
	found: NonNullable<PartLine["found"]>;
	cls?: { label?: string; fact?: string; strike?: string; name?: string };
}) {
	return (
		<>
			<p class={`text-lg font-medium ${cls.label ?? ""}`}>{found.label}</p>
			<p class={`mt-1 text-base ${cls.fact ?? ""}`}>{found.fact}</p>
			{found.proof ? (
				<p class={`mt-1 flex min-w-0 text-sm ${cls.fact ?? ""}`}>
					<span class="sr-only">Your bank wrote </span>
					<span class="relative min-w-0 truncate text-muted">
						{found.proof.bank}
						<span
							aria-hidden="true"
							class={`absolute inset-x-0 top-1/2 h-px origin-left bg-muted ${cls.strike ?? ""}`}
						/>
					</span>
					<span class="sr-only">; Tally reads it as </span>
					<span class={`ml-1 shrink-0 text-ink ${cls.name ?? ""}`}>
						{found.proof.name}
					</span>
					<span class="sr-only">.</span>
				</p>
			) : (
				<p class={`mt-1 text-sm text-muted ${cls.name ?? ""}`}>{found.sub}</p>
			)}
		</>
	);
}

/** The replay's step class for each line that turns found: it names the keyframes that line reads, so line 3 turns 200 ms after line 1 and line 4 400 ms after (app.css, "Proposals only (P125)"), and line 2 turns at 47.5%. The replay draws lines 1 to 4 only. */
const REPLAY_STEP = [
	"",
	"proposal-first-second-round",
	"proposal-first-later",
	"proposal-first-last",
];

/** One line of Tally's part: a promise, or once found, its fact and proof. `replay` draws both states in one cell, with the classes that animate them. */
function PartRow({
	line,
	found,
	sub,
	ruled,
	replay,
}: {
	line: PartLine;
	found: boolean;
	/** A muted second line under a promise. */
	sub?: string;
	/** The last line sits under an ink rule. */
	ruled: boolean;
	replay?: { step: string };
}) {
	const rule = ruled ? "border-t border-ink" : "";
	if (!found || !line.found) {
		return (
			<li class={`${sub ? "pb-2" : ""} ${rule}`}>
				<PromiseRow label={line.promise} />
				{sub && <p class="mt-1 text-sm text-muted">{sub}</p>}
			</li>
		);
	}
	if (!replay) {
		return (
			<li class={`py-3 ${rule}`}>
				<FoundLines found={line.found} />
			</li>
		);
	}
	return (
		<li class={`py-3 ${rule} ${replay.step}`}>
			<div class="grid">
				<PromiseRow
					label={line.promise}
					cls="col-start-1 row-start-1 self-start proposal-first-promise opacity-0"
				/>
				<div class="col-start-1 row-start-1">
					<FoundLines
						found={line.found}
						cls={{
							label: "proposal-first-label",
							fact: "proposal-first-fact",
							strike: "proposal-first-strike",
							name: "proposal-first-name",
						}}
					/>
				</div>
			</div>
		</li>
	);
}

/** Tally's part: its lines in order, from line `from` up to line `to` (all six by default). `found` names the lines Tally has found and `subs` gives promises their muted line. */
function TallysPart({
	found = [],
	subs = {},
	from = 0,
	to = TALLY_LINES.length,
	replay = false,
}: {
	found?: number[];
	subs?: Record<number, string>;
	from?: number;
	to?: number;
	replay?: boolean;
}) {
	return (
		<ul class="divide-y divide-rule border-y border-rule">
			{TALLY_LINES.slice(from, to).map((line, j) => {
				const i = from + j;
				return (
					<PartRow
						line={line}
						found={found.includes(i)}
						sub={subs[i]}
						ruled={i === TALLY_LINES.length - 1}
						replay={replay ? { step: REPLAY_STEP[i] ?? "" } : undefined}
					/>
				);
			})}
		</ul>
	);
}

/** Your part: the one thing the family does, on a line under an ink rule. The picture says what sits at its right and under it. */
function YourPart({ right, children }: { right: Child; children?: Child }) {
	return (
		<div class="mt-4 border-t border-ink pt-3">
			<div class="flex items-baseline justify-between gap-3">
				<p class="text-lg font-medium">Your part</p>
				{right}
			</div>
			{children}
		</div>
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
 * proposal-only classes in app.css. The strokes are the illustration's own, in the same places: they copy the
 * five `<line>`s at src/views/illustration.tsx lines 18 to 22. LedgerIllustration takes no props, so if that
 * drawing changes, these lines change with it by hand.
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
	drawLast = false,
	size = "size-32",
}: {
	strokes: number;
	ink?: boolean;
	/** C's replay: all five strokes ink in from pencil, and the fifth draws across the four. */
	replay?: boolean;
	/** E's replay: the last stroke is drawn in pencil and inks late in the loop; the strokes before it are already ink. */
	drawLast?: boolean;
	/** The notebook's box: size-32 by default, size-12 beside a question, size-20 at the top of E's replay. */
	size?: string;
}) {
	const lineClass = (i: number) => {
		if (replay) {
			return `stroke-ink proposal-first-stroke${i === 4 ? " proposal-first-cross" : ""}`;
		}
		if (drawLast) {
			return i === strokes - 1
				? "stroke-ink proposal-first-draw"
				: "stroke-ink";
		}
		return ink ? "stroke-ink" : "stroke-muted";
	};
	return (
		<svg
			class={`${size} shrink-0`}
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
						<line x1={x1} y1={y1} x2={x2} y2={y2} class={lineClass(i)} />
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

/** One stroke's line in TallySteps: its name, its note at the right, and whether the stroke is done. */
type StepLine = { name: string; done: boolean; note: string };

/** The five lines in order: `notes` gives each its note, and the first `done` of them are done. */
function stepsOf(
	names: readonly string[],
	notes: readonly string[],
	done: number,
): StepLine[] {
	return names.map((name, i) => ({
		name,
		done: i < done,
		note: notes[i] ?? "",
	}));
}

/**
 * The five strokes as a list, under the notebook (P125 C and E): each line's glyph is its stroke, a short
 * vertical line for the first four and a diagonal slash for the fifth, in ink when done and dashed muted when
 * not. A done line says so in words too (sr-only "done"); the note at the right says what was done.
 */
function TallySteps({ steps }: { steps: StepLine[] }) {
	const done = steps.filter((s) => s.done).length;
	return (
		<div class="mt-4">
			<p class="text-sm text-muted">Your first tally · {done} of 5</p>
			<ul class="mt-2 border-t border-rule">
				{steps.map((s, i) => (
					<li class="flex min-h-11 items-center gap-3 border-b border-rule">
						<svg
							class="h-6 w-3 shrink-0"
							viewBox="0 0 12 24"
							fill="none"
							stroke-width="2"
							stroke-linecap="round"
							aria-hidden="true"
						>
							{i < 4 ? (
								<line
									x1="6"
									y1="2"
									x2="6"
									y2="22"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							) : (
								<line
									x1="1"
									y1="22"
									x2="11"
									y2="2"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							)}
						</svg>
						<span
							class={`min-w-0 flex-1 py-2 text-base ${s.done ? "text-ink" : "text-muted"}`}
						>
							{s.name}
							{s.done && <span class="sr-only">, done</span>}
						</span>
						<span class="shrink-0 text-sm text-muted">{s.note}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/** A screen's top with the notebook beside its headline, for option C's and E's setup (in place of Home's own drawing). `caption` names the count under the notebook; a TallySteps list says it instead. */
function StrokesTop({
	label,
	headline,
	strokes,
	ink = false,
	status,
	band,
	caption = true,
	children,
}: {
	label: Child;
	headline: Child;
	strokes: number;
	ink?: boolean;
	status: Child;
	band?: Child;
	caption?: boolean;
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
					{caption && !ink && (
						<p class="text-sm text-muted">
							Your first tally · {strokes} of 5
							{strokes > 0 && <span class="sr-only">, in pencil</span>}
						</p>
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
// Option A · The Opening Entry: the first page of the books, written from the last 90 days.

const aBefore = (
	<>
		<div class="flex items-center justify-between gap-4">
			<h1 class="font-serif text-4xl font-semibold tracking-tight">
				Let Tally read first.
			</h1>
			<div class="shrink-0 [&>svg]:size-20">
				<LedgerIllustration />
			</div>
		</div>
		<p class="mt-4 text-base">
			Link your bank and Tally does the dull part: it reads your last 90 days,
			tidies them up and writes you a first budget. You won't type a number.
		</p>
		<h2 class="mt-4 text-sm font-medium text-muted">Tally's part</h2>
		<div class="mt-2">
			<TallysPart />
		</div>
		<YourPart right={<p class="text-muted">Link a bank</p>}>
			<div class="mt-3">
				<Button type="button" class="w-full">
					Link a bank
				</Button>
			</div>
			<p class="mt-2 text-sm text-muted">
				Tally can only read your bank. It can't move money.
			</p>
		</YourPart>
	</>
);

/** The before-bank Home, dimmed behind the sheet that Link a bank opens on Home: a placeholder for Plaid's own screens. */
const aPlaid = (
	<Sheet behind={aBefore} top="top-64">
		<h2 class="font-serif text-2xl font-semibold text-muted">
			Plaid's own screens
		</h2>
		<p class="text-muted">
			Pick your bank and sign in with Plaid. Tally never sees your bank
			password.
		</p>
		<div class="h-40 rounded-control border-2 border-dashed border-muted" />
	</Sheet>
);

/** A minute later: the first month is in, and Home has filled in lines 1 to 4 of Tally's part, with line 2 still waiting. */
const aMinute = (
	<>
		<h1 class="font-serif text-4xl font-semibold tracking-tight">
			Reading Chase
		</h1>
		<p class="mt-3 font-serif text-lg italic">
			142 transactions in so far, from Sep 14 to Oct 13.
		</p>
		<p class="mt-1 text-muted">You can close Tally. It keeps reading.</p>
		<h2 class="mt-4 text-sm font-medium text-muted">Tally's part</h2>
		<div class="mt-2">
			<TallysPart
				found={[0, 2, 3]}
				to={4}
				subs={{ 1: "Once all 90 days are in" }}
			/>
		</div>
	</>
);

/** That evening: Tally's part, with lines 1 to 4 found. Lines 5 and 6 and Your part come in the scrolled picture below. */
const aEvening = (
	<>
		<h1 class="font-serif text-4xl font-semibold tracking-tight">
			Your last 90 days
		</h1>
		<p class="mt-3 font-serif text-lg italic">
			All 412 are in, from Jul 16 to Oct 13. Tally sorts the rest tonight, and
			your first budget will be ready by about 6 a.m.
		</p>
		<p class="mt-1 text-muted">Nothing for you to do until then.</p>
		<h2 class="mt-4 text-sm font-medium text-muted">Tally's part</h2>
		<div class="mt-2">
			<TallysPart found={[0, 1, 2, 3]} to={4} />
		</div>
	</>
);

/** That evening, further down: the last two lines, and Your part. */
const aEveningRest = (
	<>
		<TallysPart
			from={4}
			subs={{
				4: "50 of 412 sorted so far. The rest tonight.",
				5: "Ready by about 6 a.m.",
			}}
		/>
		<YourPart right={<p class="text-ink">Linked Chase</p>} />
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
			September, rounded up to the next $10. ·{" "}
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
		<div class="mt-3 flex items-baseline justify-between gap-3">
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

/** Option A's replay, 8 s: the headline and the status swap in turn, and lines 1 to 4 turn found as the bank's lines arrive (app.css, "Proposals only (P125)"). Its end state is the evening's words, so reduced motion rests there. */
const aReplay = (
	<>
		<h1 class="font-serif text-4xl font-semibold tracking-tight">
			<span class="grid">
				<span class="col-start-1 row-start-1 opacity-0 proposal-first-title-first">
					Reading Chase
				</span>
				<span class="col-start-1 row-start-1 proposal-first-title-last">
					Your last 90 days
				</span>
			</span>
		</h1>
		<div class="mt-3 grid font-serif text-lg italic">
			<span class="col-start-1 row-start-1 opacity-0 proposal-first-status-first">
				Reading Chase. The first month usually takes under a minute.
			</span>
			<span class="col-start-1 row-start-1 opacity-0 proposal-first-status-middle">
				142 transactions in so far, from Sep 14 to Oct 13.
			</span>
			<span class="col-start-1 row-start-1 proposal-first-status-last">
				All 412 are in, from Jul 16 to Oct 13. Tally sorts the rest tonight, and
				your first budget will be ready by about 6 a.m.
			</span>
		</div>
		<h2 class="mt-4 text-sm font-medium text-muted">Tally's part</h2>
		<div class="mt-2">
			<TallysPart found={[0, 1, 2, 3]} to={4} replay />
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
			What each category spent in a typical month, August and September, rounded
			up to the next $10. · <WhyLink section="budget" topic="a first budget" />
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
// Its five lines are TallySteps (under the notebook); a finished step says what it did.

const C_NAMES = [
	"Link your bank",
	"Sort what Tally wasn't sure of",
	"Set your budgets",
	"Keep a bill",
	"Tomorrow · Tally keeps count on its own",
];

/** Thursday's Safe to spend: $1,398, after the overnight sort's three new transactions. */
const SAFE_THURSDAY = 139800;

/** Thursday, with all five strokes in ink: C's last picture and E's last, with their own step names. */
function FiveStrokes({ steps }: { steps: StepLine[] }) {
	return (
		<StrokesTop
			label={
				<>
					Safe to spend · <WhyLink section="budget" topic="safe to spend" />
				</>
			}
			headline={<Amount>{money(SAFE_THURSDAY)}</Amount>}
			strokes={5}
			ink
			status="Five. Overnight Tally kept count on its own: 3 new transactions, all sorted. You're set up."
		>
			<TallySteps steps={steps} />
			<p class="mt-4 text-sm text-muted">
				From tomorrow this list goes, and Home is just Home.
			</p>
		</StrokesTop>
	);
}

const cWelcome = (
	<StrokesTop
		label="Welcome to Tally"
		headline={<h1 class={TITLE}>One thing today.</h1>}
		strokes={0}
		caption={false}
		status="Tally does the reading; you make the calls."
		band={
			<Band
				href="/accounts"
				detail="Tally can only read it. It can't move money."
			>
				Link your bank
			</Band>
		}
	>
		<TallySteps
			steps={stepsOf(C_NAMES, ["Next", "Later", "Later", "Later", "Later"], 0)}
		/>
	</StrokesTop>
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
		caption={false}
		status="That's all for today. Tally sorts what it's sure of by tomorrow, so these will be fewer."
		band={FAMILY_BAND}
	>
		<TallySteps
			steps={stepsOf(
				C_NAMES,
				["Chase, linked", "86 to go", "Later", "Later", "Later"],
				1,
			)}
		/>
	</StrokesTop>
);

/** The budget walk: one category at a time, over Home with two strokes drawn and its count under the notebook. */
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

const cBills = (
	<StrokesTop
		label={
			<>
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</>
		}
		headline={<Amount>{money(SAFE)}</Amount>}
		strokes={3}
		caption={false}
		status="Three. Tally found 8 charges that come back every month. Keep the real ones and that's four."
		band={
			<Band
				href="/bills/find"
				detail="From repeat charges in the last 3 months"
			>
				8 possible bills found
			</Band>
		}
	>
		<TallySteps
			steps={stepsOf(
				C_NAMES,
				["Chase, linked", "Done", "12 budgets", "Next", "Later"],
				3,
			)}
		/>
	</StrokesTop>
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
		caption={false}
		status="Four. Tomorrow Tally keeps count on its own, and that's the fifth."
	>
		<TallySteps
			steps={stepsOf(
				C_NAMES,
				[
					"Chase, linked",
					"Done",
					"12 budgets",
					"Harbor Property and 7 more",
					"Next",
				],
				4,
			)}
		/>
	</StrokesTop>
);

const cFive = (
	<FiveStrokes
		steps={stepsOf(
			C_NAMES,
			[
				"Chase, linked",
				"Done",
				"12 budgets",
				"Harbor Property and 7 more",
				"Overnight",
			],
			5,
		)}
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
// Option D · Kitchen-table sitting: Tally sorts the last 90 days from the bank, then asks a few plain questions;
// each answer is a line in the family's own first page.

const dMorning = (
	<HomeTop
		amount={blank("Pencil blank, not written in yet")}
		status="Tally read your last 90 days from Chase and sorted 362 overnight. It has 14 questions for you, and Safe to spend is written in at the end."
		howLink={
			<p class="text-sm text-muted">
				Your pay first, then your bills, then a budget for each category that
				spent something.
			</p>
		}
		band={
			<Band href="/questions" detail="About three minutes. Most are one tap.">
				14 questions from Tally
			</Band>
		}
	/>
);

const DLEDGER_LINES = [
	"From Chase · 412 lines · Jul 16 to Oct 13",
	"Moves between your accounts · 6 left out",
	"Paychecks · $4,900 in September",
];

/** A line of a question page's ledger: an answer (ink) or what the bank says (muted). */
type LedgerLine = { text: string; ink?: boolean };

/** A question page's top: "Your first page", the count at the right, and the ledger so far. */
function FirstPage({
	right,
	lines,
	children,
}: {
	right?: Child;
	lines: LedgerLine[];
	children?: Child;
}) {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-lg font-semibold">Your first page</h1>
				{right}
			</div>
			<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
				{lines.map((l) => (
					<li class={`py-2 ${l.ink ? "text-ink" : "text-muted"}`}>{l.text}</li>
				))}
			</ul>
			{children}
		</>
	);
}

/** The small notebook beside a question page's headline, with what it counts. */
function SmallNotebook({ strokes, text }: { strokes: number; text: string }) {
	return (
		<div class="flex items-center gap-2">
			<Notebook strokes={strokes} ink size="size-12" />
			<p class="text-sm text-muted">{text}</p>
		</div>
	);
}

const D_LEDGER: LedgerLine[] = [
	...DLEDGER_LINES.map((text) => ({ text })),
	{ text: "Costco · Groceries", ink: true },
];

const E_LEDGER: LedgerLine[] = [
	{ text: "Pay · Acme Corp, $2,450 every other Friday", ink: true },
	{ text: "Bills · 8 kept, about $2,062 a month", ink: true },
];

/** The Groceries question, as D asks it and as E asks it one at a time: what the bank shows, the suggestion in a dashed tag, and the one button. */
function GroceriesQuestion({ quiet }: { quiet: string }) {
	return (
		<>
			<p class="mt-6 text-base text-muted">
				Your bank shows Groceries spent $610 in August and $674 in September.
			</p>
			<p class="mt-2">
				<span class="inline-flex items-center rounded-full border border-dashed border-muted px-3 py-1 text-sm text-muted">
					$650 a month <span class="sr-only">Suggested, not kept yet</span>
				</span>
			</p>
			<h2 class="mt-3 font-serif text-2xl font-semibold">
				Make $650 a month your Groceries budget?
			</h2>
			<p class="mt-2 text-sm text-muted">
				Tally's suggestion: a typical month, rounded up to the next $10. From
				October on.
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
					{quiet}
				</Button>
			</div>
		</>
	);
}

const dQuestion = (
	<FirstPage right={<p class="text-sm text-muted">4 of 14</p>} lines={D_LEDGER}>
		<GroceriesQuestion quiet="Not now" />
	</FirstPage>
);

/** A category the bank has no history for: the same page, with no suggestion and an empty amount. */
const dNoHistory = (
	<FirstPage
		right={<p class="text-sm text-muted">13 of 14</p>}
		lines={D_LEDGER}
	>
		<p class="mt-6 text-base text-muted">
			Your bank shows nothing for Date Night in August or September.
		</p>
		<h2 class="mt-3 font-serif text-2xl font-semibold">
			Do you want a Date Night budget?
		</h2>
		<div class="mt-3">
			<MoneyInput
				id="date-night"
				name="date_night"
				label="Date Night, a month"
				value=""
			/>
		</div>
		<div class="mt-4">
			<Button type="button" class="w-full">
				Save this budget
			</Button>
		</div>
		<div class="mt-1">
			<Button kind="text" type="button">
				No Date Night budget
			</Button>
		</div>
	</FirstPage>
);

/** The ruled-off total: the budgets, what's spent and still due, the double rule, and Safe to spend with its status. */
function RuledTotal({ status }: { status: string }) {
	return (
		<>
			<div class="mt-4 flex justify-between border-t border-ink pt-3">
				<span class="text-lg">Budgets</span>
				<span class="tabular-nums">{money(BUDGETS_TOTAL)}</span>
			</div>
			<div class="flex justify-between">
				<span class="text-lg">Spent so far in October</span>
				<span class="tabular-nums">−{money(SPENT)}</span>
			</div>
			<div class="flex justify-between">
				<span class="text-lg">Bills still due this week</span>
				<span class="tabular-nums">−{money(BILLS_DUE)}</span>
			</div>
			<div class="mt-2 border-b-[3px] border-double border-ink" />
			<p class="mt-4 text-lg text-muted">
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</p>
			<p class="font-serif text-6xl font-semibold tracking-tight">
				{money(SAFE)}
			</p>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			<div class="mt-6">
				<Button type="button" class="w-full">
					Go to Home
				</Button>
			</div>
		</>
	);
}

const dTotalPicture = (
	<FirstPage lines={D_LEDGER}>
		<RuledTotal status="That's October, in your own numbers. Home keeps it up to date from here." />
	</FirstPage>
);

/** Option D's replay: the new answer's line is written into the ledger, then the total is ruled off. */
const dReplay = (
	<>
		<h1 class="text-lg font-semibold">Your first page</h1>
		<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
			{DLEDGER_LINES.map((line) => (
				<li class="py-2 text-muted">{line}</li>
			))}
			<li class="py-2 text-ink">Costco · Groceries</li>
			<li class="flex justify-between py-2 proposal-first-line">
				<span>Groceries, from October</span>
				<span class="tabular-nums">$650 a month</span>
			</li>
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
// Option E · The notebook, one question at a time: C's notebook counts the steps, and D's plain questions fill
// it in, from the family's own last 90 days. The budgets can be kept all at once or one at a time.

const E_NAMES = [
	"Link your bank",
	"Your pay",
	"Your bills",
	"Your budgets",
	"Tomorrow · Tally keeps count on its own",
];

const eBefore = (
	<>
		<div class="mt-2 flex items-center justify-between gap-4">
			<h1 class="font-serif text-4xl font-semibold tracking-tight">
				Five strokes, and you're set up.
			</h1>
			<Notebook strokes={0} size="size-24" />
		</div>
		<TallySteps
			steps={stepsOf(
				E_NAMES,
				[
					"About a minute",
					"One question",
					"One question",
					"One tap, or one at a time",
					"Later",
				],
				0,
			)}
		/>
		<div class="mt-6">
			<Button type="button" class="w-full">
				Link a bank
			</Button>
		</div>
		<p class="mt-3 text-sm text-muted">
			Tally can only read your bank. It can't move money.
		</p>
	</>
);

const eEvening = (
	<>
		<div class="mt-2 flex items-center justify-between gap-4">
			<p class="text-lg text-muted">Tuesday, 7 p.m.</p>
			<Notebook strokes={1} ink size="size-24" />
		</div>
		<p class="mt-3 font-serif text-lg italic">
			One. Tally's reading your last 90 days from Chase. Your questions will be
			ready in the morning.
		</p>
		<p class="mt-2 text-sm text-muted">Nothing for you to do until then.</p>
		<TallySteps
			steps={stepsOf(
				E_NAMES,
				[
					"Chase, linked",
					"Tomorrow morning",
					"Tomorrow morning",
					"Tomorrow morning",
					"Later",
				],
				1,
			)}
		/>
	</>
);

const eMorning = (
	<StrokesTop
		label={
			<>
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</>
		}
		headline={blank("Pencil blank, not written in yet")}
		strokes={1}
		ink
		caption={false}
		status="Tally sorted 362 overnight. Three things to check, and Safe to spend is written in at the end."
		band={
			<Band
				href="/questions"
				detail="Your pay, your bills and your budgets. About three minutes."
			>
				Three things to check
			</Band>
		}
	/>
);

const ePay = (
	<FirstPage
		right={<SmallNotebook strokes={1} text="1 of 5" />}
		lines={[
			{ text: "From Chase · 412 lines · Jul 16 to Oct 13" },
			{ text: "Moves between your accounts · 6 left out" },
		]}
	>
		<p class="mt-6 text-base text-muted">
			Your bank shows ACME CORP PAYROLL paying $2,450 every other Friday, 7
			times since Jul 17.
		</p>
		<h2 class="mt-3 font-serif text-2xl font-semibold">Is this your pay?</h2>
		<div class="mt-4">
			<Button type="button" class="w-full">
				Yes, that's my pay
			</Button>
		</div>
		<div class="mt-1">
			<Button kind="text" type="button">
				No, it's something else
			</Button>
		</div>
	</FirstPage>
);

const eBudgets = (
	<FirstPage
		right={<SmallNotebook strokes={3} text="3 of 5" />}
		lines={E_LEDGER}
	>
		<p class="mt-3 text-sm text-muted">
			Your bank shows what each category spent in August and September. Tally
			rounded each up to the next $10.
		</p>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{BUDGETS.slice(0, 5).map((b) => (
				<li class="flex items-center justify-between gap-3 py-1">
					<div class="min-w-0">
						<p class="text-base">{b.name}</p>
						<p class="text-sm text-muted">
							Aug {money((b.aug ?? 0) * 100)} · Sep {money((b.sep ?? 0) * 100)}
						</p>
					</div>
					<span class="shrink-0 rounded-full border border-dashed border-muted px-3 py-0.5 text-sm text-muted">
						{money(b.budgetCents)}
						<span class="sr-only">Suggested, not kept yet</span>
					</span>
				</li>
			))}
		</ul>
		<div class="mt-1">
			<FoldedRow label="7 more · $1,120 a month" />
		</div>
		<h2 class="mt-3 font-serif text-xl font-semibold">
			Keep all 12 budgets, {money(BUDGETS_TOTAL)} a month?
		</h2>
		<div class="mt-3">
			<Button type="button" class="w-full">
				Keep all 12
			</Button>
		</div>
		<div class="mt-2">
			<Button kind="secondary" type="button" class="w-full">
				One at a time
			</Button>
		</div>
		<p class="mt-3 text-sm text-muted">
			Once set, a budget can be changed on Home but not removed.
		</p>
	</FirstPage>
);

const eOne = (
	<FirstPage
		right={<SmallNotebook strokes={3} text="Budgets · 1 of 12" />}
		lines={E_LEDGER}
	>
		<GroceriesQuestion quiet="Skip this one" />
	</FirstPage>
);

const eTotal = (
	<FirstPage
		right={<SmallNotebook strokes={4} text="4 of 5" />}
		lines={E_LEDGER}
	>
		<RuledTotal status="Four. Tomorrow Tally keeps count on its own, and that's the fifth." />
	</FirstPage>
);

const eFive = (
	<FiveStrokes
		steps={stepsOf(
			E_NAMES,
			[
				"Chase, linked",
				"Acme Corp",
				"Harbor Property and 7 more",
				"12 budgets",
				"Overnight",
			],
			5,
		)}
	/>
);

/**
 * Option E's replay, 6 s: the bills question is answered (its button presses, the question fades to 40%), the
 * Bills line writes in, and the third stroke is drawn in pencil and inks as the counter goes from 2 of 5 to 3 of 5.
 * The Bills line and the third stroke keep their places before they show, so nothing moves in the loop.
 */
const eReplay = (
	<>
		<div class="flex items-center justify-between gap-3">
			<h1 class="text-lg font-semibold">Your first page</h1>
			<div class="flex items-center gap-3">
				<Notebook strokes={3} drawLast size="size-20" />
				<span class="grid text-base">
					<span class="col-start-1 row-start-1 opacity-0 proposal-first-counter-before">
						2 of 5
					</span>
					<span class="col-start-1 row-start-1 proposal-first-counter-after">
						3 of 5
					</span>
				</span>
			</div>
		</div>
		<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
			<li class="py-2 text-ink">Pay · Acme Corp, $2,450 every other Friday</li>
			<li class="py-2 text-ink proposal-first-bills">
				Bills · 8 kept, about $2,062 a month
			</li>
		</ul>
		<div class="mt-6 text-muted opacity-40 proposal-first-answer">
			<p class="text-base">
				Your bank shows 8 charges that come back every month, about $2,062 in
				all: Harbor Property $1,600, Geico $142, Spectrum $70 and 5 more.
			</p>
			<h2 class="mt-3 font-serif text-2xl font-semibold">
				Keep these 8 as bills?
			</h2>
			<div class="mt-4">
				<Button type="button" class="w-full proposal-first-press">
					Keep these 8
				</Button>
			</div>
			<div class="mt-1">
				<Button kind="text" type="button">
					Choose which
				</Button>
			</div>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// The page: five options, each with its pictures and one replay.

/** P125 on the proposals page: the five ways a new family's first week can go, drawn for the owner's pick. */
export function PolishRoundDProposals() {
	return (
		<Specimen
			id="p125-first-week"
			title="P125 · A new family's first week"
			tier="visual"
			sentence="Five ways a new family's first week can go, from linking a bank to a Home that's just Home. Each option is the family's app, on the same Chase household. Pick one."
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
					note="Tally's part against yours: Tally finds your paycheck, bills and transfers, names your stores and writes a first budget, and you link a bank. Home fills itself in while Tally reads."
					cost="a first-budget rule (a spec line), a Home that is the entry until a budget exists, Plaid Link opened on Home (the approved plaid-link.js, loaded there while no bank is linked), and Home checking every 5 seconds while Tally reads (htmx polling, a new pattern here). The status line is the only thing read aloud: once when the first month is in and once when all 90 days are."
					why="a family sees what Tally does for them on their own money as it arrives, and the only thing they did was link a bank."
					recommended={false}
				>
					<Shot caption="Before a bank: Tally's part, and yours">
						<Phone label="Option A, before a bank" demo={false} tab="home">
							{aBefore}
						</Phone>
					</Shot>
					<Shot caption="Link a bank opens Plaid right on Home">
						<Phone
							label="Option A, Plaid opened on Home, over the dimmed Home"
							demo={false}
							tab="home"
						>
							{aPlaid}
						</Phone>
					</Shot>
					<Shot caption="A minute later: the first month is in, and Home fills itself in">
						<Phone
							label="Option A, a minute later, with the first month in"
							demo={false}
							tab="home"
						>
							{aMinute}
						</Phone>
					</Shot>
					<Shot caption="That evening: Tally's part, done">
						<Phone label="Option A, that evening" demo={false} tab="home">
							{aEvening}
						</Phone>
					</Shot>
					<Shot caption="That evening, scrolled: the rest, and your part">
						<Phone
							label="Option A, that evening, scrolled: the rest, and your part"
							demo={false}
							scrolled
							tab="home"
						>
							{aEveningRest}
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
					<Shot caption="Replay, a few minutes shortened to 8 seconds: Home fills itself in as the bank's lines arrive">
						<Phone
							label="Option A, replay: Home fills itself in as the lines arrive"
							demo={false}
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
						<Phone
							label="Option B, before a bank, with the amount a pencil blank"
							demo={false}
							tab="home"
						>
							{bBefore}
						</Phone>
					</Shot>
					<Shot caption="That evening: still a blank, and when it will be ready">
						<Phone
							label="Option B, that evening, with the amount still a pencil blank"
							demo={false}
							tab="home"
						>
							{bEvening}
						</Phone>
					</Shot>
					<Shot caption="Next morning: Home pencilled in, with Tally's notes and two pencil rows">
						<Phone
							label="Option B, pencilled in, the amount in pencil"
							demo={false}
							tab="home"
						>
							{bMorning}
						</Phone>
					</Shot>
					<Shot caption="Ink it in: a sheet over the pencilled Home">
						<Phone
							label="Option B, the ink-in sheet over the pencilled Home"
							demo={false}
							tab="home"
						>
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
						<Phone
							label="Option C, that evening, one stroke in pencil"
							demo={false}
							tab="home"
						>
							{cSpent}
						</Phone>
					</Shot>
					<Shot caption="The budget walk: a sheet over Home, with two strokes">
						<Phone
							label="Option C, the budget walk, two strokes in pencil"
							demo={false}
							tab="home"
						>
							<Sheet behind={cWalkBehind} top="top-40">
								{cWalkSheet}
							</Sheet>
						</Phone>
					</Shot>
					<Shot caption="The bills step: three strokes, and eight possible bills">
						<Phone
							label="Option C, the bills step, three strokes in pencil"
							demo={false}
							tab="home"
						>
							{cBills}
						</Phone>
					</Shot>
					<Shot caption="Four strokes, and Safe to spend">
						<Phone
							label="Option C, four strokes in pencil"
							demo={false}
							tab="home"
						>
							{cFour}
						</Phone>
					</Shot>
					<Shot caption="Thursday: the fifth stroke crosses the four, and all five are ink">
						<Phone
							label="Option C, five strokes in ink"
							demo={false}
							tab="home"
						>
							{cFive}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 6 seconds: the fifth stroke draws across the four, and all five turn to ink">
						<Phone
							label="Option C, replay: the fifth stroke crosses the four, and the pencil turns to ink"
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
					note="Once Tally has sorted the last 90 days from your bank, it asks a few plain questions one at a time; each answer is written as a ledger line, and the sitting ends by ruling off your first Safe to spend."
					cost="a question page, a first-budget rule (a spec line) and one kept date for when the sitting ends."
					why="a family answers one small question at a time, and each answer is a line they can read back."
				>
					<Shot caption="Next morning: 14 questions, and Safe to spend written in at the end">
						<Phone
							label="Option D, next morning, with the amount a pencil blank"
							demo={false}
							tab="home"
						>
							{dMorning}
						</Phone>
					</Shot>
					<Shot caption="A question page: the ledger so far, and one question with one tap">
						<Phone
							label="Option D, a question page, the suggested amount in pencil"
							demo={false}
							tab="home"
						>
							{dQuestion}
						</Phone>
					</Shot>
					<Shot caption="A category with no history: a blank amount, and no suggestion">
						<Phone
							label="Option D, a category with no history, a blank amount"
							demo={false}
							tab="home"
						>
							{dNoHistory}
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
				<Choice
					name="Option E · The notebook, one question at a time"
					width="w-full"
					note="C's notebook shows how far along you are, and D's plain questions fill it in: your pay, your bills, then your budgets, all from your own last 90 days."
					cost="a kept record of the five strokes (one household setting), a question page, and a first-budget rule (a spec line); no polling, since the questions are ready the next morning."
					why="every step says what it's for, every number comes from the family's own bank, and the longest part, the budgets, can be one tap."
				>
					<Shot caption="Before a bank: five strokes and you're set up">
						<Phone
							label="Option E, before a bank, five strokes in pencil"
							demo={false}
							tab="home"
						>
							{eBefore}
						</Phone>
					</Shot>
					<Shot caption="That evening: one stroke">
						<Phone
							label="Option E, that evening, one stroke in ink"
							demo={false}
							tab="home"
						>
							{eEvening}
						</Phone>
					</Shot>
					<Shot caption="Next morning: three things to check">
						<Phone
							label="Option E, next morning, three things to check"
							demo={false}
							tab="home"
						>
							{eMorning}
						</Phone>
					</Shot>
					<Shot caption="Your pay: one question">
						<Phone
							label="Option E, your pay, one question"
							demo={false}
							tab="home"
						>
							{ePay}
						</Phone>
					</Shot>
					<Shot caption="Your budgets: keep all, or one at a time">
						<Phone
							label="Option E, your budgets, keep all or one at a time"
							demo={false}
							scrolled
							tab="home"
						>
							{eBudgets}
						</Phone>
					</Shot>
					<Shot caption="One at a time: Groceries">
						<Phone
							label="Option E, one at a time, Groceries"
							demo={false}
							tab="home"
						>
							{eOne}
						</Phone>
					</Shot>
					<Shot caption="Ruled off: four strokes">
						<Phone
							label="Option E, ruled off, four strokes"
							demo={false}
							tab="home"
						>
							{eTotal}
						</Phone>
					</Shot>
					<Shot caption="Thursday: the fifth crosses the four">
						<Phone
							label="Option E, Thursday, five strokes in ink"
							demo={false}
							tab="home"
						>
							{eFive}
						</Phone>
					</Shot>
					<Shot caption="Replay, every 6 seconds: you answer the bills question, its line is written in, and its stroke inks in the notebook.">
						<Phone
							label="Option E, replay: the bills question is answered, its line writes in, and its stroke inks in the notebook"
							demo={false}
							tab="home"
						>
							{eReplay}
						</Phone>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}
