// P122–P124 (issues #499, #95 and #501): the owner's polish picks (decision 111), each option drawn as the
// screens it changes, so the owner decides by seeing (decision 47). Every picture is inert and
// labelled, like the rest of the page. Where the app's markup is the same at a phone's size (the
// Wordmark, Band, WhyLink, ProgressRow, TransactionRow, FeedbackButton, LedgerIllustration, Icon),
// the real component draws it; where an option changes a screen, that screen is a prototype in
// tokens. The demo is the Riveras in October (Safe to spend $1,240); the family's numbers are
// the ones they see once a bank is linked: 86 need a category, $2,140 spent, no budgets yet.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { TallyMark, Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { chevron, summaryClass } from "../views/category-row";
import { FeedbackButton } from "../views/feedback-button";
import { HowLink } from "../views/how-link";
import { Icon, type IconName } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { SIDEBAR_ITEMS } from "../views/nav";
import { ProgressRow } from "../views/progress-row";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { WhyLink } from "../views/why-link";
import { Fixed, PickedPill, Sheet } from "./proposal-parts";
import { TITLE, tx } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

const money = (cents: number) => formatCents(cents, { wholeDollars: true });

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style.

type Budget = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

/**
 * The demo's October budgets in Settings' order: Eating Out is $36 over, Gas nearly spent. Childcare's
 * $1,040 budget and $480 spent (two $240 Fridays, Oct 2 and 9, by Oct 13) are the seed's own (src/demo/seed.ts).
 */
const BUDGETS: Budget[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 39500,
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 28600,
		budgetCents: 25000,
	},
	{
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents: 18600,
		budgetCents: 20000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 21000,
		budgetCents: 30000,
	},
	{
		name: "Childcare",
		icon: "kids",
		color: "cat-blue",
		spentCents: 48000,
		budgetCents: 104000,
	},
];

/** Settings' category list, with each budget as Settings shows it. */
const SETTINGS = [
	{ name: "Groceries", icon: "groceries", color: "cat-blue", budget: "$700" },
	{ name: "Eating Out", icon: "eating-out", color: "cat-plum", budget: "$250" },
	{ name: "Gas", icon: "gas", color: "cat-slate", budget: "$200" },
	{ name: "Kids", icon: "kids", color: "cat-ochre", budget: "$300" },
	{ name: "Childcare", icon: "kids", color: "cat-blue", budget: "$1,040" },
];

const DEMO_STATUS = "Eating Out is $36 over. Everything else is on track.";

/** Home's places a visitor taps, as the demo has them (spec §9). */
const THINGS = [
	{
		label: "Give a transaction a category",
		href: "/transactions?uncategorized=1",
		line: "Opens the transactions that need a category.",
	},
	{
		label: "Set a rule for a merchant",
		href: "/transactions/110?uncategorized=1",
		line: "Opens one transaction, where its rule is set.",
	},
	{
		label: "Rename a merchant",
		href: "/transactions/110?uncategorized=1",
		line: "Opens the same transaction, where its name is changed.",
	},
];

/** The bank's own line, struck through, above Tally's row for it (P124 A). */
const BANK_LINES = [
	{
		bank: "ACME CORP PAYROLL",
		row: {
			...tx(901, "2026-10-01", "ACME CORP PAYROLL", -245000, undefined, {
				income: true,
			}),
			displayName: "Paycheck",
		},
	},
	{
		bank: "ONLINE TRANSFER TO SAV ...5678",
		row: {
			...tx(
				902,
				"2026-10-02",
				"ONLINE TRANSFER TO SAV ...5678",
				50000,
				undefined,
				{ excluded: true },
			),
			displayName: "Transfer to Savings",
		},
	},
	{
		bank: "SQ *LOCAL BAKERY 4432",
		// Tally's name is the row's raw name too, so only Needs category shows under it; the bank's text is struck above.
		row: tx(903, "2026-10-03", "Local Bakery", 1200),
	},
];

// ---------------------------------------------------------------------------------------------
// Frames: a phone's screen and a desktop window, drawn as pictures. They repeat the width, border
// and inert wrapper of PhoneFrame (specimen.tsx) and DesktopFrame (proposal-parts.tsx), and add
// what these options need that the shared frames lack: the tab bar, a masthead slot, the pill's
// overlay, a banner, and a scrolled view with no banner or wordmark. A phone here is 390 by 844
// inside its border, the size the brief names and the app's own viewport. PhoneFrame is 790 tall,
// and the pill sits at the screen's foot, so a shorter frame would lift the pill over the rows and
// hide where it really sits. Adding those props to the shared frames would change every proposal
// file, so this page keeps its own frames for now; that is a follow-up candidate, not part of
// P122–P124.

type PhoneProps = {
	label: string;
	/** The demo banner on top; false draws the family's app. */
	demo?: boolean;
	/** Drawn from further down the page: no banner, no wordmark, so the content starts at the top. */
	scrolled?: boolean;
	/** The demo banner's own words, when an option changes them. */
	banner?: Child;
	/** What sits at the wordmark's right, in the masthead line. */
	masthead?: Child;
	/** The tab bar, with this tab current; none for a picture without one. */
	tab?: "home" | "more";
	/** Drawn over the screen, as the feedback pill is fixed to it. */
	overlay?: Child;
	children?: Child;
};

