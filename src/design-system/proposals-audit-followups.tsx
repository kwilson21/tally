// P137 and P138 (#644 and #645): the two follow-ups of the second design audit (HW2 and PL3 in
// docs/design-system/audit-2026-10.md), each option drawn as the screens it changes. The owner picked A for both (decision 126).
// These drawings stay as the build reference until #644 and #645 ship. P139 (#660, SP2 in the same audit) is picked:
// option A, the owner's pick of decision 131. Every picture is
// inert and labelled, like the rest of the page. The Budget diagram, the example, the folded rows, the payment chips and the
// Button are the app's own views; the rules are How Tally works' words (src/routes/how-it-works.tsx). The numbers are the
// demo's on Oct 16, read from its own pages: /how-it-works (the October budget, 10 transactions that need a category) and
// /plans/1 (Lawn service, $90, and its payment candidates). Pictures are drawn at their full height, so none is cut.

import type { Child } from "hono/jsx";
import { type SetupView, setupSteps } from "../first-tally/setup";
import type { YourBank } from "../first-tally/your-banks";
import { FORECAST_START_DAY } from "../home-forecast";
import { budgetExample } from "../how-it-works/examples";
import { formatCents } from "../money";
import { TallyMark, Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { CategoryGrid } from "../views/category-grid";
import { Chip } from "../views/chip";
import { FoldedRow } from "../views/folded-row";
import { HomeSetup } from "../views/home-setup";
import { BudgetDiagram } from "../views/how-diagrams";
import { Icon } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { type NavKey, SIDEBAR_ITEMS } from "../views/nav";
import { SplitLine } from "../views/split-form";
import { type StepLine, TallySteps } from "../views/tally-steps";
import { Choice, Choices, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// The screens: a phone's and a desktop window's first screen, as tall as their content, so a whole section or picker
// is drawn at full height. Each is one labelled image with nothing inside to Tab to, like the others on the page.

/** A phone screen at 390 px, the demo banner on top, as tall as what it holds. `overlay` is drawn over the whole screen, as Phone's is. */
function PhoneScreen({
	label,
	overlay,
	children,
}: {
	label: string;
	overlay?: Child;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on a phone`}
				class="relative w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<div data-screen="picture">
						<p class="bg-band py-2 text-center text-sm text-muted">
							Demo data. Nothing here is real.
						</p>
						<div class="px-5 pt-6 pb-6">
							<div class="mb-4">
								<Wordmark />
							</div>
							{children}
						</div>
						{overlay}
					</div>
				</div>
			</div>
		</div>
	);
}

/** A desktop sidebar link's classes: accent when it is the page's own, ink otherwise, the same for every link in the sidebar. */
const sidebarLink = (current: boolean) =>
	`flex min-h-11 items-center gap-3 rounded-control px-2 text-lg no-underline ${current ? "text-accent" : "text-ink"}`;

/** A desktop window at 1280 px as the proposals draw it: the sidebar, then the page, as tall as its content. */
function DeskScreen({
	label,
	active,
	children,
}: {
	label: string;
	active?: NavKey;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on desktop`}
				class="relative w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<div data-screen="picture">
						<div class="flex items-start gap-6 px-6 py-6">
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
													class={sidebarLink(item.key === active)}
												>
													<Icon name={item.icon} />
													{item.label}
												</a>
											</li>
										))}
									</ul>
									<ul class="mt-3 flex flex-col gap-1 border-t border-rule pt-3">
										<li>
											<a
												href="/how-it-works"
												class={sidebarLink(active === "how")}
											>
												<TallyMark class="size-6" />
												How Tally works
											</a>
										</li>
										<li>
											<a
												href="/feedback"
												class={sidebarLink(active === "feedback")}
											>
												<Icon name="message" />
												Feedback
											</a>
										</li>
									</ul>
								</nav>
							</aside>
							<main class="min-w-0 flex-1">{children}</main>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * One state of an option at both sizes: the phone's screen at 390 px, then the desktop window at 1280 px, each with its
 * caption. `render` is called once per size, with an id for the drawing's own ids (a Budget diagram needs one of its own).
 */
