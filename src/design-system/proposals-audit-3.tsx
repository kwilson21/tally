// P134 (#606) and P135 (#607): the owner's picks from the second design-language audit (#507), each option drawn
// as the screens it changes, so the owner decides by seeing (decision 47). Proposal only: nothing in the app
// changes. Every picture is inert and labelled, like the rest of the page. Where the app's own components draw
// the same at a phone's size they are used as they are (Band, ContentsList, CategoryRow, CategoryIcon, Switch,
// Chip, NewCategoryChip, Button, WhyLink, Icon, SuggestionCard, CategorySuggestionCard); the screens an option
// changes are prototypes in tokens, and their captions say so. The sample data is the demo's (src/demo/reset.ts
// and seed.ts): seven categories with $3,940 a month, one person (Everyone), Eastern time, and the Pet Care
// suggestion for Chewy, Petsmart and Banfield Pet Hospital, in August.

import type { Child } from "hono/jsx";
import type { PendingSuggestion } from "../db/category-suggestions";
import type { SuggestionItem } from "../db/suggestions-queue";
import { formatCents } from "../money";
import { AiTally } from "../views/ai-tally";
import { Band } from "../views/band";
import { BankSignInEmails } from "../views/bank-sign-in-emails";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { CategoryRow } from "../views/category-row";
import { CategorySuggestionCard } from "../views/category-suggestion-card";
import { Chip } from "../views/chip";
import { ContentsList, type Place } from "../views/contents-list";
import { FeedbackButton } from "../views/feedback-button";
import { Icon } from "../views/icons";
import { NewCategoryChip } from "../views/new-category-choice";
import { SuggestionCard } from "../views/suggestion-review";
import { Switch } from "../views/switch";
import { TextInput } from "../views/text-input";
import { WhyLink } from "../views/why-link";
import { Fixed } from "./proposal-parts";
import { tx } from "./proposals-phase5-transactions";
import { Choice, Choices, Desk, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// Sample data: the demo's, in its own words. Amounts are integer cents.

const TODAY = "2026-10-15";
const dollars = (cents: number) => formatCents(cents, { wholeDollars: true });
const exact = (cents: number) => formatCents(cents);

/** The demo's seven categories with this month's budgets (seed.ts), in Settings' order: $3,940 in all. */
const CATEGORIES = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		budgetCents: 25000,
	},
	{ name: "Gas", icon: "gas", color: "cat-slate", budgetCents: 20000 },
	{ name: "Kids", icon: "kids", color: "cat-ochre", budgetCents: 30000 },
	{
		name: "Household",
		icon: "household",
		color: "cat-brown",
		budgetCents: 25000,
	},
	{ name: "Childcare", icon: "kids", color: "cat-blue", budgetCents: 104000 },
	{ name: "Rent", icon: "household", color: "cat-ochre", budgetCents: 120000 },
];

/** The categories a suggestion can be filed under, as the Suggestions page lists them. */
const CATEGORY_CHOICES = CATEGORIES.map((c, i) => ({
	id: 9101 + i,
	name: c.name,
}));

/**
 * The five AI switches, in Settings' order, with the label and hint the app gives each (a copy of settings.tsx's
 * AI_FEATURES, which this file does not import). Every switch keeps its hint (decision 120).
 */
const AI_SWITCHES = [
	{
		label: "Suggest store names",
		hint: "Turns bank text like SQ *BLUE BOTTLE COF into Blue Bottle Coffee. You pick the name.",
	},
	{
		label: "Fill in details",
		hint: "Adds a note, the kind of spending and who it was for.",
	},
	{
		label: "Categories and exclusions",
		hint: "Picks categories, and leaves out transfers and reimbursements.",
	},
	{ label: "Income", hint: "Spots paychecks and other money coming in." },
	{
		label: "Sort new transactions as they arrive",
		hint: "Sorts them right after each sync, not only overnight.",
	},
];

/** The people the bank sign-in emails go to, as catalog.tsx's sample has them (the demo has no household members). */
const RECIPIENTS = ["alex@example.com", "sam@example.com", "jo@example.com"];