function Phone({
	label,
	demo = true,
	scrolled = false,
	banner,
	masthead,
	tab,
	overlay,
	children,
}: PhoneProps) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on a phone`}
				class="relative h-[846px] w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<div data-screen="picture">
						{!scrolled &&
							(banner ??
								(demo && (
									<p class="bg-band py-2 text-center text-sm text-muted">
										Demo data. Nothing here is real.
									</p>
								)))}
						<div class="px-5 pt-6">
							{!scrolled && (
								<div class="mb-4 flex items-center justify-between gap-3">
									<Wordmark />
									{masthead}
								</div>
							)}
							{children}
						</div>
						{tab && <Tabs current={tab} />}
						{overlay}
					</div>
				</div>
			</div>
		</div>
	);
}

/** The tab bar as BottomTabs draws it, pinned to the screen's foot, with the current tab in accent. */
function Tabs({ current }: { current: "home" | "more" }) {
	const tabs = [
		...SIDEBAR_ITEMS.slice(0, 4),
		{ key: "more", label: "More", icon: "more" as IconName },
	];
	return (
		<nav class="absolute inset-x-0 bottom-0 border-t border-rule bg-paper">
			<ul class="grid grid-cols-5">
				{tabs.map((t) => (
					<li
						class={`flex h-14 flex-col items-center justify-center gap-1 text-xs ${t.key === current ? "text-accent" : "text-muted"}`}
					>
						<Icon name={t.icon} />
						{t.label}
					</li>
				))}
			</ul>
		</nav>
	);
}

/** The feedback pill as the phone draws it: the real button, not fixed, placed over the screen. */
const pill = <FeedbackButton fixed={false} />;

/** The pill's place over a screen: fixed bottom-right above the tab bar, as it sits in the app. */
const floatingPill = <div class="absolute bottom-[6.5rem] right-4">{pill}</div>;

type DeskProps = {
	label: string;
	/** Adds the second sidebar group: How Tally works and Feedback. */
	group?: boolean;
	/** The pill at the window's corner, where it sits on desktop today. */
	floating?: boolean;
	children?: Child;
};

/** A desktop window's first screen, with the sidebar, drawn at 722 by 560 as DesktopFrame does. */
function Desk({ label, group = false, floating = false, children }: DeskProps) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on desktop`}
				class="relative h-[560px] w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<div data-screen="picture">
						<div class="flex gap-6 px-6 py-6">
							<aside class="w-56 shrink-0">
								<div class="mb-6">
									<Wordmark />
								</div>
								<nav>
									<ul class="flex flex-col gap-1">
										{SIDEBAR_ITEMS.map((item) => (
											<li>
												<a
													href={item.href}
													class={`flex min-h-11 items-center gap-3 rounded-control px-2 text-lg no-underline ${item.key === "home" ? "text-accent" : "text-ink"}`}
												>
													<Icon name={item.icon} />
													{item.label}
												</a>
											</li>
										))}
									</ul>
									{group && (
										<ul class="mt-3 flex flex-col gap-1 border-t border-rule pt-3">
											<li>
												<a
													href="/how-it-works"
													class="flex min-h-11 items-center gap-3 rounded-control px-2 text-lg text-ink no-underline"
												>
													<TallyMark class="size-6" />
													How Tally works
												</a>
											</li>
											<li>
												<a
													href="/feedback"
													class="flex min-h-11 items-center gap-3 rounded-control px-2 text-lg text-ink no-underline"
												>
													<Icon name="message" />
													Feedback
												</a>
											</li>
										</ul>
									)}
								</nav>
							</aside>
							<main class="min-w-0 flex-1">{children}</main>
						</div>
						{floating && <div class="absolute bottom-6 right-6">{pill}</div>}
					</div>
				</div>
			</div>
		</div>
	);
}

/** One picture of an option, with a caption in words above it. */
function Shot({ caption, children }: { caption: string; children?: Child }) {
	return (
		<figure class="flex min-w-0 max-w-full flex-col gap-2">
			<figcaption class="text-sm text-muted">{caption}</figcaption>
			{children}
		</figure>
	);
}

// ---------------------------------------------------------------------------------------------
// Options: each one's name, what it is, what it costs, why it's recommended, then its pictures.

type ChoiceProps = {
	name: string;
	/** The idea, in plain words. */
	note: Child;
	/** What it costs, in one line. */
	cost?: string;
	/** Why it's the recommended one, in one line. */
	why?: string;
	/** The owner picked this one (decision 111). */
	picked?: boolean;
	/** One more sentence under the idea. */
	extra?: Child;
	/** A card as wide as its pictures need. */
	width?: string;
	children?: Child;
};

/**
 * Options' markup (proposal-parts.tsx), kept here because one of these options draws several pictures
 * and a longer note, which Options (one picture, one screen) cannot take.
 */
function Choice({
	name,
	note,
	cost,
	why,
	picked,
	extra,
	width = "w-[392px]",
	children,
}: ChoiceProps) {
	return (
		<div class={`flex min-w-0 max-w-full flex-col gap-4 ${width}`}>
			<div class="flex flex-col gap-1">
				<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
					{name}
					{why && (
						<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
							Recommended
						</span>
					)}
					{picked && <PickedPill />}
				</h4>
				<p class="text-sm">{note}</p>
				{extra && <p class="text-sm">{extra}</p>}
				{cost && <p class="text-sm text-muted">Trade-off: {cost}</p>}
				{why && <p class="text-sm text-muted">Why: {why}</p>}
			</div>
			<div class="flex min-w-0 max-w-full flex-wrap items-start gap-4">
				{children}
			</div>
		</div>
	);
}

/** An option's cards side by side, as Options lays them out. */
function Choices({ children }: { children?: Child }) {
	return <div class="flex flex-wrap gap-8">{children}</div>;
}

// ---------------------------------------------------------------------------------------------
// Home: its top and its Budget list, as the real HomeTop and ProgressRow draw them at a phone's size.

/** The big amount, at the phone's size (HomeTop's size; no lg: step, so it fits the frame). */
function Amount({ tone = "", children }: { tone?: string; children?: Child }) {
	return (
		<p
			class={`font-serif text-6xl font-semibold tracking-tight whitespace-nowrap ${tone}`}
		>
			{children}
		</p>
	);
}

const DEMO_BAND = (
	<Band href="/transactions/organize" detail="$228 of this month's spending">
		12 need a category
	</Band>
);

const FAMILY_BAND = (
	<Band href="/transactions/organize" detail="$2,140 of this month's spending">
		86 need a category
	</Band>
);

/**
 * Home's top, as HomeTop draws it: the month, Safe to spend with its Why? link, the amount, the
 * status sentence, How this works (or none), and the Band. `month` false starts it at the amount,
 * for a picture of Home scrolled down.
 */