function Pictures({
	id,
	label,
	state = "",
	active,
	render,
}: {
	id: string;
	label: string;
	/** The state the pictures show, in words, for their captions (Closed, Opened); none for a picture that has no state. */
	state?: string;
	active?: NavKey;
	render: (id: string) => Child;
}) {
	const caption = (size: number) =>
		state ? `${state}, at ${size} px` : `At ${size} px`;
	return (
		<>
			<Shot caption={caption(390)}>
				<PhoneScreen label={`${label} at 390 px`}>
					{render(`${id}-390`)}
				</PhoneScreen>
			</Shot>
			<Shot caption={caption(1280)}>
				<DeskScreen label={`${label} at 1280 px`} active={active}>
					{render(`${id}-1280`)}
				</DeskScreen>
			</Shot>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P137: How Tally works' Budget and safe to spend section, with its eight rules as a list, folded shut, or folded open.

/** The demo's October budget on Oct 16, as How Tally works' diagram draws it: Budget − Spent − Bills due − Planned = Safe to spend. */
const BUDGET = {
	totalBudgetCents: 435000,
	totalSpentCents: 190531,
	safeToSpendCents: 111220,
	savingsGoalCents: 0,
	plannedCents: 27000,
};

/**
 * The example's inputs: the same budget, with the 10 transactions that need a category ($104.54), nothing unbudgeted and
 * $1,062.49 of bills due. budgetExample writes "In the demo for October" from these, as the route does.
 */
const BUDGET_EXAMPLE = {
	...BUDGET,
	uncategorized: { spentCents: 10454, count: 10 },
	unbudgetedCents: 0,
	billsDueCents: 106249,
};

/** The eight Budget rules in the route's words (the Budget section's first list). Each one is named for option B. */
const RULES: { name: string; words: string }[] = [
	{
		name: "Budget.",
		words:
			"A category's budget for a month is its latest amount set on or before that month.",
	},
	{
		name: "Spent.",
		words:
			"Spent is the sum of the month's counted transactions in that category; refunds reduce it.",
	},
	{ name: "Left.", words: "Left is budget minus spent." },
	{
		name: "Income.",
		words: "Income counts only toward Income, not spending.",
	},
	{
		name: "Cash.",
		words:
			"Cash transactions count in spending, but Cash is not part of net worth.",
	},
	{
		name: "Safe to spend.",
		words:
			"Safe to spend is the whole month's budget, minus all counted spending (including uncategorized and unbudgeted), minus this month's bills that are due or overdue and not yet paid, minus the full monthly savings goal from the 1st, and minus planned one-time expenses.",
	},
	{
		name: "Planned.",
		words:
			"A planned one-time expense is set aside for its whole month, and one from an earlier month stays set aside until it is paid, moved or dropped; once a payment is linked on Bills, it stops being set aside.",
	},
	{
		name: "Daily amount.",
		words: `Before day ${FORECAST_START_DAY}, Home shows the daily amount: Safe to spend divided by the days left, today included, with any partial cent left out. From day ${FORECAST_START_DAY}, it shows the month-end forecast.`,
	},
];

/** The fold's summary for option A, and for option B, which names what the rules cover (the same words, one line). */
const FOLD_A = "The exact rules";
const FOLD_B =
	"The exact rules: budget, spent, left, income, cash, Safe to spend, planned, daily amount";

/** The eight rules as the route's list draws them; named puts each rule's name in semibold before its words. */
function RuleList({ named }: { named: boolean }) {
	return (
		<ul class="mt-3 list-disc space-y-1 pl-5">
			{RULES.map((rule) => (
				<li>
					{named && <span class="font-semibold">{rule.name}</span>}
					{named ? " " : null}
					{rule.words}
				</li>
			))}
		</ul>
	);
}

/**
 * The Budget and safe to spend section, then the Bills section below it so the page's rhythm shows. The rules are drawn as
 * a list (today), or folded under the diagram and the example, shut or open (A and B), so the picture and the numbers answer first.
 */
function BudgetSection({
	id,
	fold,
	named = false,
}: {
	id: string;
	fold: "list" | "closed" | "open";
	/** Option B: the fold names the rules, and each opened rule starts with its name. */
	named?: boolean;
}) {
	return (
		<>
			<div class="mt-10">
				<h3 class="font-serif text-3xl font-semibold">
					Budget and safe to spend
				</h3>
				<p class="mt-2">
					Home shows how much of this month's budget is left, for each category
					and in total.
				</p>
				{fold === "list" && <RuleList named={false} />}
				<div class="mt-4">
					<BudgetDiagram id={id} {...BUDGET} />
				</div>
				<p class="mt-3 bg-band px-4 py-3">
					<span class="font-semibold">In the demo for October: </span>
					{budgetExample(BUDGET_EXAMPLE)}
				</p>
				{fold !== "list" && (
					<div class="mt-3">
						<FoldedRow
							label={named ? FOLD_B : FOLD_A}
							value={
								named ? undefined : <span class="text-muted">8 rules</span>
							}
							open={fold === "open"}
						>
							<RuleList named={named} />
						</FoldedRow>
					</div>
				)}
			</div>
			<div class="mt-10">
				<h3 class="font-serif text-3xl font-semibold">Bills</h3>
				<p class="mt-2">
					Tally matches each bill occurrence to one payment, while you stay in
					control of every link. A bill paid in parts takes more: you link each
					extra payment by hand, and the month is Paid once they reach 90% of
					its amount.
				</p>
				<p class="mt-3">Bills puts each active bill in one of four groups:</p>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P138: a plan's own page (/plans/1, Lawn service, $90) at its payment picker.

type Candidate = {
	id: number;
	name: string;
	date: string;
	cents: number;
	excluded?: boolean;
};

/**
 * The demo's payment candidates for Lawn service on Oct 16, in the order the picker lists them: planPaymentCandidates sorts
 * by the amount's distance from $90, then date, then id (src/db/planned-expenses.ts). The ids are the demo seed's.
 */
const CANDIDATES: Candidate[] = [
	{ id: 98, name: "Mario's Pizza", date: "Oct 13", cents: 10630 },
	{ id: 97, name: "Olive Garden", date: "Oct 10", cents: 11280 },
	{ id: 94, name: "Trader Joe's", date: "Oct 1", cents: 6410 },
	{ id: 102, name: "Chevron", date: "Oct 14", cents: 4950 },
	{ id: 101, name: "Shell", date: "Oct 5", cents: 4820 },
	{ id: 96, name: "Chipotle", date: "Oct 8", cents: 3840 },
	{ id: 122, name: "Farmers market", date: "Oct 16", cents: 2000 },
	{ id: 148, name: "Netflix", date: "Oct 15", cents: 1799 },
	{ id: 118, name: "CVS", date: "Oct 14", cents: 1643 },
	{ id: 121, name: "Doordash taco", date: "Oct 16", cents: 1508 },
	{ id: 113, name: "Venmo j rivera", date: "Oct 6", cents: 1500 },
	{ id: 110, name: "Local Bakery", date: "Oct 16", cents: 1200 },
	{ id: 115, name: "Amazon", date: "Oct 10", cents: 999 },
	{ id: 111, name: "Xyzshop", date: "Oct 3", cents: 899 },
	{ id: 114, name: "Corner deli", date: "Oct 8", cents: 825 },
	{ id: 112, name: "Farmers mkt", date: "Oct 5", cents: 700 },
	{ id: 116, name: "Craftsupply", date: "Oct 11", cents: 680 },
	{ id: 95, name: "Blue Bottle Coffee", date: "Oct 3", cents: 650 },
	{ id: 117, name: "City parking", date: "Oct 13", cents: 500 },
	{
		id: 126,
		name: "Transfer to Savings",
		date: "Oct 2",
		cents: 50000,
		excluded: true,
	},
];

/** The closest few the rows show; the rest sit inside "Show all", in the same order. */
const CLOSEST = 5;

/** The picker's chip text, as PlanPaymentPicker writes it: name, date, amount, and Excluded for an excluded payment. */
const chipText = (c: Candidate) =>
	`${c.name} · ${c.date} · ${formatCents(c.cents)}${c.excluded ? " · Excluded" : ""}`;

/** The announced count of a search's results, in words. */
const countSentence = (n: number) =>
	n === 0
		? "No charges match"
		: `${n} ${n === 1 ? "charge matches" : "charges match"}`;

/** One payment as a 44px radio label, with the look of TransactionRow: name and date, the amount in tabular figures. */
function PaymentRow({ c, index }: { c: Candidate; index: number }) {
	return (
		<label class="group relative flex min-h-11 cursor-pointer items-center gap-4 py-2 text-ink has-[:focus-visible]:[&_.selection-mark]:outline-2 has-[:focus-visible]:[&_.selection-mark]:outline-offset-2 has-[:focus-visible]:[&_.selection-mark]:outline-accent">
			<input
				type="radio"
				name="transaction_id"
				value={String(c.id)}
				class="peer sr-only"
				// Nothing is chosen for the person; one required radio makes the group required.
				required={index === 0}
			/>
			<span
				aria-hidden="true"
				class="selection-mark flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band"
			>
				<span class="hidden group-has-[:checked]:flex">
					<Icon name="check" class="size-4" />
				</span>
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{c.name}</span>
				<span class="block truncate leading-6 text-muted">
					{c.date}
					{c.excluded ? " · Excluded" : ""}
				</span>
			</span>
			<span class="shrink-0 text-lg tabular-nums">{formatCents(c.cents)}</span>
		</label>
	);
}

/**
 * The plan's page above its Link a payment section, drawn by hand: PlanPaymentPicker's `<h2 id="plan-link-title">` (and its
 * section's aria-labelledby) is a fixed id that would repeat in every one of these pictures, which the page's unique-ID test
 * forbids. Its markup and classes are copied from src/routes/plans.tsx and src/views/planned-expense.tsx, so the picture matches /plans.
 */
function PlanPage({ children }: { children?: Child }) {
	return (
		<>
			<a href="/bills" class="inline-flex min-h-11 items-center text-accent">
				Bills
			</a>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Lawn service
			</h1>
			<p class="text-lg">{formatCents(9000)} · Set aside for October</p>
			<div class="mt-6 border-t border-rule pt-4">
				<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
				<p class="mt-2 text-lg">To Lawn service, {formatCents(9000)}.</p>
				<p class="mt-1 text-muted">
					Money out in the planned expense's month and the next, closest amount
					first.
				</p>
				{children}
			</div>
		</>
	);
}

/** The payment's button, as the picker draws it. */
function LinkButton() {
	return (
		<div>
			<Button type="submit" busyLabel="Linking…">
				Link payment
			</Button>
		</div>
	);
}

/** Today: every charge as a radio chip, as the plan page draws it now. */
function TodayPicker() {
	return (
		<PlanPage>
			<div class="mt-4 flex flex-col gap-3">
				<fieldset>
					<legend>Payment</legend>
					<div class="mt-1 flex flex-col gap-2">
						{CANDIDATES.map((c, index) => (
							<Chip
								type="radio"
								name="transaction_id"
								value={String(c.id)}
								required={index === 0}
							>
								{chipText(c)}
							</Chip>
						))}
					</div>
				</fieldset>
				<LinkButton />
			</div>
		</PlanPage>
	);
}

/** A: the closest five as rows, then Show all, folded shut or open. */
function ClosestRows({ open }: { open: boolean }) {
	const rest = CANDIDATES.slice(CLOSEST);
	return (
		<PlanPage>
			<div class="mt-4 flex flex-col gap-3">
				<fieldset>
					<legend>Payment</legend>
					<div class="mt-1">
						{CANDIDATES.slice(0, CLOSEST).map((c, index) => (
							<PaymentRow c={c} index={index} />
						))}
						<FoldedRow
							label={`Show all ${CANDIDATES.length} charges`}
							open={open}
						>
							{rest.map((c, index) => (
								<PaymentRow c={c} index={index + CLOSEST} />
							))}
						</FoldedRow>
					</div>
				</fieldset>
				<LinkButton />
			</div>
		</PlanPage>
	);
}

/**
 * B: a labelled search over every charge, its count announced, and the closest five when nothing is typed. `id` prefixes the
 * picture's own ids: the results fieldset is the search's target, and the count is refreshed by the same reply's hx-select-oob.
 */
function SearchRows({ id, query }: { id: string; query: string }) {
	const q = query.trim().toLowerCase();
	const matches = q
		? CANDIDATES.filter(
				(c) =>
					c.name.toLowerCase().includes(q) || formatCents(c.cents).includes(q),
			)
		: CANDIDATES.slice(0, CLOSEST);
	const announced = q
		? countSentence(matches.length)
		: `Showing the closest ${CLOSEST} of ${CANDIDATES.length} charges`;
	return (
		<PlanPage>
			<div class="mt-4 flex flex-col gap-3">
				<label class="flex flex-col gap-1">
					<span>Find a charge by store or amount</span>
					<input
						type="search"
						name="q"
						value={query}
						class="min-h-11 rounded-control border border-ink bg-paper px-3 text-lg"
						hx-get="/plans/1/payments/search"
						hx-target={`#${id}-payment-results`}
						hx-select-oob={`#${id}-payment-count:innerHTML`}
						hx-swap="innerHTML"
					/>
				</label>
				{/* The count stays outside the swap, so screen readers announce each new count; the reply's hx-select-oob refreshes its words, as Transactions' result count does. */}
				<p
					id={`${id}-payment-count`}
					aria-live="polite"
					class="text-sm text-muted"
				>
					{announced}
				</p>
				<fieldset id={`${id}-payment-results`}>
					<legend>Payment</legend>
					<div class="mt-1">
						{matches.map((c, index) => (
							<PaymentRow c={c} index={index} />
						))}
					</div>
				</fieldset>
				{matches.length > 0 && <LinkButton />}
			</div>
		</PlanPage>
	);
}

// ---------------------------------------------------------------------------------------------
// The section: P137 and P138 with their options, each drawn at 390 and 1280 px.

/** The follow-ups of the second audit, A picked for both (decision 126): P137 (How Tally works' rules fold, #644) and P138 (the payment list, #645). */
export function AuditFollowupProposals() {
	return (
		<>
			<Specimen
				id="p137-rules-fold"
				title="P137 · How Tally works: the exact rules fold"
				tier="visual"
				sentence="The Budget and safe to spend section of How Tally works, today and with its eight rules folded under the picture, at 390 and 1280 px."
			>
				<Choices>
					<Choice
						name="Today"
						note="A Why? lands here and meets eight rules before the picture. On a phone the page is 14,456px today."
						width="w-[1140px]"
					>
						<Pictures
							id="p137-today"
							active="how"
							label="Today"
							render={(id) => <BudgetSection id={id} fold="list" />}
						/>
					</Choice>
					<Choice
						name="A · The rules fold under the picture"
						note="The picture and your own numbers answer first; the spec's words are one tap away. On a phone the page is 14,456px today, and about 13,829px with the fold closed (estimated)."
						cost="One details per section, nine in all; no words change."
						why="Since P130 A every Why? lands on a section, so its first lines have to answer."
						picked
						width="w-[1140px]"
					>
						<Pictures
							id="p137-a-closed"
							active="how"
							label="A · The rules fold under the picture, closed"
							state="Closed"
							render={(id) => <BudgetSection id={id} fold="closed" />}
						/>
						<Pictures
							id="p137-a-open"
							active="how"
							label="A · The rules fold under the picture, opened"
							state="Opened"
							render={(id) => <BudgetSection id={id} fold="open" />}
						/>
					</Choice>
					<Choice
						name="B · Each rule named, folded"
						note="The fold says what's inside before it's opened. On a phone the page is 14,456px today, and about 13,869px with the fold closed (estimated)."
						cost="A short name for each of about 45 rules, kept beside the spec's words."
						why="Someone after one rule finds it without reading eight."
						recommended={false}
						width="w-[1140px]"
					>
						<Pictures
							id="p137-b-closed"
							active="how"
							label="B · Each rule named, folded, closed"
							state="Closed"
							render={(id) => (
								<BudgetSection id={id} fold="closed" named={true} />
							)}
						/>
						<Pictures
							id="p137-b-open"
							active="how"
							label="B · Each rule named, folded, opened"
							state="Opened"
							render={(id) => (
								<BudgetSection id={id} fold="open" named={true} />
							)}
						/>
					</Choice>
				</Choices>
			</Specimen>
			<Specimen
				id="p138-payment-list"
				title="P138 · Link a payment: the closest few as rows"
				tier="visual"
				sentence={
					"A plan's own page, /plans/1 (Lawn service, $90), at its payment picker, at 390 and 1280 px."
				}
			>
				<Choices>
					<Choice
						name="Today"
						note="20 chips, 1,680px on a phone, as the page draws them now."
						width="w-[1140px]"
					>
						<Pictures
							id="p138-today"
							active="bills"
							label="Today"
							render={() => <TodayPicker />}
						/>
					</Choice>
					<Choice
						name="A · The closest five as rows, then Show all"
						note="The likely payment is in the first five; the rest are one tap away."
						cost="The picker's rows reuse TransactionRow's look; one details; no new route. A bill's picker keeps “You said not this one” last, inside the fold."
						why="A list of 20 chips hides the one that matches; rows read like Transactions."
						picked
						width="w-[1140px]"
					>
						<Pictures
							id="p138-a-closed"
							active="bills"
							label="A · The closest five as rows, then Show all, closed"
							state="Closed"
							render={() => <ClosestRows open={false} />}
						/>
						<Pictures
							id="p138-a-open"
							active="bills"
							label="A · The closest five as rows, then Show all, opened"
							state="Opened"
							render={() => <ClosestRows open={true} />}
						/>
					</Choice>
					<Choice
						name="B · The closest five, and a search over all of them"
						note="Look it up when it isn't in the first five: typing farmers finds the two Farmers charges, Oct 16 and Oct 5."
						cost="One search route over the same charges, asked a moment after typing stops, and the count announced."
						why="Faster than scrolling when the charge is far from the amount."
						recommended={false}
						width="w-[1140px]"
					>
						<Pictures
							id="p138-b-empty"
							active="bills"
							label="B · The closest five, and a search over all of them, empty"
							state="Empty"
							render={(id) => <SearchRows id={id} query="" />}
						/>
						<Pictures
							id="p138-b-farmers"
							active="bills"
							label="B · The closest five, and a search over all of them, after typing farmers"
							state="After typing farmers"
							render={(id) => <SearchRows id={id} query="farmers" />}
						/>
					</Choice>
				</Choices>
				<p class="text-sm text-muted">
					A bill's Link a payment opens the same list, so it changes the same
					way.
				</p>
			</Specimen>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P139 (#660, SP2): how each part of a split picks its category. Each picture is the split sheet for the demo's
// Local Bakery ($12.00, SQ *LOCAL BAKERY 4432), drawn as the sheet is: the app's own SplitLine, MoneyInput, CategoryGrid
// and FoldedRow, with the Transactions page dimmed behind it. Nothing in a picture posts or swaps: no htmx attribute.

/** The demo's seven categories, with the icon and colour the seed gives each (src/demo/seed.ts). */
const SPLIT_CATEGORIES = [
	{ id: 1, name: "Groceries", icon: "groceries", color: "cat-blue" },
	{ id: 2, name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	{ id: 3, name: "Gas", icon: "gas", color: "cat-slate" },
	{ id: 4, name: "Kids", icon: "kids", color: "cat-ochre" },
	{ id: 5, name: "Household", icon: "household", color: "cat-brown" },
	{ id: 6, name: "Childcare", icon: "kids", color: "cat-blue" },
	{ id: 7, name: "Rent", icon: "household", color: "cat-ochre" },
];

type SplitPart = { categoryId: number | null; amount: string };
/** Today's select, A's folded row, or B's grid, for each part's category. */
type PartMode = "select" | "folded" | "grid";

/** The split as it opens: both parts empty, as the split form opens a new split. */
const AS_IT_OPENS: SplitPart[] = [
	{ categoryId: null, amount: "" },
	{ categoryId: null, amount: "" },
];

/** After Part 1's pick: Groceries at $5.00, and Part 2 at $7.00 still choosing its category. */
const AFTER_PART_ONE: SplitPart[] = [
	{ categoryId: 1, amount: "5.00" },
	{ categoryId: null, amount: "7.00" },
];

/** The Transactions page behind the sheet, dimmed in both pictures: its title and the Local Bakery row. */
function SplitBehind() {
	return (
		<>
			<p class="font-serif text-3xl font-semibold tracking-tight">
				Transactions
			</p>
			<div class="mt-4 flex items-center justify-between gap-3 border-t border-rule py-3 text-lg">
				<span>Local Bakery</span>
				<span class="tabular-nums">$12.00</span>
			</div>
		</>
	);
}

/** One part: its category as a native select, a folded row or a grid, then its amount, in the order each mode draws them. */
function SplitPartRow({
	id,
	index,
	mode,
	part,
}: {
	id: string;
	index: number;
	mode: PartMode;
	part: SplitPart;
}) {
	const n = index + 1;
	const name = `${id}-part-${index}`;
	const chosen = SPLIT_CATEGORIES.find((cat) => cat.id === part.categoryId);
	const amount = (
		<MoneyInput
			id={`${id}-part-amount-${index}`}
			name="part_amount"
			label={`Part ${n} amount`}
			value={part.amount}
		/>
	);
	return (
		<div
			class={`flex flex-col gap-2 ${index ? "border-t border-rule pt-3" : ""}`}
		>
			{mode === "select" && (
				<>
					<label for={`${id}-part-category-${index}`} class="sr-only">
						Part {n} category
					</label>
					<select
						id={`${id}-part-category-${index}`}
						name="part_category"
						class="min-h-11 rounded-full border border-rule bg-paper px-3"
					>
						<option value="">Pick a category</option>
						{SPLIT_CATEGORIES.map((cat) => (
							<option
								value={String(cat.id)}
								selected={cat.id === part.categoryId}
							>
								{cat.name}
							</option>
						))}
					</select>
					{amount}
				</>
			)}
			{mode === "folded" && (
				<>
					<FoldedRow
						label={`Part ${n} category`}
						open={!chosen}
						value={
							chosen && (
								<>
									<CategoryIcon icon={chosen.icon} color={chosen.color} />
									<span class="truncate text-lg">{chosen.name}</span>
								</>
							)
						}
					>
						<CategoryGrid
							categories={SPLIT_CATEGORIES}
							name={name}
							checkedId={part.categoryId}
						/>
					</FoldedRow>
					{amount}
				</>
			)}
			{mode === "grid" && (
				<>
					{amount}
					<fieldset class="flex flex-col gap-2">
						<legend class="text-sm text-muted">Part {n} category</legend>
						<CategoryGrid
							categories={SPLIT_CATEGORIES}
							name={name}
							checkedId={part.categoryId}
						/>
					</fieldset>
				</>
			)}
		</div>
	);
}

/** The sheet's content, as SplitForm draws it: the bank's text, the name, the total, the day, the live line, the parts, the buttons. */
function SplitSheetBody({
	id,
	mode,
	parts,
}: {
	id: string;
	mode: PartMode;
	parts: SplitPart[];
}) {
	return (
		<div data-split-sheet="">
			<p class="text-sm text-muted">SQ *LOCAL BAKERY 4432</p>
			<p class="font-serif text-4xl font-semibold">Local Bakery</p>
			<p class="font-serif text-4xl font-semibold tabular-nums">$12.00</p>
			<p class="text-muted">Oct 16</p>
			<div class="mt-4 flex flex-col gap-4 border-t border-rule pt-4">
				<div class="flex items-center justify-between gap-3">
					<div id={`${id}-split-line`} aria-live="polite">
						<SplitLine
							parentCents={1200}
							amounts={parts.map((part) => part.amount)}
						/>
					</div>
					<Button kind="text" type="button">
						Add a part
					</Button>
				</div>
				{parts.map((part, index) => (
					<SplitPartRow id={id} index={index} mode={mode} part={part} />
				))}
				<div class="grid grid-cols-2 gap-3">
					<Button kind="secondary" type="button" class="w-full">
						Cancel
					</Button>
					<Button type="button" class="w-full">
						Save split
					</Button>
				</div>
			</div>
		</div>
	);
}

/** A phone's picture: the Transactions strip behind, dimmed, and the sheet in flow below it, the full width of the screen. */
function SplitPhone({
	label,
	id,
	mode,
	parts,
}: {
	label: string;
	id: string;
	mode: PartMode;
	parts: SplitPart[];
}) {
	return (
		<PhoneScreen
			label={label}
			overlay={<div class="absolute inset-0 bg-ink/30" />}
		>
			<div class="relative h-36 overflow-hidden">
				<SplitBehind />
			</div>
			<div class="relative z-10 -mx-5 -mb-6 rounded-t-sheet bg-paper p-5">
				<SplitSheetBody id={id} mode={mode} parts={parts} />
			</div>
		</PhoneScreen>
	);
}

/** A 1280 picture: the sheet as BottomSheet's right panel, 28rem wide, over the full-width Transactions page, dimmed where the panel isn't. */
function SplitDesk({
	label,
	id,
	mode,
	parts,
}: {
	label: string;
	id: string;
	mode: PartMode;
	parts: SplitPart[];
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on desktop`}
				class="relative w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					{/* One cell holds the page, its dimming and the panel, so the picture is as tall as the sheet and the page
					keeps its full width; the panel sits over the page at the right, as BottomSheet's does. */}
					<div data-screen="picture" class="grid">
						<div class="col-start-1 row-start-1 px-8 pt-8">
							<SplitBehind />
						</div>
						<div class="col-start-1 row-start-1 bg-ink/30" />
						<div class="col-start-1 row-start-1 w-[28rem] justify-self-end rounded-l-sheet bg-paper p-5">
							<SplitSheetBody id={id} mode={mode} parts={parts} />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** One state of an option at both sizes, each captioned with its state: as it opens, or after Part 1's pick. */
function SplitPictures({
	id,
	label,
	state,
	mode,
	parts,
}: {
	/** The picture's own id; each size's ids are prefixed with it, so every id and radio name is unique. */
	id: string;
	label: string;
	state: string;
	mode: PartMode;
	parts: SplitPart[];
}) {
	return (
		<>
			<Shot caption={`${state}, at 390 px`}>
				<SplitPhone
					label={`${label} at 390 px`}
					id={`${id}-390`}
					mode={mode}
					parts={parts}
				/>
			</Shot>
			<Shot caption={`${state}, at 1280 px`}>
				<SplitDesk
					label={`${label} at 1280 px`}
					id={`${id}-1280`}
					mode={mode}
					parts={parts}
				/>
			</Shot>
		</>
	);
}

/** P139 (#660): how each part of a split picks its category, three ways, drawn for the owner's pick. */
export function SplitCategoryProposal() {
	return (
		<Specimen
			id="p139-split-category"
			title="P139 · How each part of a split picks its category"
			tier="visual"
			sentence="The split form for the demo's Local Bakery ($12.00), with each part's category picked three ways, at 390 and 1280 px."
		>
			<Choices>
				<Choice
					name="Today"
					note="Each part's category is a native select that reads “Pick a category” until a person chooses one, as the split form draws it now. Every other category pick in Tally is chips or a grid; this is the only select that sets a category. A guessed part, on a mixed trip, would show its select dashed; the demo has no mixed trip, so none is drawn. The sheet's content is 670px after Part 1's pick at 390px, measured on the drawing; the real sheet scrolls past 90% of the screen."
					width="w-[1140px]"
				>
					<SplitPictures
						id="p139-today"
						label="Today"
						state="After Part 1's pick"
						mode="select"
						parts={AFTER_PART_ONE}
					/>
				</Choice>
				<Choice
					name="A · A folded category row per part"
					note="Each part's category is a row labelled “Part 1 category” and “Part 2 category”, as the edit panel's category row is. Opened, it holds the two-column grid of categories; a part with a category folds to one line, its icon and name. Each part reads like the edit panel: a chosen category folds to one line. As it opens, both rows are open. After Part 1's pick, at the next drawing, Part 1 folds to Groceries and Part 2 stays open. A guessed part stays open, with its guessed category dashed, until a person picks. The sheet's content is 1,104px as it opens and 892px after Part 1's pick at 390px, measured on the drawing; the real sheet scrolls past 90% of the screen."
					cost="A part with nothing chosen posts nothing, so the save and the live line read each part's category by its own name instead of by position, and a guessed part's dashed look moves from the select to its chips; the row's value follows a pick only when the sheet is drawn again."
					why="One way to pick a category everywhere; a chosen part folds to one line."
					picked
					width="w-[1140px]"
				>
					<SplitPictures
						id="p139-a-open"
						label="A · A folded category row per part"
						state="As it opens"
						mode="folded"
						parts={AS_IT_OPENS}
					/>
					<SplitPictures
						id="p139-a-folded"
						label="A · A folded category row per part"
						state="After Part 1's pick"
						mode="folded"
						parts={AFTER_PART_ONE}
					/>
				</Choice>
				<Choice
					name="B · A compact grid per part"
					note="Each part shows the two-column grid of categories, always open, under its amount. Every category in sight for every part. A guessed part, on a mixed trip, would lead its grid with its guessed category, dashed. The sheet's content is 1,022px after Part 1's pick at 390px, measured on the drawing; the real sheet scrolls past 90% of the screen."
					cost="A part with nothing chosen posts nothing, so the save and the live line read each part's category by its own name; a guessed part's dashed look moves to its chips."
					why="No tap to open before choosing."
					recommended={false}
					width="w-[1140px]"
				>
					<SplitPictures
						id="p139-b"
						label="B · A compact grid per part"
						state="After Part 1's pick"
						mode="grid"
						parts={AFTER_PART_ONE}
					/>
				</Choice>
			</Choices>
		</Specimen>
	);
}

// P140 (#719, decision 133): Home's first week while two banks are read. Today is the reading phase as it was; A, the owner's
// pick, is the real HomeSetup with Your banks and Have more accounts?; B nests the banks under Link your bank. Drawn at 390 px:
// a 1280 px picture would draw HomeSetup's fixed ids a second time on this page.
const BANKS_TODAY = "2026-10-14";
const BANKS_RECORD = { strokes: { bank: "2026-10-13" }, budgets: {} };
const BANKS_CHASE: YourBank = {
	id: 3,
	name: "Chase",
	status: "ok",
	lastSyncedAt: "2026-10-14 08:00:00",
	historyCompleteAt: "2026-10-13 09:00:00",
	fresh: false,
	count: 412,
};
const BANKS_AMEX: YourBank = {
	id: 5,
	name: "American Express",
	status: "ok",
	lastSyncedAt: "2026-10-14 08:00:00",
	historyCompleteAt: null,
	fresh: true,
	count: 86,
};

/** Two banks, one reading: the status names neither bank's count, and the list and the prompt sit under it (A). */
function banksView(): SetupView {
	return {
		phase: "reading",
		drawn: 1,
		steps: setupSteps(BANKS_RECORD, "reading", "Chase", BANKS_TODAY, 2),
		bankName: "Chase",
		bankCount: 2,
		historyIn: false,
		sorting: false,
		slow: false,
		refreshes: false,
		sorted: 0,
		total: 498,
		fifth: null,
		answeredWaiting: null,
		emailed: false,
	};
}

/**
 * Today's five lines as they were drawn, frozen as literal data: the live setup's words (After sorting) must not reach this
 * picture, which stays as it was (P140's "Today" is a record, and only A draws the live HomeSetup).
 */
const BANKS_TODAY_STEPS: StepLine[] = [
	{ name: "Link your bank", done: true, note: "Chase, linked" },
	{ name: "Your pay", done: false, note: "When it's done" },
	{ name: "Your bills", done: false, note: "When it's done" },
	{ name: "Your budgets", done: false, note: "When it's done" },
	{
		name: "Tomorrow · Tally keeps count on its own",
		done: false,
		note: "Later",
	},
];

/** Today: the reading phase as it is drawn now, with one line naming neither bank, and no button. */
function BanksToday() {
	return (
		<section class="mt-2">
			<h1 class="sr-only">Your first week</h1>
			<p class="font-serif text-lg italic">
				One. Tally's reading your last 90 days. Your questions will be ready
				once it has read them all and sorted them.
			</p>
			<p class="mt-2 text-muted">Nothing for you to do until then.</p>
			<TallySteps steps={BANKS_TODAY_STEPS} />
		</section>
	);
}

/** B: the banks nested under step one, with "+ Link another bank" as an accent link. */
function BanksB() {
	return (
		<section class="mt-2">
			<h1 class="sr-only">Your first week</h1>
			<p class="font-serif text-lg italic">
				One. Tally's reading your last 90 days from 2 banks. Your questions will
				be ready once it has read them all and sorted them.
			</p>
			<div class="mt-4">
				<p class="text-sm text-muted">Your first tally · 1 of 5</p>
				<ul class="mt-2 border-t border-rule">
					<li class="flex min-h-11 flex-wrap items-center gap-3 border-b border-rule">
						<span class="min-w-0 flex-1 py-2 text-base">Link your bank</span>
						<span class="shrink-0 text-sm text-muted">2 banks, linked</span>
						<ul class="basis-full space-y-1 pb-2 pl-6 text-sm">
							<li class="flex justify-between gap-3">
								<span>Chase</span>
								<span class="text-muted">90 days in · 412</span>
							</li>
							<li class="flex justify-between gap-3">
								<span>American Express</span>
								<span class="text-muted">Reading · 86 so far</span>
							</li>
						</ul>
					</li>
					<li class="flex min-h-11 items-center gap-3 border-b border-rule">
						<span class="min-w-0 flex-1 py-2 text-base text-muted">
							Your pay
						</span>
						<span class="shrink-0 text-sm text-muted">When it's done</span>
					</li>
				</ul>
				<p class="mt-3">
					<a
						href="/"
						class="inline-flex min-h-11 items-center text-accent underline"
					>
						+ Link another bank
					</a>
				</p>
			</div>
			<p class="mt-3 text-muted">Nothing else for you to do until then.</p>
		</section>
	);
}

/** P140 (#719, decision 133): the banks under Home's status while the import is read, drawn for the owner's pick. */
export function BanksProposal() {
	return (
		<Specimen
			id="p140-banks"
			title="P140 · A new family's banks"
			tier="visual"
			sentence="Home's first week while two banks are read, at 390 px: Today, then A (picked) with Your banks under the status and Have more accounts? with Link a bank beneath it, and B with the banks nested under Link your bank."
		>
			<Choices>
				<Choice
					name="Today"
					note="The reading phase as it is drawn now: one line names neither bank, Nothing for you to do until then. sits under the status, and there is no button."
					width="w-[392px]"
				>
					<Phone label="Today, two banks being read" demo={false} tab="home">
						<BanksToday />
					</Phone>
				</Choice>
				<Choice
					name="A · Your banks under the status"
					note="Under the status, one ruled row per bank with its state at the right: 90 days in · 412 once its history is in, and Reading · 86 so far with the busy ring while it is read. Under the list, Have more accounts?, then Link a bank, the same full-width button as before the first bank."
					why="Each bank's state is one row, and the status says from 2 banks without naming either."
					picked
					width="w-[392px]"
				>
					<Phone label="A, two banks being read" demo={false} tab="home">
						<HomeSetup
							view={banksView()}
							polls={false}
							linkBank={
								<Button type="button" class="w-full">
									Link a bank
								</Button>
							}
							yourBanks={{
								banks: [BANKS_CHASE, BANKS_AMEX],
								today: BANKS_TODAY,
								polls: false,
							}}
						/>
					</Phone>
				</Choice>
				<Choice
					name="B · The banks under Link your bank"
					note="The banks sit under step one, and + Link another bank is an accent link under them. The status names neither bank, and no list sits above the five lines."
					cost="Each bank's state is one line deeper in the five lines, where the list is not a list of its own."
					width="w-[392px]"
				>
					<Phone label="B, two banks being read" demo={false} tab="home">
						<BanksB />
					</Phone>
				</Choice>
			</Choices>
		</Specimen>
	);
}
