// P41–P44 (spec §8.6, decision 68): AI that earns its place. Four things drawn for the owner to
// pick: the switches in Settings, one review screen for every "Maybe …" suggestion, a tally of what
// AI did this month, and the demo's "See it without AI". Each option is drawn on a phone's first
// screen from the real components with demo-style data (today is Oct 5), so the owner can pick by
// seeing (decision 47). Pieces that don't exist yet (a switch, the question tag) are prototypes,
// in tokens, that live only on this page. Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { shortDay } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { TallyMark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Icon } from "../views/icons";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

const TODAY = "2026-10-05";

const CATS = {
	groceries: { name: "Groceries", icon: "groceries", color: "cat-blue" },
	eatingOut: { name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	gas: { name: "Gas", icon: "gas", color: "cat-slate" },
	kids: { name: "Kids", icon: "kids", color: "cat-ochre" },
	household: { name: "Household", icon: "household", color: "cat-brown" },
	dateNight: { name: "Date Night", icon: "date-night", color: "cat-plum" },
	health: { name: "Health", icon: "health", color: "cat-slate" },
} as const;
type Cat = (typeof CATS)[keyof typeof CATS];

/** A small terracotta "Why?" (P33 A), 44px tall, with its own name for screen readers. */
function Why({ topic, href }: { topic: string; href: string }) {
	return (
		<a
			href={href}
			aria-label={`Why: ${topic}`}
			class="inline-flex min-h-11 items-center text-sm"
		>
			Why?
		</a>
	);
}

/** A rule the spec still needs before this is built: open, not fixed (as in the other proposal files). */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Rule to write before building: </span>
			{children}
		</p>
	);
}

// ---------------------------------------------------------------------------------------------
// P41: the AI suggestions switches in Settings.

type Feature = { id: string; name: string; line: string };

/** The four switches (spec §8.6), each with the one muted line that says what it does. */
const FEATURES: Feature[] = [
	{
		id: "names",
		name: "Merchant names",
		line: "Suggests clean names for bank text.",
	},
	{
		id: "categories",
		name: "Categories and exclusions",
		line: "Picks categories, and leaves out transfers and reimbursements.",
	},
	{
		id: "income",
		name: "Income",
		line: "Spots paychecks and other money coming in.",
	},
	{
		id: "arrival",
		name: "Sort new transactions as they arrive",
		line: "Sorts them right after each sync, not only overnight.",
	},
];

/** The pictures show the last switch turned off, so each option's off look is drawn beside its on look. */
const SOME_OFF = [true, true, true, false];

const OFF_MEANS =
	"Off means your rules and choices only. Nothing already decided changes.";
const ALL_OFF = "Tally sorts by your rules and choices only.";

/**
 * Settings scrolled down to the group: the end of the Categories list (its Add category row), the
 * group, and the top of Your data. The real list has a dozen or more categories, so the group is
 * below the first screen, and drawing it there is what keeps all four switches in the picture.
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

/** The group's heading and its one line, then whatever the option puts under them. */
function AiGroup({ intro, children }: { intro: string; children?: Child }) {
	return (
		<>
			<h2 class="font-serif text-3xl font-semibold">AI suggestions</h2>
			<p class="mt-1 text-muted">{intro}</p>
			{children}
		</>
	);
}

/**
 * A: one switch as a row. It says On or Off in words, and its button says what a tap does. Each row
 * is its own form in the app, so one tap saves and it works without a script.
 */
function ButtonRow({ f, on }: { f: Feature; on: boolean }) {
	return (
		<li class="flex items-center gap-3 py-2">
			<span class="min-w-0 flex-1">
				<span class="block text-lg">{f.name}</span>
				<span class="block text-pretty text-muted">{f.line}</span>
			</span>
			<span class="flex shrink-0 flex-col items-end">
				<span class="font-medium">{on ? "On" : "Off"}</span>
				<Button kind="secondary" type="button" class="px-4">
					{on ? "Turn off" : "Turn on"}
					<span class="sr-only"> {f.name.toLowerCase()}</span>
				</Button>
			</span>
		</li>
	);
}

const buttonRows = (states: boolean[]) => (
	<ul class="mt-3 divide-y divide-rule border-y border-rule">
		{FEATURES.map((f, i) => (
			<ButtonRow f={f} on={states[i] ?? true} />
		))}
	</ul>
);