function HomeTop({
	label = "Safe to spend",
	amount,
	status,
	howLink = <HowLink section="budget" />,
	band,
	month = true,
	children,
}: {
	label?: string;
	amount: Child;
	status: Child;
	howLink?: Child | false;
	band?: Child;
	month?: boolean;
	children?: Child;
}) {
	return (
		<>
			{month && (
				<h1 class="font-serif text-2xl font-semibold tracking-tight">
					October
				</h1>
			)}
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					<p class="text-lg text-muted">
						{label} · <WhyLink section="budget" topic="safe to spend" />
					</p>
					{amount}
				</div>
				<div class="shrink-0 [&>svg]:size-28">
					<LedgerIllustration />
				</div>
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			{howLink && <div class="mt-1">{howLink}</div>}
			{band && <div class="mt-4">{band}</div>}
			{children}
		</>
	);
}

/** The Budget heading and its rows, as Home draws them. */
function BudgetList({
	rows,
	heading = true,
}: {
	rows: Budget[];
	heading?: boolean;
}) {
	return (
		<section class="mt-8">
			{heading && <h2 class="font-serif text-3xl font-semibold">Budget</h2>}
			<ul class={`${heading ? "mt-2" : ""} divide-y divide-rule`}>
				{rows.map((r) => (
					<ProgressRow {...r} />
				))}
			</ul>
		</section>
	);
}

/** The demo's Home, top to the Band and the first two budget rows (the picture P124 Today draws first). */
const demoTop = (
	<HomeTop
		amount={<Amount>{money(124000)}</Amount>}
		status={DEMO_STATUS}
		band={DEMO_BAND}
	>
		<BudgetList rows={BUDGETS.slice(0, 2)} />
	</HomeTop>
);

/** Home a little way down, to the Budget list: the same top from the amount on, and the list. */
function HomeScrolled() {
	return (
		<HomeTop
			month={false}
			amount={<Amount>{money(124000)}</Amount>}
			status={DEMO_STATUS}
			howLink={false}
		>
			<div class="pt-22">
				<BudgetList rows={BUDGETS} heading={true} />
			</div>
		</HomeTop>
	);
}

/** The family's Home before any budget is set, with a bank linked and 86 transactions needing a category. */
function FamilyHome({
	amount,
	status,
	howLink,
}: {
	amount: Child;
	status: Child;
	howLink?: Child | false;
}) {
	return (
		<HomeTop
			amount={amount}
			status={status}
			howLink={howLink}
			band={FAMILY_BAND}
		/>
	);
}

/** Today's family Home as main draws it after #519: a negative amount in ink, and no budget yet, so no over-budget words. */
const TODAY_FAMILY = (
	<FamilyHome amount={<Amount>−$2,140</Amount>} status="No budgets set yet." />
);

/** The family's blank ledger line, before any budget: a dashed rule where the amount goes. */
const blankLine = (
	<p class="font-serif text-6xl font-semibold tracking-tight whitespace-nowrap">
		<span class="text-muted">$</span>{" "}
		<span class="inline-block h-[0.8em] w-36 border-b-2 border-dashed border-muted" />
		<span class="sr-only">Not worked out yet</span>
	</p>
);

// ---------------------------------------------------------------------------------------------
// P122 · What More shows.

const ACCOUNTS_FOLIO = (
	<span class="shrink-0 text-sm text-muted tabular-nums">3 accounts</span>
);

const NEEDS_ATTENTION = (
	<span class="inline-flex shrink-0 items-center gap-1 text-sm text-over">
		<Icon name="alert" class="size-4" />
		Needs attention
	</span>
);

/** The places More holds, each with what it holds and, where it has one, a folio. */
type Place = {
	name: string;
	icon?: IconName;
	mark?: boolean;
	folio?: Child;
	desc: string;
};

const ACCOUNTS: Place = {
	name: "Accounts",
	icon: "accounts",
	folio: ACCOUNTS_FOLIO,
	desc: "Balances, net worth and your banks",
};

const PLACES: Place[] = [
	ACCOUNTS,
	{
		name: "Settings",
		icon: "settings",
		folio: (
			<span class="shrink-0 text-sm text-ink tabular-nums">3 to check</span>
		),
		desc: "Categories, rules, your household and your data",
	},
	{
		name: "How Tally works",
		mark: true,
		desc: "What each number means, with the Riveras' numbers",
	},
];

/** One place on the contents page: its icon, name, leader and folio, with what it holds under them. */
function Entry({ place }: { place: Place }) {
	return (
		<a
			href="#p122-more"
			class="grid min-h-16 grid-cols-[1.5rem_1fr] items-start gap-x-4 py-3 text-ink no-underline"
		>
			{place.mark ? (
				<TallyMark class="mt-0.5 size-6" />
			) : (
				<Icon name={place.icon ?? "more"} class="mt-0.5 size-6" />
			)}
			<span class="min-w-0">
				<span class="flex items-baseline gap-2">
					<span class="shrink-0 text-lg">{place.name}</span>
					{place.folio && (
						<>
							<span
								aria-hidden="true"
								class="min-w-4 flex-1 border-b-2 border-dotted border-rule"
							/>
							{place.folio}
						</>
					)}
				</span>
				<span class="block text-sm text-muted">{place.desc}</span>
			</span>
		</a>
	);
}

/** More as the route draws it: a title over a ruled list of plain links. */
const plainMore = (
	<ul class="mt-6 divide-y divide-rule border-y border-rule">
		{["Accounts", "Settings", "How Tally works"].map((label) => (
			<li>
				<a
					href="#p122-more"
					class="flex min-h-11 items-center py-3 text-lg text-ink no-underline"
				>
					{label}
				</a>
			</li>
		))}
	</ul>
);

/** The contents page: each place with its icon, what it holds and its count, then the colophon. */
const contentsMore = (
	<>
		<ul class="mt-6 divide-y divide-rule border-y border-rule">
			{PLACES.map((place) => (
				<li>
					<Entry place={place} />
				</li>
			))}
		</ul>
		<p class="mt-10 flex items-center justify-center gap-2 text-sm text-muted">
			<TallyMark class="size-4" />
			Tally demo · resets every night
		</p>
	</>
);