/** The round initials' backgrounds, by list position, as bank-sign-in-emails.tsx draws them (INITIAL_LOOKS). */
const INITIAL_LOOKS = ["bg-accent", "bg-ok", "bg-muted"];

/** Settings' sections as More lists them: each one's icon, what it holds and its live count (P122 A). */
const PLACES: Place[] = [
	{
		name: "Categories",
		href: "/settings/categories",
		icon: "tag",
		desc: "What you track, and each budget",
		folio: { text: "7 categories · $3,940 a month", tone: "muted" },
	},
	{
		name: "Tally's rules",
		href: "/settings/rules",
		icon: "check",
		desc: "Always and never, for merchants",
		folio: { text: "3 merchants", tone: "muted" },
	},
	{
		name: "Household",
		href: "/settings/household",
		icon: "household",
		desc: "Time zone and bank sign-in emails",
		folio: { text: "Eastern · sign-in emails on", tone: "muted" },
	},
	{
		name: "People",
		href: "/settings/people",
		icon: "kids",
		desc: "Who's in the household",
		folio: { text: "Everyone", tone: "muted" },
	},
	{
		name: "AI suggestions",
		href: "/settings/ai",
		icon: "sparkles",
		desc: "The five switches, and what Tally sorted",
		folio: { text: "All on · 23 sorted in October", tone: "muted" },
	},
	{
		name: "Your data",
		href: "/settings/data",
		icon: "documents",
		desc: "Download everything Tally stores",
		folio: { text: "Download", tone: "muted" },
	},
];

/** Tally's rules as Settings lists them, A to Z: the demo's three subscriptions, each with its two charges (seed.ts). */
const RULES = [
	{
		name: "City Gym",
		category: "Household",
		count: "2 transactions",
		icon: "household",
		color: "cat-brown",
	},
	{
		name: "Procreate Dreams",
		category: "Household",
		count: "2 transactions",
		icon: "household",
		color: "cat-brown",
	},
	{
		name: "YouTube Premium",
		category: "Household",
		count: "2 transactions",
		icon: "household",
		color: "cat-brown",
	},
];

/** Settings' own links under the title, in the order B's line gives them. */
const TIDY_LINKS = [
	"Categories",
	"Rules",
	"Household",
	"People",
	"AI",
	"Your data",
];

/** Pet Care's three transactions (reset.ts) newest first, as the demo's Settings card lists them: Banfield, Petsmart and Chewy, in August. */
const PET_ROWS = [
	tx(7103, "2026-08-21", "BANFIELD PET HOSPITAL", 18900, undefined, {
		displayName: "Banfield Pet Hospital",
	}),
	tx(7102, "2026-08-14", "PETSMART 0412", 2399, undefined, {
		displayName: "Petsmart",
	}),
	tx(7101, "2026-08-08", "CHEWY.COM", 6412, undefined, {
		displayName: "Chewy",
	}),
];

/** The Settings card's suggestion, as the card reads it. */
const PET_SUGGESTION: PendingSuggestion = {
	id: 7001,
	name: "Pet Care",
	rows: PET_ROWS,
};

/** The Suggestions page's question for the same suggestion, as the page reads it. */
const PET_ITEM: Extract<SuggestionItem, { kind: "new_category" }> = {
	kind: "new_category",
	id: "new-7001",
	suggestionId: 7001,
	name: "Pet Care",
	existing: null,
	archived: false,
	date: "2026-08-21",
	rows: [
		{
			transactionId: 7103,
			date: "2026-08-21",
			amountCents: 18900,
			merchantKey: "banfield pet hospital",
			merchant: "Banfield Pet Hospital",
			label: "Banfield Pet Hospital",
		},
		{
			transactionId: 7102,
			date: "2026-08-14",
			amountCents: 2399,
			merchantKey: "petsmart",
			merchant: "Petsmart",
			label: "Petsmart",
		},
		{
			transactionId: 7101,
			date: "2026-08-08",
			amountCents: 6412,
			merchantKey: "chewy",
			merchant: "Chewy",
			label: "Chewy",
		},
	],
	stores: [
		{ merchantKey: "chewy", merchant: "Chewy" },
		{ merchantKey: "petsmart", merchant: "Petsmart" },
		{ merchantKey: "banfield pet hospital", merchant: "Banfield Pet Hospital" },
	],
};