/** P41 A: the group with a button per row. */
const switchButtons = (
	<SettingsScrolled>
		<AiGroup intro={OFF_MEANS}>{buttonRows(SOME_OFF)}</AiGroup>
	</SettingsScrolled>
);

/**
 * Prototype switch: a real checkbox, hidden but reachable, with a track and knob drawn from it. Ink
 * and the knob on the right when on, a ruled track and the knob on the left when off, and the word
 * beside it says which. The whole 44px-tall row is its label.
 */
function SwitchRow({ f, on }: { f: Feature; on: boolean }) {
	return (
		<li>
			<label class="group flex min-h-11 cursor-pointer items-center gap-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
				<input
					type="checkbox"
					name={`p41b-${f.id}`}
					checked={on}
					class="sr-only"
				/>
				<span class="min-w-0 flex-1">
					<span class="block text-lg">{f.name}</span>
					<span class="block text-pretty text-muted">{f.line}</span>
				</span>
				<span class="w-8 shrink-0 text-right font-medium">
					<span class="hidden group-has-[:checked]:inline">On</span>
					<span class="group-has-[:checked]:hidden">Off</span>
				</span>
				<span class="flex h-7 w-12 shrink-0 items-center rounded-full border border-ink bg-rule px-0.5 group-has-[:checked]:justify-end group-has-[:checked]:bg-ink">
					<span class="size-5 rounded-full bg-ink group-has-[:checked]:bg-paper" />
				</span>
			</label>
		</li>
	);
}

/** P41 B: switches, and one Save under the group. */
const switchesSave = (
	<SettingsScrolled>
		<AiGroup intro={OFF_MEANS}>
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{FEATURES.map((f, i) => (
					<SwitchRow f={f} on={SOME_OFF[i] ?? true} />
				))}
			</ul>
			<div class="mt-4">
				<Button type="button">Save</Button>
			</div>
		</AiGroup>
	</SettingsScrolled>
);

/** P41 C: four toggle chips, each with its muted line, and Save. */
const switchChips = (
	<SettingsScrolled>
		<AiGroup intro={OFF_MEANS}>
			<ul class="mt-3 flex flex-col gap-4">
				{FEATURES.map((f, i) => (
					<li>
						<Chip
							type="checkbox"
							name="p41c"
							value={f.id}
							checked={SOME_OFF[i] ?? true}
							describedBy={`p41c-${f.id}`}
						>
							{f.name}
						</Chip>
						<p id={`p41c-${f.id}`} class="mt-1 text-pretty text-muted">
							{f.line}
						</p>
					</li>
				))}
			</ul>
			<div class="mt-4">
				<Button type="button">Save</Button>
			</div>
		</AiGroup>
	</SettingsScrolled>
);

/** Both: every switch off, drawn with A's rows; the sentence is the same in B and C. */
const switchesAllOff = (
	<SettingsScrolled>
		<AiGroup intro={ALL_OFF}>
			{buttonRows([false, false, false, false])}
		</AiGroup>
	</SettingsScrolled>
);

// ---------------------------------------------------------------------------------------------
// P42: one review screen for every "Maybe …".

function Back() {
	return (
		<a href="#p42-review" class="inline-flex min-h-11 items-center">
			Settings
		</a>
	);
}

/** The top of one review item: where you are, then what's being asked about, like Organize's group. */
function ReviewHead({
	place,
	name,
	bank,
	meta,
}: {
	place: string;
	name: string;
	bank?: string;
	meta?: string;
}) {
	return (
		<>
			<Back />
			<h1 class="sr-only">Suggestions</h1>
			<p class="text-muted">Suggestions · {place}</p>
			<h2 class="mt-2 font-serif text-3xl font-semibold tracking-tight">
				{name}
			</h2>
			{bank && <p class="text-sm text-muted">{bank}</p>}
			{meta && <p class="mt-1 text-lg">{meta}</p>}
		</>
	);
}

/**
 * The suggestion as the one question: P32's dashed "Maybe …" tag at question size, in sans (the
 * screen's one serif headline is the name above it), with how sure Tally was when it can say.
 */