/** The plain index: the same places as the sidebar's, one line each, with no leaders or folios. */
const indexMore = (
	<ul class="mt-6 divide-y divide-rule border-y border-rule">
		{PLACES.map((place) => (
			<li>
				<a
					href="#p122-more"
					class="flex min-h-16 items-center gap-4 py-3 text-ink no-underline"
				>
					{place.mark ? (
						<TallyMark class="size-6" />
					) : (
						<Icon name={place.icon ?? "more"} class="size-6" />
					)}
					<span class="min-w-0 flex-1">
						<span class="block text-lg">{place.name}</span>
						<span class="block text-sm text-muted">{place.desc}</span>
					</span>
					<span class="shrink-0 text-muted">
						<Icon name="chevron-right" class="size-5" />
					</span>
				</a>
			</li>
		))}
	</ul>
);

/** More's screen as a phone draws it, with its title and the tab bar, More current. */
function MoreScreen({ label, children }: { label: string; children?: Child }) {
	return (
		<Phone label={label} tab="more">
			<h1 class={TITLE}>More</h1>
			{children}
		</Phone>
	);
}

// ---------------------------------------------------------------------------------------------
// P123 · Where Feedback lives.

/**
 * Settings as the app draws it (routes/settings.tsx, category-row.tsx): the Band above Categories, then
 * the list with Gas's row open, in the app's order: its Name field, Save, Cancel and Archive, then Move
 * up and Move down. `fieldId` keeps each picture's field id its own; `overlay` puts the pill on it and
 * `masthead` puts it in the top line.
 */
function SettingsPhone({
	label,
	fieldId,
	overlay,
	masthead,
}: {
	label: string;
	fieldId: string;
	overlay?: Child;
	masthead?: Child;
}) {
	return (
		<Phone label={label} tab="more" overlay={overlay} masthead={masthead}>
			<h1 class={TITLE}>Settings</h1>
			<div class="mt-4">
				<Band href="/settings/suggestions" detail="Tally's guesses; you decide">
					3 suggestions to check
				</Band>
			</div>
			<section class="mt-8">
				<h2 class="font-serif text-3xl font-semibold">Categories</h2>
				<div class="mt-3 border-t border-rule">
					{SETTINGS.map((c) => (
						<details class="group border-b border-rule" open={c.name === "Gas"}>
							<summary class={summaryClass}>
								<CategoryIcon icon={c.icon} color={c.color} />
								<span class="min-w-0 truncate text-lg font-medium">
									{c.name}
								</span>
								<span class="ml-auto shrink-0 tabular-nums">
									{c.budget}
									<span class="text-muted"> a month</span>
								</span>
								{chevron}
							</summary>
							{c.name === "Gas" && (
								<div class="flex flex-col gap-4 pb-5">
									<TextInput
										id={`${fieldId}-gas-name`}
										label="Name"
										name="name"
										value={c.name}
										maxlength={40}
										autocomplete="off"
										class="sm:max-w-sm"
									/>
									<p class="text-muted">
										<a href="/" class="inline-flex min-h-11 items-center">
											Change its budget on Home
										</a>
									</p>
									<div class="flex flex-wrap items-center gap-3">
										<Button type="button">Save</Button>
										<Button kind="secondary" type="button">
											Cancel
										</Button>
										<Button kind="text" type="button" class="ml-auto">
											Archive
										</Button>
									</div>
									<div class="flex flex-wrap gap-2">
										<Button kind="secondary" type="button" class="gap-2">
											<Icon name="arrow-up" class="size-4" />
											Move up
										</Button>
										<Button kind="secondary" type="button" class="gap-2">
											<Icon name="arrow-down" class="size-4" />
											Move down
										</Button>
									</div>
								</div>
							)}
						</details>
					))}
				</div>
			</section>
		</Phone>
	);
}

/** Home scrolled to the Budget list, with the pill over its last row or nothing over it. */
function ScrolledHome({ label, overlay }: { label: string; overlay?: Child }) {
	return (
		<Phone label={label} scrolled tab="home" overlay={overlay}>
			<HomeScrolled />
		</Phone>
	);
}