/** A day as the rows write it: "Aug 8". */
const day = (iso: string) => `Aug ${Number(iso.slice(8, 10))}`;

// ---------------------------------------------------------------------------------------------
// Shared pieces: the feedback pill in the masthead, the toast as #toasts draws it, the card that
// every suggestion uses in P135 A, and Settings' own heading and rows.

const PILL = <FeedbackButton />;

/** A toast as #toasts draws it: the same words and border, flat (a copy of polish-2's Toast). */
function Toast({ children }: { children?: Child }) {
	return (
		<p
			role="status"
			class="rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink"
		>
			{children}
		</p>
	);
}

/** Where a toast sits over a phone: 12 px above the tab bar, as the app places it. */
const TOAST_AT = "absolute inset-x-4 bottom-[4.25rem] flex justify-center";

/** P135 A's one card, drawn the same in Settings, on the Suggestions page and above Organize's chips. */
const CARD =
	"flex flex-col gap-3 rounded-control border border-rule bg-paper p-4";

/** Settings' title and its one Band, as main draws them. */
function SettingsHead() {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">Settings</h1>
			<div class="mt-4">
				<Band href="/settings/suggestions" detail="Tally's guesses; you decide">
					5 suggestions to check
				</Band>
			</div>
		</>
	);
}

/** A subpage's back link to Settings and its title, as Settings' own pages draw them (Household, Rules, Categories). */
function SubpageHead({ title }: { title: string }) {
	return (
		<>
			<a
				href="/settings"
				class="flex min-h-11 items-center gap-1 text-lg text-ink no-underline"
			>
				<Icon name="chevron" class="size-5 rotate-180" />
				Settings
			</a>
			<h1 class="mt-2 font-serif text-4xl font-semibold tracking-tight">
				{title}
			</h1>
		</>
	);
}

/** The Suggestions page as src/routes/suggestions.tsx draws it: Settings' link, the count, then the card in a 3xl column. */
function SuggestionsPage({ children }: { children?: Child }) {
	return (
		<div class="lg:max-w-3xl">
			<a href="/settings" class="inline-flex min-h-11 items-center text-accent">
				Settings
			</a>
			<p class="mt-2 text-muted">Suggestions · 1 of 5</p>
			<div class="mt-6">{children}</div>
		</div>
	);
}

/** Categories as main draws them: each row a real CategoryRow, its ids numbered from `base` so no two pictures share one. `from` starts the list further down. */
function CategoryRows({
	base,
	count,
	from = 0,
}: {
	base: number;
	count: number;
	from?: number;
}) {
	return (
		<div class="mt-3 border-t border-rule">
			{CATEGORIES.slice(from, from + count).map((c, i) => (
				<CategoryRow
					category={{ ...c, id: base + i }}
					first={from + i === 0}
					last={i === count - 1}
					open={false}
					focus={false}
				/>
			))}
		</div>
	);
}

/** The first categories as plain lines, for the pictures that only need the list's shape (B's top). */
function CategoryLines({ count }: { count: number }) {
	return (
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{CATEGORIES.slice(0, count).map((c) => (
				<li class="flex min-h-11 items-center gap-4 py-2">
					<CategoryIcon icon={c.icon} color={c.color} />
					<span class="min-w-0 flex-1 truncate text-lg font-medium">
						{c.name}
					</span>
					<span class="shrink-0 tabular-nums">{dollars(c.budgetCents)}</span>
				</li>
			))}
		</ul>
	);
}

/** Today's top, as main draws it: the title, the Band and the first three categories. */
function TodayTop({ base }: { base: number }) {
	return (
		<>
			<SettingsHead />
			<h2 class="mt-8 font-serif text-3xl font-semibold">Categories</h2>
			<CategoryRows base={base} count={3} />
		</>
	);
}

/** A row with a name and a value, and the chevron that says it opens (the time zone row, as Settings draws it). */
function TimeRow() {
	return (
		<div class="flex min-h-11 items-center justify-between gap-3 py-2 text-lg">
			<span>Time zone</span>
			<span class="flex items-center gap-2">
				Eastern
				<Icon name="chevron" class="size-5 text-muted" />
			</span>
		</div>
	);
}