function Question({
	icon,
	children,
	line,
	sure,
}: {
	icon: Child;
	children?: Child;
	line?: string;
	sure?: number;
}) {
	return (
		<div class="mt-5 border-t border-rule pt-5">
			<p>
				<span class="inline-flex items-center gap-2 rounded-control border border-dashed border-ink px-3 py-1 text-2xl">
					{icon}
					Maybe {children}
				</span>
			</p>
			{line && <p class="mt-2 text-lg">{line}</p>}
			{sure !== undefined && (
				<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
					Tally's guess · {sure}% sure
					<Why topic="Tally's guess" href="#p42-review" />
				</p>
			)}
		</div>
	);
}

/**
 * "Something else" as a no-script disclosure that looks like a secondary button, and opens in
 * place to the choices (a button can't open anything without a script).
 */
function SomethingElse({
	open,
	children,
}: {
	open?: boolean;
	children?: Child;
}) {
	return (
		<details open={open}>
			<summary class="flex min-h-11 w-full cursor-pointer list-none items-center justify-center rounded-control border border-ink px-5 text-ink [&::-webkit-details-marker]:hidden">
				Something else
			</summary>
			{children}
		</details>
	);
}

/** A's answers: the primary yes, a secondary no (or Something else), and Skip, each 44px. */
function Answers({
	yes,
	no,
	open,
	children,
}: {
	yes: string;
	no?: string;
	open?: boolean;
	children?: Child;
}) {
	return (
		<div class="mt-5 flex flex-col gap-3">
			<Button type="button" class="w-full">
				{yes}
			</Button>
			{no ? (
				<Button kind="secondary" type="button" class="w-full">
					{no}
				</Button>
			) : (
				<SomethingElse open={open}>{children}</SomethingElse>
			)}
			<div class="text-center">
				<Button kind="text" type="button">
					Skip
				</Button>
			</div>
		</div>
	);
}

/** The other categories, as Organize draws them, for B and for what Something else opens. */
const OTHER_CATS: Cat[] = [
	CATS.groceries,
	CATS.gas,
	CATS.kids,
	CATS.household,
	CATS.dateNight,
	CATS.health,
];

/**
 * What "Something else" opens on a category guess: the other categories as chips, then Save and
 * next. Four are drawn so the picture fits a phone's first screen; the real list shows them all.
 */
function ElseCategories({ id }: { id: string }) {
	return (
		<div class="mt-3 flex flex-col gap-3">
			<fieldset class="flex flex-col gap-2">
				<legend class="sr-only">Other categories</legend>
				<div class="flex flex-wrap gap-2">
					{OTHER_CATS.slice(0, 4).map((c) => (
						<Chip
							type="radio"
							name={id}
							value={c.name}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{c.name}
						</Chip>
					))}
				</div>
			</fieldset>
			<div>
				<Button kind="secondary" type="button">
					Save and next
				</Button>
			</div>
		</div>
	);
}

const lupitaHead = (
	<ReviewHead
		place="3 of 14"
		name="Lupita's Taqueria"
		bank="TST* LUPITAS TAQ"
		meta={`${formatCents(2240, { signed: true })} · ${shortDay("2026-10-04", TODAY)}`}
	/>
);

const eatingOutQuestion = (
	<Question
		icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
		sure={64}
	>
		Eating Out
	</Question>
);

/** P42 A: a category guess as a yes-or-no question. */
const askCategory = (
	<>
		{lupitaHead}
		{eatingOutQuestion}
		<Answers yes="Yes, Eating Out">
			<ElseCategories id="p42-a" />
		</Answers>
	</>
);

/** Both: the same question after Something else, when the guess was wrong. */
const askWrongGuess = (
	<>
		{lupitaHead}
		{eatingOutQuestion}
		<Answers yes="Yes, Eating Out" open>
			<ElseCategories id="p42-a-open" />
		</Answers>
	</>
);

