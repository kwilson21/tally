// P89 (spec §7 and §8.6, decisions 64, 68 and 73): Tally fills in a transaction's details. The owner
// asked for AI autofill of the details a person can change, which also feed Tally's categorizing.
// Four details were picked: a clean name, a short "what it was" line (kept as the note), the kind of
// spending, and who it was for. Option A draws them in the edit panel and the list, with the
// first-time setup "who it was for" needs and where autofill is switched off; B and C draw the two
// other places they could live. Each picture is the real components in tokens, plus the prototypes
// the picked drawings left (P42 A's question, P41 B's switch, P72 A's ledger rows), on today's
// date (Mon Oct 5). Nothing here is decided until the owner picks (decision 47).

import type { Child } from "hono/jsx";
import { dayLabel, shortDay } from "../dates";
import { formatCents } from "../money";
import { Button } from "../views/button";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Title } from "./proposal-parts";
import {
	AiGroup,
	Answers,
	type Feature,
	Question,
	ReviewHead,
	SwitchRow,
	Why,
} from "./proposals-ai";
import { SAY_WHAT_IT_DOES, SWITCH_GROUP_LINE } from "./proposals-details";
import {
	Footer,
	LedgerField,
	Row,
	TallSheet,
	transactionsBehind,
} from "./proposals-forms";
import {
	CARD,
	type Cat,
	Categories,
	FOUR,
	LUPITAS,
	TODAY,
	Toggles,
	TRADER_JOES,
} from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

/** A rule the spec still needs before this is built: open, not fixed (as in the other proposal files). */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Rule to write before building: </span>
			{children}
		</p>
	);
}

/** A guess is dashed until a person keeps or changes it (decision 64), as P29 A's list draws it. */
export const DASHED =
	"underline decoration-muted decoration-dashed underline-offset-4";

type From = "bank" | "tally";

/** Where a guess came from, in words (P87 A); a detail a person has kept says nothing. */
const SOURCE: Record<From, string> = {
	bank: "From your bank",
	tally: "Tally's guess",
};

export type Detail = { label: string; value: string; from?: From };

/** What Tally filled in for Blue Bottle Coffee. The bank sent the name; Tally guessed the rest. */
const BLUE_BOTTLE: Detail[] = [
	{ label: "Name", value: "Blue Bottle Coffee", from: "bank" },
	{ label: "What it was", value: "Coffee", from: "tally" },
	{ label: "Kind", value: "One-off", from: "tally" },
	{ label: "For", value: "Dana", from: "tally" },
];

// ---------------------------------------------------------------------------------------------
// Option A and B: the edit panel.

/**
 * One detail as a quiet ledger row (P72 A): its name in muted words, a muted line under it that
 * says where the guess came from, and the guess at the right with a dashed underline, so the state
 * is never the dash alone. A row has no source and no dash once a person has kept or changed it.
 * Tapped, it opens in place to its choices (chips for Kind and For, a field for the others).
 */
export function DetailRow({ label, value, from }: Detail) {
	return (
		<Row
			label={label}
			sub={from && SOURCE[from]}
			value={
				<span class={`truncate text-lg ${from ? DASHED : ""}`}>{value}</span>
			}
		/>
	);
}

/**
 * The panel's top with the name left out: it's a row now, as in P87 A, so the amount is the one
 * big thing. It's Blue Bottle's unless given another store's bank text and amount (P90 B).
 */
export function PanelHead({
	raw = "SQ *BLUE BOTTLE COF 0412",
	cents = 650,
}: {
	raw?: string;
	cents?: number;
}) {
	return (
		<div>
			<p class="text-sm text-muted">{raw}</p>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(cents, { signed: true })}
			</p>
			<p class="text-muted">
				{dayLabel(TODAY, TODAY)} · {CARD}
			</p>
		</div>
	);
}