/** More with the Feedback row, as Option B draws it: a form, one tap from every page. */
const moreWithFeedback = (
	<>
		<ul class="mt-6 divide-y divide-rule border-y border-rule">
			{["Accounts", "Settings", "How Tally works"].map((label) => (
				<li>
					<a
						href="#p123-feedback"
						class="flex min-h-11 items-center py-3 text-lg text-ink no-underline"
					>
						{label}
					</a>
				</li>
			))}
			<li>
				<a
					href="/feedback"
					class="flex min-h-16 items-start gap-4 py-3 text-ink no-underline"
				>
					<Icon name="message" class="mt-0.5 size-6" />
					<span class="min-w-0">
						<span class="block text-lg">Feedback</span>
						<span class="block text-sm text-muted">
							Something confusing, broken or missing
						</span>
						<span class="block text-sm text-muted">
							Off in the demo; you can still see the form
						</span>
					</span>
				</a>
			</li>
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// P124 · What a first visit shows and teaches.

/** The line of demo copy above the Home top, with Start here as the one ink link (A). */
const startHereBanner = (
	<p class="bg-band py-2 text-center text-sm text-muted">
		Demo data. Nothing here is real. ·{" "}
		<a
			href="/how-it-works"
			class="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4"
		>
			Start here
		</a>
	</p>
);

/** The demo banner with Things to try as its one link (B). */
const thingsBanner = (
	<p class="bg-band py-2 text-center text-sm text-muted">
		Demo data. Nothing here is real. ·{" "}
		<a
			href="/how-it-works"
			class="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4"
		>
			Things to try
		</a>
	</p>
);

/** How this works in muted, underlined words (B), in place of today's terracotta link. */
const quietHowLink = (
	<a
		href="/how-it-works#budget"
		class="inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4"
	>
		How this works
	</a>
);

/** A pencil note: a link set off by a thin rule on the left, in muted words (C). */
const pencil = (
	<p class="border-l border-muted pl-3 text-sm text-muted">
		<a
			href="/how-it-works#budget"
			class="text-muted underline underline-offset-4"
		>
			How this works
		</a>
	</p>
);

/** Today's Things to try, as a prototype at a phone's size (the real one's lg: layout would crowd a phone). */
const thingsPhone = (
	<section class="mt-8 rounded-control border border-rule px-4 py-3">
		<p class="font-serif text-2xl font-semibold">New here? Things to try</p>
		<ul class="mt-1">
			{THINGS.map((t) => (
				<li>
					<a href={t.href} class="inline-flex min-h-11 items-center">
						{t.label}
					</a>
				</li>
			))}
		</ul>
		<p class="text-sm text-muted">
			For a rule or a new name, open a transaction and tap "Always for this
			merchant," or "Rename or add a note."
		</p>
		<a
			href="/how-it-works"
			class="inline-flex min-h-11 items-center text-muted"
		>
			How Tally works →
		</a>
	</section>
);

/** How Tally works' opening, as the story (A): the bank's line, struck, and Tally's row under it. */
const storyHead = (
	<>
		<div class="flex items-center justify-between gap-4">
			<h2 class="font-serif text-3xl font-semibold">Start here</h2>
			<div class="shrink-0 [&>svg]:size-24">
				<LedgerIllustration />
			</div>
		</div>
		<p class="mt-4 text-lg">
			The Riveras are a made-up family. Here's what their bank sent this
			October, and what Tally wrote down.
		</p>
		<h3 class="mt-6 font-medium text-muted">Three lines of 47 so far</h3>
		<div class="mt-3 flex flex-col gap-4">
			{BANK_LINES.map(({ bank, row }) => (
				<div>
					<p class="text-sm text-muted">
						<span class="sr-only">The bank sent </span>
						<s class="decoration-muted">{bank}</s>
					</p>
					<ul class="mt-1 border-y border-rule">
						<TransactionRow row={row} />
					</ul>
				</div>
			))}
		</div>
	</>
);

/** The total under a double ink rule, and the three things to try (A, the second part). */
const storyTotal = (
	<>
		<p class="mt-2">
			Without Tally, the paycheck and the transfer would both count as spending.
		</p>
		<a href="/transactions" class="inline-flex min-h-11 items-center">
			See every line without Tally
		</a>
		<div class="mt-4 border-t border-ink pt-3">
			<div class="flex items-baseline justify-between gap-4">
				<p class="text-lg">Safe to spend</p>
				<p class="text-2xl font-semibold tabular-nums">$1,240</p>
			</div>
			<div class="mt-1 border-b-[3px] border-double border-ink" />
			<p class="mt-2 text-sm text-muted">
				What's left of October's budget after bills due and savings. It's the
				big number on Home.
			</p>
		</div>
		<h3 class="mt-8 font-serif text-2xl font-semibold">Three things to try</h3>
		<ul class="mt-2">
			{THINGS.map((t) => (
				<li>
					<a href={t.href} class="inline-flex min-h-11 items-center">
						{t.label}
					</a>
				</li>
			))}
		</ul>
	</>
);

/** How Tally works as today opens it (Today), the page's first part with How it's built. */
const howTodayTop = (
	<>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			How Tally works
		</h1>
		<p class="mt-4 text-lg">
			Tally is a small family budgeting app. One server builds every page and a
			database keeps the numbers. AI helps with names and categories: Jev picks
			categories today, and Workers AI suggests merchant names today. Code does
			all the math.
		</p>
		<p class="mt-2 text-muted">
			This demo has no bank connection. It runs on a made-up household, the
			Riveras, and resets every night.
		</p>
		<section class="mt-8">
			<h2 class="font-serif text-3xl font-semibold">How it's built</h2>
			<p class="mt-2 text-muted">
				Pages, a database, and the code that does the math, each in one place.
			</p>
		</section>
	</>
);

/** The family's three steps, as How Tally works opens for them (A). */
const familySteps = (
	<>
		<h1 class={TITLE}>How Tally works</h1>
		<ul class="mt-6 divide-y divide-rule border-y border-rule">
			<li class="flex min-h-16 items-center gap-4 py-3">
				<Icon name="check" class="size-6 shrink-0 text-accent" />
				<span class="text-lg">Link your bank</span>
				<span class="ml-auto text-sm text-muted">Done</span>
			</li>
			<li class="flex min-h-16 items-center gap-4 py-3">
				<span
					aria-hidden="true"
					class="size-6 shrink-0 rounded-full border-2 border-ink"
				/>
				<span class="text-lg">Sort what needs a category</span>
				<span class="ml-auto">
					<Button kind="secondary" type="button">
						Sort them
					</Button>
				</span>
			</li>
			<li class="flex min-h-16 items-center gap-4 py-3 text-muted">
				<span
					aria-hidden="true"
					class="size-6 shrink-0 rounded-full border-2 border-dashed border-muted"
				/>
				<span class="text-lg">Set your budgets</span>
			</li>
		</ul>
	</>
);

/** The family's Home before budgets, in the words B and A use: no number yet. */
const startFromSeptember = [
	{ name: "Groceries", last: 668, start: 670 },
	{ name: "Rent", last: 1600, start: 1600 },
	{ name: "Childcare", last: 894, start: 900 },
	{ name: "Kids", last: 334, start: 340 },
	{ name: "Gas", last: 326, start: 330 },
];

/** The budgets that B's sheet offers: last month's amount rounded up to the next $10 (the five shown add up to $3,840, not the family's whole list of 14). */
const startSheet = (
	<>
		<h2 class="font-serif text-3xl font-semibold">Start from September</h2>
		<ul class="divide-y divide-rule border-y border-rule">
			{startFromSeptember.map((c) => (
				<li class="flex min-h-11 items-center justify-between gap-3 py-2">
					<span class="text-lg">{c.name}</span>
					<span class="text-sm text-muted">
						Last month {money(c.last * 100)} · starts at {money(c.start * 100)}
					</span>
				</li>
			))}
		</ul>
		<p class="text-muted">These budgets add up to $3,840 a month.</p>
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				Use these budgets
			</Button>
		</div>
	</>
);

/** The mark turned on its side as a figure: one stroke for each thing Tally did, crossed through to the total (C). */
const ledgerMark = (
	<svg
		class="h-56 w-12 shrink-0 text-ink"
		viewBox="0 0 48 224"
		fill="none"
		stroke="currentColor"
		stroke-width="2.25"
		stroke-linecap="round"
		aria-hidden="true"
	>
		<line x1="6" y1="28" x2="42" y2="28" />
		<line x1="6" y1="84" x2="42" y2="84" />
		<line x1="6" y1="140" x2="42" y2="140" />
		<line x1="6" y1="196" x2="42" y2="196" />
		<line x1="2" y1="8" x2="46" y2="216" />
	</svg>
);

/** C's tally at the foot of Home: the figure, four ruled rows, the total under a double rule, and the things to try. */
const tallyFoot = (
	<section class="mt-8">
		<h2 class="font-serif text-3xl font-semibold">The Riveras' tally</h2>
		<div class="mt-4 flex gap-4">
			{ledgerMark}
			<ul class="min-w-0 flex-1 divide-y divide-rule border-y border-rule">
				<li class="flex h-14 flex-col justify-center">
					<span class="text-lg">Named 38 stores</span>
					<a href="/transactions" class="text-sm">
						See without Tally
					</a>
				</li>
				<li class="flex h-14 flex-col justify-center">
					<span class="text-lg">Sorted 196 into categories</span>
				</li>
				<li class="flex h-14 flex-col justify-center">
					<span class="text-lg">Set 3 transfers aside</span>
				</li>
				<li class="flex h-14 flex-col justify-center">
					<span class="text-lg">Found 2 paychecks</span>
				</li>
			</ul>
		</div>
		<div class="mt-6">
			<p class="text-lg text-muted">
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</p>
			<p class="font-serif text-5xl font-semibold tracking-tight">$1,240</p>
			<div class="mt-1 border-b-[3px] border-double border-ink" />
		</div>
		<p class="mt-6 text-sm text-muted">Try it yourself:</p>
		<ul class="mt-1">
			{THINGS.map((t) => (
				<li>
					<a href={t.href} class="inline-flex min-h-11 items-center">
						{t.label}
					</a>
				</li>
			))}
		</ul>
		<div class="mt-4">{pencil}</div>
	</section>
);

/** C's family Home: the first page, three steps, and Home's one next step. */
const firstPage = (
	<>
		<div class="flex items-center justify-between gap-4">
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Your first page
			</h1>
			<div class="shrink-0 [&>svg]:size-24">
				<LedgerIllustration />
			</div>
		</div>
		<p class="mt-3 text-lg">
			Three steps, and Home shows what's safe to spend.
		</p>
		<ol class="mt-6 flex flex-col gap-3">
			<li class="flex items-center gap-3 text-muted">
				<Icon name="check" class="size-6 shrink-0 text-accent" />
				<s class="decoration-muted text-lg">Link your bank</s>
				<span class="ml-auto text-sm">Done</span>
			</li>
			<li>
				<Band href="/transactions/organize">Sort what needs a category</Band>
			</li>
			<li class="flex min-h-11 items-center gap-3 text-muted">
				<span
					aria-hidden="true"
					class="size-6 shrink-0 rounded-full border-2 border-dashed border-muted"
				/>
				<span class="text-lg">Set your budgets</span>
			</li>
		</ol>
	</>
);

/** The family's first steps, behind the sheet (B): Home's blank line and its one next step. */
const familyBehind = (
	<HomeTop
		amount={
			<Amount tone="text-muted">
				<span class="sr-only">Not set yet</span>—
			</Amount>
		}
		status="No budgets set yet."
		howLink={quietHowLink}
		band={
			<Band
				href="/transactions/organize"
				detail="Each category at what it spent. You'll see them before anything is saved."
			>
				Start your budgets from September
			</Band>
		}
	/>
);

// ---------------------------------------------------------------------------------------------
// The page's three polish proposals, picked.

/** The three polish picks: More, Feedback, and a first visit (P122–P124), picked in decision 111. */
export function PolishRoundCProposals() {
	return (
		<>
			<Specimen
				id="p122-more"
				title="P122 · What More shows"
				tier="visual"
				sentence="More holds the places the tabs don't. Pick how it shows them. Each is More on a phone, with the tab bar, and More current."
			>
				<Fixed>
					More holds the places the phone's four tabs don't (Accounts, Settings,
					How Tally works; Documents waits for receipts, decision 84); the
					sidebar shows the same places with icons.
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						note="More is a title over three plain text rows, under rules."
					>
						<MoreScreen label="Today (current), More">{plainMore}</MoreScreen>
					</Choice>
					<Choice
						name="Option A · Contents page"
						note="More reads like the contents page of a ledger: each place, what it holds, and a count that says when it needs you."
						cost="Two small live counts on More."
						why="A newcomer sees what's behind each door, and More points to the place that needs them."
						picked
					>
						<div class="flex min-w-0 max-w-full flex-col gap-4">
							<MoreScreen label="Option A, More">{contentsMore}</MoreScreen>
							<div
								role="img"
								aria-label="Option A, when a bank needs signing in, on a phone"
								class="w-[392px] max-w-full rounded-control border border-ink bg-paper px-5 py-2"
							>
								<div inert>
									<div data-screen="picture">
										<p class="text-sm text-muted">
											The same place, when a bank needs signing in
										</p>
										<ul class="mt-2 border-y border-rule">
											<li>
												<Entry
													place={{ ...ACCOUNTS, folio: NEEDS_ATTENTION }}
												/>
											</li>
										</ul>
									</div>
								</div>
							</div>
						</div>
					</Choice>
					<Choice
						name="Option B · Plain index"
						note="More looks like the sidebar, with one line saying what each place holds. Calm and clear; matches the sidebar."
						cost="None beyond the words."
					>
						<MoreScreen label="Option B, More">{indexMore}</MoreScreen>
					</Choice>
				</Choices>
			</Specimen>

			<Specimen
				id="p123-feedback"
				title="P123 · Where Feedback lives"
				tier="visual"
				sentence="The pill you signed off sits over a row's amount on Home today. Pick where Feedback lives. Each is Home scrolled, Settings with Gas open, and the desktop."
			>
				<Fixed>
					Feedback opens the short form the owner signed off (decision 58, P14)
					with the round speech-bubble icon; it is never only at the end of a
					page (decision 59).
				</Fixed>
				<Choices>
					<Choice
						name="Today (current)"
						width="w-[800px]"
						note="The pill is fixed bottom-right above the tab bar, where it is now. On Home, scrolled to the list, it sits over the Childcare row's amount. In Settings it sits over Move down, at the foot of the open Gas row."
					>
						<div class="flex min-w-0 max-w-full flex-wrap items-start gap-4">
							<Shot caption="Home, scrolled to the Budget list">
								<ScrolledHome
									label="Today (current), Home scrolled"
									overlay={floatingPill}
								/>
							</Shot>
							<Shot caption="Settings, Gas open">
								<SettingsPhone
									label="Today (current), Settings"
									fieldId="today"
									overlay={floatingPill}
								/>
							</Shot>
						</div>
						<Shot caption="The desktop, with the pill in the corner">
							<Desk label="Today (current)" floating>
								<HomeScrolledDesk />
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option A · In the top line"
						width="w-[800px]"
						note="The pill you signed off moves into the top line of every page, so it's always on the first screen and never over a number."
						cost="On a long page it's at the top, not beside your thumb."
						why="Nothing ever covers an amount or a button again."
						picked
						extra={
							<>
								Keeps decision 59's "always visible" on every page's first
								screen.
							</>
						}
					>
						<div class="flex min-w-0 max-w-full flex-wrap items-start gap-4">
							<Shot caption="Home at the top, with the pill in the top line">
								<Phone
									label="Option A, Home at the top"
									masthead={pill}
									tab="home"
								>
									{demoTop}
								</Phone>
							</Shot>
							<Shot caption="Home scrolled: nothing floats">
								<ScrolledHome label="Option A, Home scrolled" />
							</Shot>
							<Shot caption="Settings, Gas open: the pill in the top line">
								<SettingsPhone
									label="Option A, Settings"
									fieldId="option-a"
									masthead={pill}
								/>
							</Shot>
						</div>
						<Shot caption="The desktop: a second sidebar group, no pill">
							<Desk label="Option A" group>
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									band={DEMO_BAND}
								/>
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option B · In More and the sidebar"
						width="w-[800px]"
						note="Feedback moves to More and the sidebar, one tap from every page."
						extra="No pill anywhere, and nothing floats over the page at all. The 500 error page gets a terracotta 'Tell us what happened' line."
						cost="It changes decision 59 from always visible to always reachable; fewer people may notice it."
					>
						<div class="flex min-w-0 max-w-full flex-wrap items-start gap-4">
							<Shot caption="Home scrolled: nothing floats">
								<ScrolledHome label="Option B, Home scrolled" />
							</Shot>
							<Shot caption="More, with the Feedback row">
								<MoreScreen label="Option B, More">
									{moreWithFeedback}
								</MoreScreen>
							</Shot>
							<Shot caption="Settings, Gas open: nothing floats">
								<SettingsPhone label="Option B, Settings" fieldId="option-b" />
							</Shot>
						</div>
						<Shot caption="The desktop: the sidebar's second group">
							<Desk label="Option B" group>
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									band={DEMO_BAND}
								/>
							</Desk>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>

			<Specimen
				id="p124-first-visit"
				title="P124 · What a first visit shows and teaches"
				tier="visual"
				sentence="A first visit shows the demo's Home, How Tally works and, for the family, a Home with no budgets. Pick what it shows and teaches. Each option is drawn as those screens. The family's first Home: the figure in ink (today), a dash (B), a blank ledger line (A) or Your first page (C)."
			>
				<Fixed>
					anything onboarding teaches stays reachable later (How Tally works);
					no cookies and nothing remembered about a visitor (spec §9, §12); the
					demo resets every night; How Tally works and Why? links stay (decision
					65).
				</Fixed>
				<p class="mt-6">
					P124 A is picked for the demo's first visit; the family's first week
					is being redrawn.
				</p>
				<Choices>
					<Choice
						name="Today (current)"
						width="w-full"
						note="How this works sits under the number, Things to try sits under the Budget list, and How Tally works opens with How it's built. A family with no budgets sees −$2,140 in ink, since #519."
					>
						<Shot caption="The demo's Home: top to the Band and the first two rows">
							<Phone label="Today (current), Home top" tab="home">
								{demoTop}
							</Phone>
						</Shot>
						<Shot caption="The demo's Home, scrolled to Things to try">
							<Phone label="Today (current), Home scrolled" scrolled tab="home">
								<BudgetList rows={BUDGETS.slice(2)} heading={false} />
								{thingsPhone}
							</Phone>
						</Shot>
						<Shot caption="How Tally works, top: How it's built">
							<Phone label="Today (current), How Tally works" tab="more">
								{howTodayTop}
							</Phone>
						</Shot>
						<Shot caption="Today (after #519)">
							<Phone
								label="Today (current), the family's Home"
								demo={false}
								tab="home"
							>
								{TODAY_FAMILY}
							</Phone>
						</Shot>
					</Choice>
					<Choice
						name="Option A · The first page"
						width="w-full"
						note="Tally's story gets one opening page: the bank's lines struck through, Tally's written over them, and the total under a double rule."
						cost="A visitor who never taps Start here never sees the story; How this works moves to each page's foot."
						why="The whole idea in three lines and one total, and a new family never sees a wrong number on day one."
						picked
					>
						<Shot caption="The demo's Home: Start here in the banner, no link under the number">
							<Phone
								label="Option A, Home top"
								banner={startHereBanner}
								tab="home"
							>
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									howLink={false}
									band={DEMO_BAND}
								>
									<BudgetList rows={BUDGETS.slice(0, 2)} />
								</HomeTop>
							</Phone>
						</Shot>
						<Shot caption="The demo's Home, to its end: How this works in the footnote">
							<Phone label="Option A, Home's end" scrolled tab="home">
								<BudgetList rows={BUDGETS.slice(2)} heading={false} />
								<div class="mt-8">
									<div class="w-12 border-t border-muted" />
									<div class="mt-2">
										<HowLink section="budget" />
									</div>
								</div>
							</Phone>
						</Shot>
						<Shot caption="How Tally works, its start: the story">
							<Phone label="Option A, How Tally works, the story" tab="more">
								{storyHead}
							</Phone>
						</Shot>
						<Shot caption="How Tally works, the total and the things to try">
							<Phone label="Option A, How Tally works, the total" tab="more">
								{storyTotal}
							</Phone>
						</Shot>
						<Shot caption="The family's Home before any budget is set">
							<Phone
								label="Option A, the family's Home"
								demo={false}
								tab="home"
							>
								<FamilyHome
									amount={blankLine}
									status="This fills in once your budgets are set."
									howLink={false}
								/>
							</Phone>
						</Shot>
						<Shot caption="The family's How Tally works: three steps">
							<Phone
								label="Option A, the family's How Tally works"
								demo={false}
								tab="more"
							>
								{familySteps}
							</Phone>
						</Shot>
						<Shot caption="The desktop: the demo's Home">
							<Desk label="Option A, the demo's Home">
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									howLink={false}
									band={DEMO_BAND}
								>
									<BudgetList rows={BUDGETS.slice(0, 2)} />
								</HomeTop>
							</Desk>
						</Shot>
					</Choice>
					<Choice
						name="Option B · One next step"
						width="w-full"
						note="There's only ever one thing to do, in the same tinted row Home already has. A new family sets every budget in one go, from what they really spend."
						cost="Starting budgets from last month is a new feature (spec and decision needed)."
					>
						<Shot caption="The demo's Home: Things to try in the banner, How this works in muted words">
							<Phone
								label="Option B, Home top"
								banner={thingsBanner}
								tab="home"
							>
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									howLink={quietHowLink}
									band={DEMO_BAND}
								>
									<BudgetList rows={BUDGETS.slice(0, 2)} />
								</HomeTop>
							</Phone>
						</Shot>
						<Shot caption="How Tally works opens with Things to try">
							<Phone label="Option B, How Tally works" tab="more">
								<h2 class="font-serif text-3xl font-semibold">Things to try</h2>
								<ul class="mt-3 divide-y divide-rule border-y border-rule">
									{THINGS.map((t) => (
										<li class="py-3">
											<a
												href={t.href}
												class="inline-flex min-h-11 items-center"
											>
												{t.label}
											</a>
											<p class="text-sm text-muted">{t.line}</p>
										</li>
									))}
								</ul>
								<p class="mt-4 text-muted">
									Everything resets every night, so try anything.
								</p>
							</Phone>
						</Shot>
						<Shot caption="The family's Home before budgets: one next step">
							<Phone
								label="Option B, the family's Home"
								demo={false}
								tab="home"
							>
								{familyBehind}
							</Phone>
						</Shot>
						<Shot caption="Start from September: the sheet the step opens. Drawn with five of the 14 categories.">
							<Phone label="Option B, starting budgets" demo={false} tab="home">
								<Sheet behind={familyBehind} top="top-40">
									{startSheet}
								</Sheet>
							</Phone>
						</Shot>
					</Choice>
					<Choice
						name="Option C · The page total"
						width="w-full"
						note="A ledger sums up at the foot of the page: Tally's own mark, one stroke for each thing it did, crossed through to the total. The demo shows what Tally did for the family, in Tally's own mark."
						cost="Adds a second link style (pencil notes) to the design language."
					>
						<Shot caption="The demo's Home, at its foot: The Riveras' tally">
							<Phone label="Option C, Home's foot" scrolled tab="home">
								{tallyFoot}
							</Phone>
						</Shot>
						<Shot caption="The demo's Home, top: How this works as a pencil note">
							<Phone label="Option C, Home top" tab="home">
								<HomeTop
									amount={<Amount>{money(124000)}</Amount>}
									status={DEMO_STATUS}
									howLink={pencil}
									band={DEMO_BAND}
								>
									<BudgetList rows={BUDGETS.slice(0, 2)} />
								</HomeTop>
							</Phone>
						</Shot>
						<Shot caption="How Tally works, top: Budget and safe to spend first">
							<Phone label="Option C, How Tally works" tab="more">
								<h1 class={TITLE}>How Tally works</h1>
								<p class="mt-4 text-lg">
									Tally is a small family budgeting app. One server builds every
									page and a database keeps the numbers.
								</p>
								<section class="mt-8">
									<h2 class="font-serif text-3xl font-semibold">
										Budget and safe to spend
									</h2>
									<p class="mt-2 text-muted">
										What's left of the month after bills and savings.
									</p>
								</section>
							</Phone>
						</Shot>
						<Shot caption="How Tally works, its end: How it's built, last">
							<Phone label="Option C, How it's built, last" tab="more">
								<section>
									<h2 class="font-serif text-3xl font-semibold">
										How it's built
									</h2>
									<p class="mt-2 text-muted">
										Pages, a database, and the code that does the math, each in
										one place.
									</p>
								</section>
							</Phone>
						</Shot>
						<Shot caption="The family's first page, before budgets">
							<Phone
								label="Option C, the family's first page"
								demo={false}
								tab="home"
							>
								{firstPage}
							</Phone>
						</Shot>
					</Choice>
				</Choices>
			</Specimen>
		</>
	);
}

/** Home's top on the desktop, with the Budget list (P123's desktop picture). */
function HomeScrolledDesk() {
	return (
		<HomeTop
			month={true}
			amount={<Amount>{money(124000)}</Amount>}
			status={DEMO_STATUS}
			band={DEMO_BAND}
		>
			<BudgetList rows={BUDGETS.slice(0, 1)} />
		</HomeTop>
	);
}