/** P42 B: every category as a chip, the guess first, dashed and marked Suggested; Save and next. */
const askChips = (
	<>
		{lupitaHead}
		<fieldset class="mt-5 flex flex-col gap-2">
			<legend class="text-base text-ink">Category</legend>
			<div class="flex flex-wrap gap-2">
				<span class="rounded-full border border-dashed border-ink">
					<Chip
						type="radio"
						name="p42-b"
						value="eating-out"
						icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
					>
						Eating Out · Suggested
					</Chip>
				</span>
				{OTHER_CATS.map((c) => (
					<Chip
						type="radio"
						name="p42-b"
						value={c.name}
						icon={<CategoryIcon icon={c.icon} color={c.color} />}
					>
						{c.name}
					</Chip>
				))}
			</div>
			<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
				Tally's guess · 64% sure
				<Why topic="Tally's guess" href="#p42-review" />
			</p>
		</fieldset>
		<div class="mt-4 flex items-center gap-3">
			<Button type="button">Save and next</Button>
			<Button kind="text" type="button">
				Skip
			</Button>
		</div>
	</>
);

/** Both: a merchant name, with P29's choices opened by Something else. */
const askName = (
	<>
		<ReviewHead
			place="4 of 14"
			name="Blue bottle cof"
			bank="SQ *BLUE BOTTLE COF 0412"
			meta="9 transactions · $58.50"
		/>
		<Question icon={<Icon name="tag" class="size-7" />}>
			Blue Bottle Coffee
		</Question>
		<Answers yes="Yes, Blue Bottle Coffee" open>
			<div class="mt-3 flex flex-col gap-3">
				<fieldset class="flex flex-col gap-2">
					<legend class="sr-only">Other names</legend>
					<div class="flex flex-wrap gap-2">
						<Chip type="radio" name="p42-name" value="2">
							Blue Bottle
						</Chip>
						<Chip type="radio" name="p42-name" value="3">
							Blue Bottle Cafe
						</Chip>
						<Chip type="radio" name="p42-name" value="tidied">
							Keep “Blue bottle cof”
						</Chip>
					</div>
				</fieldset>
				<TextInput id="p42-own" label="Or your own" surface="paper" />
				<div>
					<Button kind="secondary" type="button">
						Save and next
					</Button>
				</div>
			</div>
		</Answers>
	</>
);

/** Both: money in that looks like pay, answered Yes or No. */
const askIncome = (
	<>
		<ReviewHead
			place="5 of 14"
			name="Acme Payroll"
			bank="ACME PAYROLL PPD"
			meta={`${formatCents(-245000, { signed: true })} · ${shortDay("2026-10-03", TODAY)}`}
		/>
		<Question
			icon={<Icon name="income" class="size-7" />}
			line="Count it as income, not spending?"
			sure={71}
		>
			a paycheck
		</Question>
		<Answers yes="Yes, it's income" no="No" />
	</>
);