/** Household as main draws it: the time zone, then the app's own bank sign-in emails block, with its Save. */
function HouseholdSection() {
	return (
		<>
			<h2 class="font-serif text-3xl font-semibold">Household</h2>
			<div class="mt-3 border-t border-rule">
				<TimeRow />
				<BankSignInEmails on recipients={RECIPIENTS} open action="#" />
			</div>
		</>
	);
}

/** People as the household has them: one person, Everyone. */
function PeopleSection() {
	return (
		<>
			<h2 class="mt-8 font-serif text-3xl font-semibold">People</h2>
			<p class="mt-2 text-lg">Everyone</p>
		</>
	);
}

/** The five AI switches, all on, with the app's own October tally; Save only where `save` says. */
function AiSection({ prefix, save }: { prefix: string; save: boolean }) {
	return (
		<>
			<h2 class="font-serif text-3xl font-semibold">AI suggestions</h2>
			<p class="mt-1 text-muted">
				Off means your rules and choices only. Nothing already decided changes.
			</p>
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{AI_SWITCHES.map(({ label, hint }, i) => (
					<li>
						<Switch
							id={`${prefix}-${i}`}
							name={`ai-${i}`}
							label={label}
							hint={hint}
							checked
						/>
					</li>
				))}
			</ul>
			{save && (
				<div class="mt-4">
					<Button type="submit">Save</Button>
				</div>
			)}
			<AiTally
				tally={{
					month: "2026-10",
					sorted: 23,
					changed: 2,
					named: 6,
					paychecks: 2,
				}}
				switches={{ names: true, categories: true, income: true }}
			/>
		</>
	);
}

/** P134 A's contents page: the Band above More's kind of list, one row for each Settings section. */
function ContentsPage() {
	return (
		<>
			<SettingsHead />
			<ContentsList places={PLACES} />
		</>
	);
}

/**
 * A copy of BankSignInEmails without its Save, because A saves on flip: the sr-only line, the round initials, the
 * open "Who gets them" list with each Remove, as bank-sign-in-emails.tsx draws them. Its Remove is a plain button
 * (no form here), as OneCard's buttons are.
 */
function RecipientsCopy() {
	return (
		<>
			<div class="flex items-center gap-2 pb-1">
				<p class="sr-only">Goes to {RECIPIENTS.join(", ")}</p>
				<ul aria-hidden="true" class="flex -space-x-2">
					{RECIPIENTS.map((email, index) => (
						<li
							class={`flex size-8 items-center justify-center rounded-full border-2 border-paper text-sm font-semibold text-paper ${INITIAL_LOOKS[index % INITIAL_LOOKS.length]}`}
						>
							{email.charAt(0).toUpperCase()}
						</li>
					))}
				</ul>
			</div>
			<details class="group pb-3" open>
				<summary class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 text-accent [&::-webkit-details-marker]:hidden">
					<span class="min-w-0 flex-1">Who gets them</span>
					<Icon
						name="chevron-right"
						class="size-5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
					/>
				</summary>
				<p class="text-muted">
					Everyone who has signed in to Tally in the last 90 days.
				</p>
				<ul class="divide-y divide-rule border-y border-rule">
					{RECIPIENTS.map((email) => (
						<li class="flex min-h-11 items-center gap-3">
							<span class="min-w-0 flex-1 truncate">{email}</span>
							<Button kind="text" type="button" class="shrink-0">
								Remove<span class="sr-only"> {email}</span>
							</Button>
						</li>
					))}
				</ul>
			</details>
		</>
	);
}

/** P134 A's Household page: the time zone and the sign-in emails switch, just flipped on, with no Save. */
function HouseholdPage() {
	return (
		<>
			<SubpageHead title="Household" />
			<div class="mt-4 border-t border-rule">
				<TimeRow />
				<Switch
					id="p134-a-emails"
					name="enabled"
					label="Bank sign-in emails"
					checked
				/>
				<RecipientsCopy />
			</div>
		</>
	);
}