/**
 * The edit panel with the details under the amount, then today's category chips and toggles (the
 * picture crops what doesn't fit above the pinned Cancel and Save, as P72's forms do). One secondary
 * Looks right keeps every detail still dashed; Save is the sheet's one primary.
 */
export function DetailsPanel({
	id,
	rows,
	head = <PanelHead />,
	maybe,
}: {
	id: string;
	rows: Detail[];
	/** The panel's top, for a purchase that isn't Blue Bottle's. */
	head?: Child;
	/** Tally's category guess, the first chip, dashed (P32 A). */
	maybe?: Cat;
}) {
	return (
		<TallSheet
			behind={transactionsBehind}
			footer={<Footer save="Save" />}
			gap="gap-3"
		>
			{head}
			<div class="border-t border-rule">
				{rows.map((r) => (
					<DetailRow {...r} />
				))}
			</div>
			<div class="flex flex-col items-start">
				<Button kind="secondary" type="button">
					Looks right
					<span class="sr-only">, keep these details</span>
				</Button>
				<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
					Tally uses these when it picks a category.
					<Why topic="Tally's guess" href="#p89-autofill" />
				</p>
			</div>
			<Categories p={id} cats={FOUR} maybe={maybe} />
			<Toggles p={id} />
		</TallSheet>
	);
}

/** A: all four details. */
const panelAll = <DetailsPanel id="p89-a" rows={BLUE_BOTTLE} />;

/** B: only the name and the note. */
const panelTwo = <DetailsPanel id="p89-b" rows={BLUE_BOTTLE.slice(0, 2)} />;

// ---------------------------------------------------------------------------------------------
// Option A: the list row.

/**
 * A row needing a category, as TransactionRow draws it, with the "what it was" line as its caption
 * (the bank's text today). Dashed while it's Tally's guess, plain once a person has kept it.
 */
function GuessRow({
	name,
	line,
	cents,
	guessed,
}: {
	name: string;
	line: string;
	cents: number;
	guessed?: boolean;
}) {
	return (
		<li class="flex h-16 items-center gap-4">
			<span class="shrink-0 text-muted">
				<Icon name="circle-dashed" class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span
					class={`block truncate text-lg leading-6 ${guessed ? DASHED : ""}`}
				>
					{name}
				</span>
				<span class="flex min-w-0 items-center gap-2 leading-6">
					<span class={`truncate text-muted ${guessed ? DASHED : ""}`}>
						{line}
					</span>
					<span class="shrink-0 rounded-control bg-band px-2 text-sm text-ink">
						Needs category
					</span>
				</span>
			</span>
			<span class="shrink-0 text-lg">
				{formatCents(cents, { signed: true })}
			</span>
		</li>
	);
}

/** Two of Tally's guesses, one purchase whose line a person has kept (Chewy), and two with a category. */
const listRows = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">
			Dashed details are Tally's guesses. Tap a row to keep or change them.
		</p>
		<p class="mt-4 text-sm text-muted">5 transactions in October</p>
		<ul class="mt-2 divide-y divide-rule">
			<GuessRow guessed name="Blue Bottle Coffee" line="Coffee" cents={650} />
			<GuessRow guessed name="Stride Rite" line="Kids' shoes" cents={4800} />
			<GuessRow name="Chewy" line="Dog food" cents={6412} />
			<TransactionRow row={TRADER_JOES} />
			<TransactionRow row={LUPITAS} />
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// Options A and C: the first-time setup "who it was for" needs.

const PEOPLE = ["Dana", "Marco"];

/**
 * The household's people, as Settings lists categories: a row each, a chevron to open it, and a
 * terracotta "Add a person" row that opens in place. Everyone is always there. Drawn part-way
 * through the first time: Dana and Marco added, Kids being typed.
 */