/** Both: a card payment that looks like a transfer, answered Yes or No. */
const askTransfer = (
	<>
		<ReviewHead
			place="6 of 14"
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

/** Both: a new category with its transactions ticked, as P30 A has them. */
const askNewCategory = (
	<>
		<ReviewHead
			place="7 of 14"
			name="3 transactions"
			meta={`${formatCents(PET_ROWS.reduce((sum, r) => sum + r.amountCents, 0))} · No category fits them.`}
		/>
		<ul class="mt-2 divide-y divide-rule border-y border-rule">
			{PET_ROWS.map((r) => (
				<SelectableTransactionRow row={r} checked />
			))}
		</ul>
		<p class="mt-1 text-sm text-muted">Untick any that don't belong.</p>
		<Question icon={<Icon name="tag" class="size-7" />}>new: Pet Care</Question>
		<Answers yes="Yes, create Pet Care" no="No" />
	</>
);

/** Both: when every suggestion is answered. */
const reviewDone = (
	<>
		<Back />
		<Title>Suggestions</Title>
		<EmptyState
			kind="done"
			sentence="Nothing left to check."
			hint="New suggestions show up as transactions arrive."
		/>
	</>
);

/** Both: how the screen is found, P29's Band on Settings with its new count. */
const reviewBand = (
	<>
		<Title>Settings</Title>
		<div class="mt-4">
			<Band href="#p42-review" detail="Tally's guesses; you decide">
				14 suggestions to check
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

// ---------------------------------------------------------------------------------------------
// P43: what AI did this month (October's example: sorted 84, cleaned 12, found 2, you changed 5).

/**
 * A: "In October", under the switches, as three short lines and a Why?. Settings is scrolled down
 * to the group, as in P41.
 */
const tallyUnderSwitches = (
	<section>
		<AiGroup intro={OFF_MEANS}>{buttonRows([true, true, true, true])}</AiGroup>
		<h3 class="mt-5 text-sm text-muted">In October</h3>
		<ul class="mt-1">
			<li>Sorted 84 transactions · you changed 5</li>
			<li>Cleaned 12 merchant names</li>
			<li>Found 2 paychecks</li>
		</ul>
		<Why topic="what Tally did" href="#p43-did" />
	</section>
);

/** B: Trends, shortened, ending in one quiet sentence. */
const tallyOnTrends = (
	<>
		<Title>Trends</Title>
		<p class="mt-4 text-lg text-muted">Spent so far in October</p>
		<p class="font-serif text-6xl font-semibold tracking-tight">$1,240</p>
		<p class="mt-1 font-serif text-lg italic">
			$90 less than by this time in September.
		</p>
		<p class="mt-5 text-sm text-muted">Every category, May to October</p>
		<ul class="divide-y divide-rule border-y border-rule">
			{[
				[CATS.groceries, "$860 in September"],
				[CATS.eatingOut, "$365 in September"],
				[CATS.kids, "$255 in September"],
			].map(([c, line]) => (
				<li class="flex h-16 items-center gap-4">
					<CategoryIcon icon={(c as Cat).icon} color={(c as Cat).color} />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-lg leading-6">
							{(c as Cat).name}
						</span>
						<span class="block leading-6 text-muted">{line as string}</span>
					</span>
				</li>
			))}
		</ul>
		<p class="mt-5 flex flex-wrap items-center gap-x-2 border-t border-rule pt-3 text-muted">
			In October Tally sorted 84 transactions and you changed 5.
			<Why topic="what Tally did" href="#p43-did" />
		</p>
	</>
);

/** One to four strokes of a tally, drawn like TallyMark's, for the count left over after the fives. */
function Strokes({ n }: { n: number }) {
	return (
		<svg
			viewBox={`0 0 ${5 * n + 5} 28`}
			class="h-6"
			fill="none"
			stroke="currentColor"
			stroke-width="2.25"
			stroke-linecap="round"
			aria-hidden="true"
		>
			{[6, 11, 16, 21].slice(0, n).map((x) => (
				<line x1={x} y1="5" x2={x} y2="23" />
			))}
		</svg>
	);
}

/** A count drawn as tally marks: a full TallyMark for every five, then the strokes left over. */
function Marks({ n }: { n: number }) {
	const rest = n % 5;
	return (
		<span class="mt-1 flex flex-wrap items-center gap-1 text-ink">
			{Array.from({ length: Math.floor(n / 5) }, () => (
				<TallyMark class="size-6" />
			))}
			{rest > 0 && <Strokes n={rest} />}
		</span>
	);
}

/** C: its own page from More, each count drawn in groups of five. */
const tallyMarksPage = (
	<>
		<a href="#p43-did" class="inline-flex min-h-11 items-center">
			More
		</a>
		<Title>What Tally did</Title>
		<p class="mt-2 text-muted">In October. Each mark is five.</p>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{[
				["Sorted 84 transactions", 84],
				["Cleaned 12 merchant names", 12],
				["Found 2 paychecks", 2],
				["You changed 5 of Tally's choices", 5],
			].map(([label, n]) => (
				<li class="py-3">
					<p class="text-lg">{label as string}</p>
					<Marks n={n as number} />
				</li>
			))}
		</ul>
		<Why topic="what Tally did" href="#p43-did" />
	</>
);

// ---------------------------------------------------------------------------------------------
// P44: the demo's "See it without AI".

type Story = {
	id: number;
	date: string;
	name: string;
	bank: string;
	cents: number;
	cat?: Cat;
	income?: boolean;
	excluded?: boolean;
};

/** Six October transactions, each as Tally made it and as the bank sends it. */
const STORY: Story[] = [
	{
		id: 1,
		date: "2026-10-04",
		name: "Lupita's Taqueria",
		bank: "TST* LUPITAS TAQ",
		cents: 2240,
		cat: CATS.eatingOut,
	},
	{
		id: 2,
		date: "2026-10-03",
		name: "Acme Payroll",
		bank: "ACME PAYROLL PPD",
		cents: -245000,
		income: true,
	},
	{
		id: 3,
		date: "2026-10-03",
		name: "Blue Bottle Coffee",
		bank: "SQ *BLUE BOTTLE COF 0412",
		cents: 650,
		cat: CATS.eatingOut,
	},
	{
		id: 4,
		date: "2026-10-02",
		name: "Chase card payment",
		bank: "CHASE CREDIT CRD AUTOPAY",
		cents: 81240,
		excluded: true,
	},
	{
		id: 5,
		date: "2026-10-01",
		name: "Amazon",
		bank: "AMZN MKTP US*2K4",
		cents: 3418,
		cat: CATS.household,
	},
	{
		id: 6,
		date: "2026-10-01",
		name: "Trader Joe's",
		bank: "TRADER JOE S #552",
		cents: 6412,
		cat: CATS.groceries,
	},
];

/** A row as Tally made it: a clean name, a category, the paycheck as income, the card payment excluded. */
const madeRow = (s: Story): ListRow => ({
	id: s.id,
	date: s.date,
	amountCents: s.cents,
	rawName: s.bank,
	displayName: s.name,
	note: null,
	excluded: Boolean(s.excluded),
	income: Boolean(s.income),
	categoryId: s.cat ? s.id : null,
	categoryName: s.cat?.name ?? null,
	categoryIcon: s.cat?.icon ?? null,
	categoryColor: s.cat?.color ?? null,
});

/** The same row as the bank sends it: its own text, no category, and nothing left out of spending. */
const bankRow = (s: Story): ListRow => ({
	...madeRow(s),
	displayName: s.bank,
	excluded: false,
	income: false,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
});

const list = (rows: ListRow[]) => (
	<ul class="divide-y divide-rule">
		{rows.map((r) => (
			<TransactionRow row={r} />
		))}
	</ul>
);

const MADE = list(STORY.map(madeRow));
const BANK = list(STORY.map(bankRow));

const WITHOUT_LINE =
	"No clean names or categories, and the card payment and the paycheck both count in Spent.";

/** A's two links under the title: the current one in ink, the other a terracotta link, each 44px. */
function ViewLinks({ current }: { current: "made" | "bank" }) {
	const link = "inline-flex min-h-11 items-center";
	const here = `${link} font-semibold text-ink no-underline`;
	return (
		<nav aria-label="View" class="flex flex-wrap items-center gap-x-2">
			<a
				href="#p44-without"
				aria-current={current === "made" ? "page" : undefined}
				class={current === "made" ? here : link}
			>
				What Tally made of it
			</a>
			<span aria-hidden="true" class="text-muted">
				·
			</span>
			<a
				href="#p44-without"
				aria-current={current === "bank" ? "page" : undefined}
				class={current === "bank" ? here : link}
			>
				As the bank sends it
			</a>
		</nav>
	);
}

/** P44 A: the normal list, with the two links. */
const viewLinksMade = (
	<>
		<Title>Transactions</Title>
		<ViewLinks current="made" />
		<p class="mt-2 text-sm text-muted">6 transactions in October</p>
		{MADE}
	</>
);

/** P44 A: the same list as the bank sends it (?raw=1). */
const viewLinksBank = (
	<>
		<Title>Transactions</Title>
		<ViewLinks current="bank" />
		<p class="mt-2 text-sm text-muted">
			6 transactions in October, as the bank sends them
		</p>
		<p class="mt-1 text-muted">{WITHOUT_LINE}</p>
		{BANK}
	</>
);

/** P44 B: a checkbox chip above the list, ticked: the list as the bank sends it. */
const viewChip = (
	<>
		<Title>Transactions</Title>
		<div class="mt-3">
			<Chip type="checkbox" name="p44-b" value="1" checked>
				See it without AI
			</Chip>
		</div>
		<p class="mt-3 text-sm text-muted">
			6 transactions in October, as the bank sends them
		</p>
		<p class="mt-1 text-muted">{WITHOUT_LINE}</p>
		{BANK}
	</>
);

/**
 * P44 C: two columns, the bank's on the left and Tally's on the right, each row beside its twin.
 * DesktopFrame's column is 512px wide; the negative margin lets the pair use the whole window, as
 * the app's main area would.
 */
const viewSideBySide = (
	<div class="-mx-[105px] px-6">
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">
			6 transactions in October, the bank's and Tally's side by side
		</p>
		<div class="mt-4 grid grid-cols-2 gap-6">
			<section>
				<h2 class="text-sm text-muted">As the bank sends it</h2>
				{BANK}
			</section>
			<section>
				<h2 class="text-sm text-muted">What Tally made of it</h2>
				{MADE}
			</section>
		</div>
	</div>
);

/** P41–P44 on the proposals page, open until the owner picks (decision 68). */
export function AiProposals() {
	return (
		<>
			<Specimen
				id="p41-ai-switches"
				title="P41 · The AI suggestions switches in Settings"
				tier="visual"
				sentence="Settings gets an AI suggestions group, after Categories and before Your data, with one switch per feature. Pick how a switch looks and saves; each picture is Settings scrolled down to the group, with the last switch turned off."
			>
				<Fixed>
					four switches: merchant names; categories and exclusions; income; and
					sorting new transactions as they arrive. All are on to start. Off
					means Tally works from rules and people's choices alone, and nothing
					already decided changes; every run, nightly and at sync alike, honors
					them (§8.6, decision 68). There is no new JavaScript (§8.1), so each
					switch has to work without it.
				</Fixed>
				<NeedsLine>
					what “Sort new transactions as they arrive” does, and says, when
					categories and exclusions and income are both off (nothing is left to
					sort); and whether turning a switch back on goes over what was skipped
					while it was off.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A button per row",
							note: "Each row says On or Off in words and has a Turn off (or Turn on) button; each row is its own form.",
							tradeoff: "four outline buttons repeat down the screen.",
							recommended:
								"one tap saves with no script, and the state is a word, never color alone.",
							screen: switchButtons,
						},
						{
							name: "Option B · Switches and Save",
							note: "Switch-shaped toggles made from real checkboxes, ink when on, with On or Off beside each and one Save under the group.",
							tradeoff:
								"a switch that waits for Save is unusual, and it's a new component.",
							screen: switchesSave,
						},
						{
							name: "Option C · Toggle chips",
							note: "Four checkbox chips under the heading, each followed by its muted line, and Save.",
							tradeoff: "chips read like categories (audit E2).",
							screen: switchChips,
						},
						{
							name: "Both · All off",
							note: "With every switch off, the group says so in one sentence (drawn with A; B and C say the same).",
							screen: switchesAllOff,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p42-review"
				title="P42 · One review screen for every “Maybe …”"
				tier="visual"
				sentence="Names, categories, new categories, income and transfers all wait as the same dashed “Maybe …”, and one screen reviews them one at a time, like Organize. Pick how a question is asked."
			>
				<Fixed>
					name, category, new-category, income and transfer suggestions all show
					as the same dashed “Maybe …” and are reviewed on one screen, one item
					at a time, like Organize (§8.6). A name review is reached from a Band
					on Settings (§7); the Band here is drawn for every kind. A “Maybe” is
					never applied without a tap (decision 64), and no screen names the AI
					service (§7).
				</Fixed>
				<NeedsLine>
					whether No is remembered so Tally doesn't ask again; whether Skip
					keeps a suggestion in the Band's count; and the order the kinds come
					in (mixed, or one kind at a time).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A yes-or-no question",
							note: "The guess is the one question, as a dashed “Maybe …”; Yes is the primary, Something else opens the choices in place, and Skip leaves it for later.",
							tradeoff:
								"a wrong guess takes three taps to fix (Something else, a category, Save and next).",
							recommended:
								"one decision per screen, and saying yes is one tap.",
							screen: askCategory,
						},
						{
							name: "Option B · Chips with the guess first",
							note: "Like Organize: every category as a chip, the guess first, dashed and marked Suggested, then Save and next or Skip.",
							tradeoff:
								"two taps even when the guess is right, and a bigger question each time.",
							screen: askChips,
						},
						{
							name: "Both · A wrong guess",
							note: "A after Something else: the other categories open in place (four drawn; the real list shows them all), then Save and next.",
							screen: askWrongGuess,
						},
						{
							name: "Both · A name",
							note: "A's form for a merchant name; Something else opens P29's choices: other names, the bank's, or your own.",
							screen: askName,
						},
						{
							name: "Both · Income",
							note: "A's form for money in that looks like pay; No keeps it as it is.",
							screen: askIncome,
						},
						{
							name: "Both · A transfer",
							note: "A's form for a card payment that looks like a transfer; No keeps it in the budget.",
							screen: askTransfer,
						},
						{
							name: "Both · A new category",
							note: "A's form for Pet Care with its transactions ticked, as in P30 A; No dismisses it.",
							screen: askNewCategory,
						},
						{
							name: "Both · Nothing left",
							note: "When every suggestion is answered.",
							screen: reviewDone,
						},
						{
							name: "Both · The Band on Settings",
							note: "How the screen is found: P29's Band, with the count of every kind.",
							screen: reviewBand,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p43-did"
				title="P43 · What AI did this month"
				tier="visual"
				sentence="A short, honest tally of what Tally did with AI in October, so the family can see it instead of taking it on trust. Pick where it shows."
			>
				<Fixed>
					how many transactions Tally sorted, names it cleaned and paychecks it
					found, and how many a person changed (§8.6). Code does the counting
					(§2). The numbers drawn are an example October.
				</Fixed>
				<NeedsLine>
					what counts as sorted (a category Tally picked, not a merchant
					rule's), cleaned (a suggested name a person kept) and changed
					(something Tally set that a person then changed: only categories, or
					names and paychecks too); which month shows early in a new one; and
					what a switched-off feature's line says.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Under the switches",
							note: "A muted “In October” in the AI suggestions group, three short lines and a Why? to How Tally works.",
							tradeoff: "it's far down Settings, below the categories.",
							recommended:
								"it sits beside the switches, where someone decides whether to keep AI on.",
							screen: tallyUnderSwitches,
						},
						{
							name: "Option B · A sentence on Trends",
							note: "One quiet sentence at the end of Trends (shortened here to its last rows).",
							tradeoff:
								"it's easy to miss at the end of a long page, and far from the switches.",
							screen: tallyOnTrends,
						},
						{
							name: "Option C · Its own page, with tally marks",
							note: "A page from More: each count drawn as TallyMark groups of five.",
							tradeoff:
								"on-brand and easy to take in, but a whole page and a new row in More for four numbers.",
							screen: tallyMarksPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p44-without"
				title="P44 · See it without AI"
				tier="visual"
				sentence="In the demo, a visitor can see the same Transactions list as the bank sends it, next to what Tally made of it. Without AI means the bank's own names, no categories (Needs category), and a card payment and a paycheck counted in Spent; the pictures show that state. Pick how they switch."
			>
				<Fixed>
					in the demo only, a toggle shows the same Transactions list as the
					bank sends it, next to what Tally made of it (§8.6), with no new
					JavaScript (§8.1).
				</Fixed>
				<NeedsLine>
					exactly what the without view takes away: Tally's AI names, categories
					and flags go, but a transfer or paycheck that Plaid itself marks
					(§8.5) isn't the AI's, so whether it still shows is a choice; and
					whether only this list changes, or Home's numbers too.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Two links under the title",
							note: "“What Tally made of it · As the bank sends it”: two 44px links, the current one in ink; the list swaps on a page with ?raw=1.",
							tradeoff: "two more links under the title.",
							recommended:
								"plain words, and it's a link, so it needs no script.",
							screen: viewLinksMade,
						},
						{
							name: "Option A · Without AI",
							note: "The same page with “As the bank sends it” chosen, and one line saying what's missing.",
							screen: viewLinksBank,
						},
						{
							name: "Option B · A toggle chip",
							note: "One checkbox chip, “See it without AI”, above the list (drawn ticked).",
							tradeoff:
								"without a script a checkbox needs an Apply button, and a chip looks like a filter.",
							screen: viewChip,
						},
						{
							name: "Option C · Side by side on desktop",
							note: "Two columns, the bank's on the left and Tally's on the right, each row beside its twin; on a phone it falls back to A.",
							tradeoff:
								"the clearest comparison, but only where there's room, and a second layout to build.",
							desktop: true,
							screen: viewSideBySide,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