/** P134 A's rules page: each rule's category icon, then its name and rule on one line, Remove a quiet muted link, Never suggest one line. */
function RulesPage() {
	return (
		<>
			<SubpageHead title="Tally's rules" />
			<h2 class="mt-6 font-serif text-2xl font-semibold">
				Always for these merchants
			</h2>
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				{RULES.map((rule) => (
					<li class="flex min-h-11 items-center justify-between gap-4 py-3">
						<CategoryIcon icon={rule.icon} color={rule.color} />
						<span class="min-w-0 flex-1 text-lg wrap-anywhere">
							<span aria-hidden="true">
								{`${rule.name} · Always ${rule.category} · ${rule.count}`}
							</span>
							<span class="sr-only">
								{`${rule.name} is always ${rule.category}, ${rule.count}`}
							</span>
						</span>
						<a
							href="/settings"
							class="flex min-h-11 shrink-0 items-center text-sm text-muted underline"
						>
							Remove<span class="sr-only"> {rule.name}</span>
						</a>
					</li>
				))}
			</ul>
			<p class="mt-6 text-muted">
				Never suggest: Tally hasn't been told No yet.
			</p>
		</>
	);
}

/** P134 B's top: the title, the in-page links under it, the Band, and the first categories. */
function TidyTop() {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">Settings</h1>
			<p class="mt-2 flex flex-wrap items-center gap-x-2 text-lg">
				{TIDY_LINKS.map((label, i) => (
					<>
						{i > 0 && <span class="text-muted">·</span>}
						<a
							href={`#${label.toLowerCase().replaceAll(" ", "-")}`}
							class="inline-flex min-h-11 items-center text-ink no-underline"
						>
							{label}
						</a>
					</>
				))}
			</p>
			<div class="mt-4">
				<Band href="/settings/suggestions" detail="Tally's guesses; you decide">
					5 suggestions to check
				</Band>
			</div>
			<h2 class="mt-8 font-serif text-3xl font-semibold">Categories</h2>
			<CategoryLines count={3} />
		</>
	);
}

/**
 * P135 A's one card: the same words and rows wherever Tally asks a person about Pet Care, with decision 89's Why? after
 * No. The quiet answer is No, which retires the suggestion (decision 120). `skip` adds the Suggestions page's Skip link under it,
 * as the route draws it; the Settings card has none. `unticked` is a transaction whose row is unticked, with its optional
 * note under it, as today's card draws it (decision 120); only the picture that shows one passes it.
 */
function OneCard({
	skip = false,
	unticked,
}: {
	skip?: boolean;
	unticked?: number;
}) {
	return (
		<>
			<div class={CARD}>
				<p class="flex items-center gap-1.5 text-sm text-muted">
					<Icon name="sparkles" class="size-4" />
					Tally's guess
				</p>
				<h3 class="font-serif text-xl font-semibold">
					A new category: Pet Care
				</h3>
				<ul class="divide-y divide-rule border-y border-rule">
					{PET_ROWS.map((row) => (
						<li>
							<label class="flex min-h-11 flex-wrap items-center gap-x-3 py-2">
								<input
									type="checkbox"
									checked={row.id !== unticked}
									class="size-5 accent-ink"
								/>
								<span class="min-w-0 flex-1 wrap-anywhere">
									{row.displayName}
								</span>
								<span class="tabular-nums">{exact(row.amountCents)}</span>
								<span class="text-muted">{day(row.date)}</span>
							</label>
							{row.id === unticked && (
								<div class="pb-2">
									<TextInput
										id={`p135-a-note-${row.id}`}
										name={`note_${row.id}`}
										label={`A note for ${row.displayName} (optional)`}
										value=""
										maxlength={500}
										placeholder="Only used if you untick it"
										hint="Tally sorts it again right away, with your note."
										surface="paper"
										class="w-full"
									/>
								</div>
							)}
						</li>
					))}
				</ul>
				<p class="text-sm text-muted">Untick any that don't belong.</p>
				<div class="flex flex-wrap items-center gap-3">
					<Button type="button">Create Pet Care</Button>
					<Button kind="text" type="button">
						No
					</Button>
					<WhyLink section="categorization" topic="suggested categories" />
				</div>
			</div>
			{skip && (
				<p class="text-center">
					<a
						href="/settings/suggestions"
						class="inline-flex min-h-11 items-center text-accent"
					>
						Skip
					</a>
				</p>
			)}
		</>
	);
}