const peopleSetup = (
	<>
		<a href="#p89-autofill" class="inline-flex min-h-11 items-center">
			Settings
		</a>
		<Title>People</Title>
		<p class="mt-2 text-muted">
			Tally can say who a purchase was for. Add the people in your household.
			They're only names to pick from, not logins.
		</p>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			{PEOPLE.map((name) => (
				<li class="flex min-h-12 items-center gap-4 py-2">
					<span class="flex-1 text-lg">{name}</span>
					<Icon name="chevron-right" class="size-5" />
				</li>
			))}
			<li class="flex min-h-12 items-center gap-4 py-2">
				<span class="flex-1 text-lg">Everyone</span>
				<span class="text-muted">Always there</span>
			</li>
		</ul>
		<details open class="group border-b border-rule">
			<summary class="flex min-h-12 cursor-pointer list-none items-center gap-4 text-accent [&::-webkit-details-marker]:hidden">
				<Icon name="plus" class="size-5" />
				Add a person
			</summary>
			<div class="flex flex-col gap-3 pb-4">
				<LedgerField id="p89-person" name="person" label="Name" value="Kids" />
				<div class="flex items-center gap-3">
					<Button type="button">Add</Button>
					<Button kind="text" type="button">
						Cancel
					</Button>
				</div>
			</div>
		</details>
	</>
);

// ---------------------------------------------------------------------------------------------
// Option A: where autofill is switched off. P41 B's switches in P86 A's words, with a fifth.

/** The new switch: its own, like every AI feature (decision 68), and the job in the family's words. */
const DETAILS_SWITCH: Feature = {
	id: "details",
	name: "Fill in details",
	line: "Adds a note, the kind of spending and who it was for.",
};

/** P86 A's four switches, with Fill in details after the store names (both write words about a purchase). */
const SWITCHES: Feature[] = SAY_WHAT_IT_DOES.features.flatMap((f) =>
	f.id === "names" ? [f, DETAILS_SWITCH] : [f],
);

/** Fill in details switched off, everything else on to start. */
const switchOff = (
	<AiGroup intro={SWITCH_GROUP_LINE}>
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{SWITCHES.map((f) => (
				<SwitchRow f={f} on={f.id !== "details"} />
			))}
		</ul>
		<div class="mt-4">
			<Button type="button">Save</Button>
		</div>
	</AiGroup>
);

// ---------------------------------------------------------------------------------------------
// Option C: each detail asked on the review screen (P42 A).

const FOR_CHOICES = ["Dana", "Marco", "Kids", "Everyone"];