/** P135 A's card above Organize's chips: Tally's guess for this merchant and two more, with two answers. */
function OrganizeCard() {
	return (
		<div class={CARD}>
			<p class="flex items-center gap-1.5 text-sm text-muted">
				<Icon name="sparkles" class="size-4" />
				Tally's guess
			</p>
			<p class="text-lg">
				Tally suggested a new category for this and 2 more: Pet Care
			</p>
			<div class="flex flex-wrap items-center gap-3">
				<Button type="button">Create Pet Care</Button>
				<Button kind="text" type="button">
					Pick a category below
				</Button>
			</div>
		</div>
	);
}

/** Organize's heading for Banfield Pet Hospital: its name, the charge, and the question. */
function OrganizeHead() {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight wrap-anywhere">
				Banfield Pet Hospital
			</h1>
			<p class="mt-2 text-muted">{exact(18900)} · Aug 21</p>
			<p class="mt-4 text-lg">Which category?</p>
		</>
	);
}

/** Organize's category chips: the existing categories and New category, as the picker draws them. */
function CategoryChips({ name }: { name: string }) {
	return (
		<ul class="mt-3 flex flex-wrap gap-2">
			{CATEGORIES.map((c) => (
				<li>
					<Chip
						type="radio"
						name={name}
						value={c.name}
						icon={<CategoryIcon icon={c.icon} color={c.color} />}
					>
						{c.name}
					</Chip>
				</li>
			))}
			<li>
				<NewCategoryChip />
			</li>
		</ul>
	);
}

/** P135 B's one line above Organize's chips: a link to the suggestion, with the chevron that says it opens. */
function OrganizeLink() {
	return (
		<a
			href="/settings/suggestions"
			class="flex min-h-11 items-center justify-between gap-3 text-lg text-ink no-underline"
		>
			Tally has a suggestion for this merchant
			<Icon name="chevron" class="size-5 shrink-0" />
		</a>
	);
}

// ---------------------------------------------------------------------------------------------
// P134 · Settings (#606): the page as it is, a contents page with each section on its own page, or one page tidied.