/** What Something else opens on a "who it was for" question: the people as chips, then Save and next. */
const forChoices = (
	<div class="mt-3 flex flex-col gap-3">
		<fieldset class="flex flex-col gap-2">
			<legend class="sr-only">Who it was for</legend>
			<div class="flex flex-wrap gap-2">
				{FOR_CHOICES.map((p) => (
					<Chip type="radio" name="p89-c-for" value={p}>
						{p}
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

/** C: one of the four questions a purchase brings, "who it was for", as P42 A asks a name or a category. */
const askFor = (
	<>
		<ReviewHead
			place="9 of 31"
			name="Stride Rite"
			bank="STRIDE RITE 0412"
			meta={`${formatCents(4800, { signed: true })} · ${shortDay("2026-10-04", TODAY)}`}
		/>
		<Question
			icon={<Icon name="tag" class="size-7" />}
			line="Who was it for?"
			source={
				<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
					Tally's guess
					<Why topic="Tally's guess" href="#p89-autofill" />
				</p>
			}
		>
			for Kids
		</Question>
		<Answers yes="Yes, Kids" open>
			{forChoices}
		</Answers>
	</>
);

/** P89 on the proposals page, open until the owner picks. */
export function AutofillProposals() {
	return (
		<Specimen
			id="p89-autofill"
			title="P89 · Tally fills in a transaction's details"
			tier="visual"
			sentence="Tally can fill in more than a category: a clean name, a short line about what it was, the kind of spending, and who it was for. A person can change any of it, and what they keep or change helps Tally sort the next one. Pick where the guesses show. Each is drawn on Blue Bottle Coffee, $6.50, today (Oct 5)."
		>
			<Fixed>
				the owner's ask, on decisions 64, 68 and 73: Tally fills in four details
				and a person can change each one. They are a clean name; a short “what
				it was” line, kept as the note; the kind of spending (subscription,
				one-off, bill or transfer); and who it was for (a household member, or
				Everyone). A suggestion shows dashed until a person keeps or changes it,
				and screens call it “Tally's guess”, never the AI service's name
				(decision 64); a name the bank sent says “From your bank” (P87 A). Tally
				is told the note when it sorts, and a person's own choice always wins
				(§7). Each AI feature has its own switch, all on to start, drawn as
				switches with On or Off in words and one Save (decision 73). There is no
				new JavaScript (§8.1).
			</Fixed>
			<NeedsLine>
				“who it was for” needs a people list the spec doesn't have (§3 says one
				shared household with no per-person accounts), so it's a label, not a
				login: who can add and remove names, and what happens to a purchase
				marked for a name that's removed, are open. Which AI fills the details
				is open too: Workers AI through src/ai/suggest-name.ts could write the
				name and the “what it was” line, the kind could be one more question in
				the one Jev call per transaction (decision 18), and who guesses “who it
				was for” isn't decided. Whether the “transfer” and “bill” kinds change
				anything (today only the Exclude toggle and a bill's linked payment do)
				is for the owner to settle.
			</NeedsLine>
			<Options
				options={[
					{
						name: "Option A · Filled in, dashed, in the panel",
						note: "Four quiet ledger rows under the amount (P72 A): Name, What it was, Kind and For, each with its guess dashed and a muted line saying where it came from. One Looks right keeps all four; changing a row makes that row the person's. Name is the merchant's, as in P29 A; the other three are for this purchase only. The rows take the place of today's “Rename or add a note”.",
						tradeoff:
							"the panel is longer, and its category chips sit under the four rows instead of first (the owner's pick C).",
						recommended:
							"the guesses are where you'd check them anyway, and one tap keeps them.",
						screen: panelAll,
					},
					{
						name: "Option A, next · The list row",
						note: "The row stays as it is today. With no category yet its caption is what it was, dashed, beside the same “Needs category” tag; with one, the caption is the category, as today. A name Tally guessed is dashed too, and a detail a person has kept shows plain (Chewy).",
						screen: listRows,
					},
					{
						name: "Option A, next · First-time setup: the people",
						note: "Who it was for needs the household's people, listed under Household in Settings like categories. The first time Tally has a guess for it, a Band on Transactions asks for them; until then the For row says “Add the people in your household”. Drawn part-way: Dana and Marco added, Kids being typed. Everyone is always there.",
						screen: peopleSetup,
					},
					{
						name: "Option A, next · Where it's switched off",
						note: "A fifth switch, “Fill in details”, after the store names, because each AI feature has its own switch (decision 68); the words are P86 A's, still open. Off, Tally guesses none of the three and the panel's rows stay empty for a person to fill in by hand; the Name guesses follow “Suggest store names”, and nothing already kept changes. Folding it under “Guess categories” would make one switch do two jobs.",
						tall: true,
						screen: switchOff,
					},
				]}
			/>
			<Options
				options={[
					{
						name: "Option B · Only the name and the note",
						note: "Two rows, Name and What it was, with the same dashed guesses and one Looks right. Kind and who it was for wait, so there's no people list to build and the panel stays short. The list row is as in A.",
						tradeoff:
							"Tally has less to sort with, and nothing says who a purchase was for.",
						screen: panelTwo,
					},
					{
						name: "Option C · Asked on the review screen",
						note: "Nothing shows in the panel or the list. Each detail waits as a “Maybe …” on the review screen (P42 A), one question at a time; the picture asks who Stride Rite was for, with Something else open on the people.",
						tradeoff:
							"up to four questions for every purchase is a chore, and a wrong detail can't be fixed where you see it.",
						screen: askFor,
					},
				]}
			/>
		</Specimen>
	);
}