function P134() {
	return (
		<Specimen
			id="p134-settings"
			title="P134 · Settings"
			tier="visual"
			sentence="Settings as main draws it, a contents page with each section on its own page, or one page tidied: the second audit's pick for #606. Each option is drawn as the screens it changes."
		>
			<Fixed>
				every save is an HTMX request that answers with a toast and an announce
				(CLAUDE.md); a switch is a real checkbox; a Save button shows only where
				a form needs one; no new client JavaScript. Tally only suggests and a
				person decides (decision 101).
			</Fixed>
			<Choices>
				<Choice
					name="Reference · Today on main"
					width="w-full"
					recommended={false}
					note="Settings as main draws it: one page, 3,554 px tall on a phone, with Categories, Tally's rules, Household, People, AI suggestions and Your data. Household and AI suggestions are switches that wait for a Save button; categories and rules save on their own."
				>
					<Shot caption="The top, cut at Categories">
						<Phone label="Reference, Settings top" tab="more" masthead={PILL}>
							<TodayTop base={9100} />
						</Phone>
					</Shot>
					<Shot caption="Household, further down, with its Save">
						<Phone
							label="Reference, Settings Household"
							scrolled
							tab="more"
							masthead={PILL}
						>
							<HouseholdSection />
							<PeopleSection />
						</Phone>
					</Shot>
					<Shot caption="AI suggestions, further down, with its Save">
						<Phone
							label="Reference, Settings AI suggestions"
							scrolled
							tab="more"
							masthead={PILL}
						>
							<AiSection prefix="p134-today-ai" save />
						</Phone>
					</Shot>
					<Shot caption="1280: the page's first screen">
						<Desk label="Reference, Settings" active="settings" group>
							<TodayTop base={9200} />
						</Desk>
					</Shot>
				</Choice>
				<Choice
					name="Option A · A contents page, each section its own page"
					picked
					width="w-full"
					note="Settings reads like More: what's there and how much, one tap from each. Settings becomes a contents list, and each section opens as its own page, with Settings as the back link. Switches save when flipped, and the 5-suggestions Band stays above the list."
					cost="five small pages instead of one long one; the switches post on change with HTMX (no new script)."
					why="a phone sees the whole of Settings on one screen, and a switch does what a switch looks like it does."
				>
					<Shot caption="The contents page at 390">
						<Phone label="Option A, contents" tab="more" masthead={PILL}>
							<ContentsPage />
						</Phone>
					</Shot>
					<Shot caption="The contents page at 1280, with the sidebar">
						<Desk label="Option A, contents" active="settings" group tall={900}>
							<ContentsPage />
						</Desk>
					</Shot>
					<Shot caption="Household at 390: a switch just flipped, its toast showing">
						<Phone
							label="Option A, Household"
							tab="more"
							masthead={PILL}
							overlay={
								<div class={TOAST_AT}>
									<Toast>Saved bank sign-in emails</Toast>
								</div>
							}
						>
							<HouseholdPage />
						</Phone>
					</Shot>
					<Shot caption="Tally's rules at 390 (a prototype: Remove is a muted link, and each rule names its category once)">
						<Phone label="Option A, rules" tab="more" masthead={PILL}>
							<RulesPage />
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="Option B · One page, tidied"
					width="w-full"
					recommended={false}
					note="The same page, with a way to jump and no Save buttons. A line of in-page links sits under the title, and the rest is A's tidying: switches save when flipped, Remove is muted, each rule names its category once, and Never suggest is one line."
					cost="anchors and A's tidying."
					why="fewer pages to keep up, and everything still on one scroll."
				>
					<Shot caption="The top at 390, with the links under the title">
						<Phone label="Option B, top" tab="more" masthead={PILL}>
							<TidyTop />
						</Phone>
					</Shot>
					<Shot caption="AI suggestions at 390: the switches, no Save">
						<Phone
							label="Option B, AI suggestions"
							scrolled
							tab="more"
							masthead={PILL}
						>
							<AiSection prefix="p134-b-ai" save={false} />
						</Phone>
					</Shot>
					<Shot caption="1280, with the sidebar">
						<Desk label="Option B, Settings" active="settings" group>
							<TidyTop />
						</Desk>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}

// ---------------------------------------------------------------------------------------------
// P135 · Category suggestions (#607): one card and one set of words, or one place to answer.

function P135() {
	return (
		<Specimen
			id="p135-suggestions"
			title="P135 · Category suggestions"
			tier="visual"
			sentence="Tally's Pet Care suggestion for Chewy, Petsmart and Banfield Pet Hospital, drawn where it's asked today and as each option draws it: at 390 px, with the Suggestions page at 1280 px. The owner picks one."
		>
			<Fixed>
				Tally suggests and a person decides (decision 101): nothing is created
				until someone says yes, and a suggestion waits until it is answered; the
				Suggestions page keeps its own screen; no new client JavaScript.
			</Fixed>
			<Choices>
				<Choice
					name="Reference · Today on main"
					width="w-full"
					recommended={false}
					note="The same suggestion drawn three ways: a dashed card in Settings with ticked rows and a dashed icon beside each check, the Suggestions page with two serif headlines and pill chips, and Organize, which offers only the existing categories and never mentions it."
				>
					<Shot caption="Settings' card, at 390">
						<Phone
							label="Reference, Settings card"
							scrolled
							tab="more"
							masthead={PILL}
						>
							<h2 class="font-serif text-3xl font-semibold">Categories</h2>
							<CategorySuggestionCard suggestion={PET_SUGGESTION} />
						</Phone>
					</Shot>
					<Shot caption="The Suggestions page, at 390">
						<Phone
							label="Reference, Suggestions page"
							tab="more"
							masthead={PILL}
						>
							<SuggestionsPage>
								<SuggestionCard
									action="/settings/suggestions"
									item={PET_ITEM}
									today={TODAY}
									skipHref="/settings/suggestions"
									categories={CATEGORY_CHOICES}
								/>
							</SuggestionsPage>
						</Phone>
					</Shot>
					<Shot caption="Organize, at 390: the existing categories only">
						<Phone
							label="Reference, Organize"
							tab="transactions"
							masthead={PILL}
						>
							<OrganizeHead />
							<CategoryChips name="p135-today-category" />
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="Option A · One card, one set of words, everywhere"
					picked
					width="w-full"
					note="One decision, drawn and worded the same wherever Tally asks it. The card: a muted line with the sparkles icon, the headline, ruled rows with one checkbox each, then Create and No, with Why? after No. No retires the suggestion, as Dismiss does today. An unticked row keeps its optional note, as today's card does, and Tally sorts it again with it. Skip is a link under the card on the Suggestions page only. The Settings card sits on A's Categories page, under the list (P134 A, decision 120). Organize shows a short form of the card above its chips, with its two answers."
					cost="SuggestionReview and the Settings card become one view; Organize reads the waiting suggestions."
					why="a person learns the card once, and Organize stops asking about a merchant Tally already has an answer for."
				>
					<Shot caption="Settings › Categories at 390: its own page, the card under the list">
						<Phone label="Option A, Categories page" tab="more" masthead={PILL}>
							<SubpageHead title="Categories" />
							<CategoryRows base={9300} count={7} />
							<div class="mt-4">
								<OneCard />
							</div>
						</Phone>
					</Shot>
					<Shot caption="Further down Categories: the card in full">
						<Phone
							label="Option A, Settings card"
							scrolled
							tab="more"
							masthead={PILL}
						>
							<CategoryRows base={9400} from={5} count={2} />
							<div class="mt-4">
								<OneCard />
							</div>
						</Phone>
					</Shot>
					<Shot caption="The Suggestions page, at 390">
						<Phone
							label="Option A, Suggestions page"
							tab="more"
							masthead={PILL}
						>
							<SuggestionsPage>
								<OneCard skip unticked={7101} />
							</SuggestionsPage>
						</Phone>
					</Shot>
					<Shot caption="Organize, at 390: the card above the chips">
						<Phone
							label="Option A, Organize"
							tab="transactions"
							masthead={PILL}
						>
							<OrganizeHead />
							<OrganizeCard />
							<CategoryChips name="p135-a-category" />
						</Phone>
					</Shot>
					<Shot caption="The Suggestions page, at 1280">
						<Desk label="Option A, Suggestions page" active="settings" group>
							<SuggestionsPage>
								<OneCard skip />
							</SuggestionsPage>
						</Desk>
					</Shot>
				</Choice>
				<Choice
					name="Option B · One place to answer"
					width="w-full"
					recommended={false}
					note="Suggestions are answered in one place; elsewhere they're a link. Settings shows only the 5 suggestions Band; the card lives on the Suggestions page, drawn as A's card; Organize shows one line above the chips."
					cost="Settings' card goes; Organize gets a link."
					why="the fewest places to keep in step."
				>
					<Shot caption="Settings' top, with only the Band">
						<Phone label="Option B, Settings top" tab="more" masthead={PILL}>
							<SettingsHead />
							<h2 class="mt-8 font-serif text-3xl font-semibold">Categories</h2>
							<CategoryLines count={3} />
						</Phone>
					</Shot>
					<Shot caption="The Suggestions page, at 390">
						<Phone
							label="Option B, Suggestions page"
							tab="more"
							masthead={PILL}
						>
							<SuggestionsPage>
								<OneCard skip />
							</SuggestionsPage>
						</Phone>
					</Shot>
					<Shot caption="Organize, at 390: a link above the chips">
						<Phone
							label="Option B, Organize"
							tab="transactions"
							masthead={PILL}
						>
							<OrganizeHead />
							<OrganizeLink />
							<CategoryChips name="p135-b-category" />
						</Phone>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}

/** The second design audit's two picks (#606 and #607), each drawn beside today's screen (decision 120). */
export function AuditRoundThreeProposals() {
	return (
		<>
			<P134 />
			<P135 />
		</>
	);
}
