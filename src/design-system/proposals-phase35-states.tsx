// P38–P40 and P45 (spec §8.5, decision 67): what Tally says when something goes wrong or isn't
// there yet: a save that didn't reach the server, a missing page or a server error, the first
// visit's empty Transactions list, and a bill amount big enough to be a typo. Each option is drawn
// on a phone's first screen from the real components with demo-style data (today is Oct 5), so the
// owner can pick by seeing (decision 47). Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { HomeTop } from "../views/home-top";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { TextInput } from "../views/text-input";
import { Fixed, Options, Sheet } from "./proposal-parts";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// P38: a failed save, drawn on the budget sheet over Home.

/** spec §8.5's words for any htmx request that fails. */
const COULDNT_SAVE = "Couldn't save. Check your connection and try again.";

/**
 * Home behind the sheet, as the demo shows it on Oct 5 (spec §6), from the seed's numbers:
 * budgets of $1,700 (Groceries 700, Eating Out 250, Gas 200, Kids 300, Household 250), $522 spent so
 * far (those five categories $196 + $92 + $48 + $60 + $30 = $426, plus $96 not yet in a category),
 * and $207 set aside for the bills to pay soon (Electric $142 and Internet $65), so $971 is safe.
 */
const SAFE_TO_SPEND = 170000 - 52200 - 20700;
const homeBehind = (
	<HomeTop
		month="October"
		safeToSpendCents={SAFE_TO_SPEND}
		status="Everything is on track."
		band={{
			href: "#p38-failed-save",
			text: "4 transactions need a category",
			detail: `${formatCents(9600, { wholeDollars: true })} of this month's spending`,
		}}
	/>
);

/**
 * The prototype error toast: toast.js's look (minus its shadow-sm, which the token test allows
 * only in toast.js) with an alert icon before the words, so the failure isn't color alone. It sits
 * where every toast does: Layout's #toasts is fixed 9rem above the bottom of the screen, which is
 * the bottom edge of the sheet here.
 */
function ErrorToast() {
	return (
		<div class="absolute inset-x-4 bottom-36 flex flex-col items-center gap-2">
			<p
				role="alert"
				class="flex items-start gap-2 rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink"
			>
				<span class="shrink-0 text-over">
					<Icon name="alert" class="size-5" />
				</span>
				{COULDNT_SAVE}
			</p>
		</div>
	);
}

/** The prototype line in the sheet, above Save: the alert icon in brick, the words in ink. */
const sheetLine = (
	<p role="alert" class="flex items-start gap-2">
		<span class="shrink-0 text-over">
			<Icon name="alert" class="size-6" />
		</span>
		{COULDNT_SAVE}
	</p>
);

/**
 * The budget sheet after Save failed: what was typed (350.00) is still in the field, Save is back
 * to rest, and the error shows as the toast, a line above Save, or both.
 */
function failedBudgetSheet(id: string, look: "toast" | "line" | "both") {
	return (
		<div class="relative">
			<Sheet behind={homeBehind}>
				<div>
					<div class="flex items-center gap-3">
						<CategoryIcon icon="eating-out" color="cat-plum" />
						<h2 class="font-serif text-4xl font-semibold tracking-tight">
							Eating Out
						</h2>
					</div>
					<p class="mt-1 text-muted">$92.00 spent so far in October</p>
				</div>
				<div class="flex flex-col gap-4 border-t border-rule pt-4">
					<MoneyInput
						id={id}
						name="budget"
						label="Budget from October on"
						value="350.00"
						lastMonthCents={36500}
					/>
					{look !== "toast" && sheetLine}
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
			{look !== "line" && <ErrorToast />}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// P39: the app's own 404 and 500 pages, inside the Layout (the tab bar is under each picture).

/** A: EmptyState, as every empty list is, with a heading only screen readers hear. */
function errorEmpty(kind: "404" | "500") {
	return kind === "404" ? (
		<div class="mt-16">
			<h1 class="sr-only">Page not found</h1>
			<EmptyState
				kind="search"
				sentence="This page isn't here."
				hint="The link may be old or mistyped."
				action={{ href: "/", label: "Go to Home" }}
			/>
		</div>
	) : (
		<div class="mt-16">
			<h1 class="sr-only">Something went wrong</h1>
			{/* None of EmptyState's three drawings means "broken"; the magnifier is the least wrong. */}
			<EmptyState
				kind="search"
				sentence="Something went wrong on our side."
				hint="Nothing you did. Your data is safe; try again in a minute."
				action={{ href: "#p39-error-pages", label: "Try again" }}
			/>
		</div>
	);
}

/** B: a plain page: the serif page title, a sentence, and two ways back as terracotta links. */
const errorPlain = (
	<>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			Page not found
		</h1>
		<p class="mt-3 text-lg">The link may be old or mistyped.</p>
		<p class="mt-2 flex gap-6">
			<a href="/" class="inline-flex min-h-11 items-center">
				Home
			</a>
			<a href="/transactions" class="inline-flex min-h-11 items-center">
				Transactions
			</a>
		</p>
	</>
);

/** C: Home's ledger drawing, larger, over a serif "404" and the sentence. */
const errorLedger = (
	<div class="mt-8 flex flex-col items-center text-center">
		<div class="[&>svg]:size-44">
			<LedgerIllustration />
		</div>
		<h1 class="mt-4 font-serif text-7xl font-semibold tracking-tight">404</h1>
		<p class="mt-2 text-lg">This page isn't here.</p>
		<div class="mt-4">
			<Button kind="secondary" href="/">
				Go to Home
			</Button>
		</div>
	</div>
);

/**
 * C's 500 page: the same layout as the 404, so a person who knows one knows the other. It says it's
 * Tally's mistake and that nothing is lost, never shows what failed, and has two ways back: a
 * secondary Try again (the same address) and a terracotta Go to Home.
 */
const errorLedger500 = (
	<div class="mt-8 flex flex-col items-center text-center">
		<div class="[&>svg]:size-44">
			<LedgerIllustration />
		</div>
		<h1 class="mt-4 font-serif text-7xl font-semibold tracking-tight">
			<span class="sr-only">Error </span>500
		</h1>
		<p class="mt-2 text-lg">Something went wrong on our side.</p>
		<p class="mt-1 max-w-xs text-muted">
			Nothing you did. Your data is safe; try again in a minute.
		</p>
		<div class="mt-4 flex flex-wrap items-center justify-center gap-3">
			<Button kind="secondary" href="#p39-error-pages">
				Try again
			</Button>
			<Button kind="text" href="/">
				Go to Home
			</Button>
		</div>
	</div>
);

// ---------------------------------------------------------------------------------------------
// P40: the first visit's empty Transactions list, in the family app.

/**
 * The Transactions top while there's nothing at all: the title and Add cash (cash works without a
 * bank). Select, search, the filters and the result count wait for the first transaction.
 */
const transactionsTop = (
	<>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			Transactions
		</h1>
		<div class="mt-3">
			<Button kind="secondary" type="button" class="gap-2">
				<Icon name="plus" class="size-5" /> Add cash
			</Button>
		</div>
	</>
);

/** A, before any bank: the add sign (one thing to start, decision 55) and a link to Accounts. */
const firstNoBank = (
	<>
		{transactionsTop}
		<EmptyState
			kind="add"
			sentence="Link a bank to see transactions."
			hint="Tally can only read them; it can't move money."
			action={{ href: "/accounts", label: "Link a bank" }}
		/>
	</>
);

/** A, while the first import runs: the magnifier (Tally is looking), not the tick, which would say "done". */
const firstImporting = (
	<>
		{transactionsTop}
		<EmptyState
			kind="search"
			sentence="Importing your transactions…"
			hint="Your bank sends about 90 days of them. It usually takes a few minutes; this page shows them when they're in."
		/>
	</>
);

/** B, before any bank: one muted sentence with the link in it (its padding makes a 44px target without a taller line). */
const lineNoBank = (
	<>
		{transactionsTop}
		<p class="mt-6 text-lg text-muted">
			<a href="/accounts" class="-my-3 inline-block py-3">
				Link a bank
			</a>{" "}
			to see transactions.
		</p>
	</>
);

/** B, while importing: Button's busy ring (an inert SVG; it turns, and stays still for reduced motion). */
const lineImporting = (
	<>
		{transactionsTop}
		<p class="mt-6 flex items-center gap-2 text-lg text-muted">
			<svg
				class="button-spinner size-5 shrink-0"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="3"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="9" opacity="0.25" />
				<path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round" />
			</svg>
			Importing your transactions…
		</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// P45: confirming a bill amount over $100,000, and the duplicate-name error, in Add a bill's sheet.

/**
 * The BottomSheet holding a long form, as it sits on a phone: it grows to 90% of the screen's
 * height (its max-h-[90vh]), so only a strip of the page shows above it, and the rest of the form
 * scrolls. Drawn in place, like Sheet, from its top: a form re-rendered by the server starts there.
 * `scrolled` draws it scrolled down past the title and Name, so Save shows. It ends at the phone
 * frame's bottom edge (a Sheet runs a little past it), so no sliver of the next field shows there.
 */
function TallSheet({
	behind,
	scrolled,
	children,
}: {
	behind?: Child;
	scrolled?: boolean;
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[676px] overflow-hidden">
			<div class="px-5">{behind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div class="absolute inset-x-0 bottom-0 top-12 overflow-hidden rounded-t-sheet bg-paper px-5 pb-5 pt-6">
				<div class={`flex flex-col gap-3 ${scrolled ? "-mt-36" : ""}`}>
					{children}
				</div>
			</div>
		</div>
	);
}

/** The Bills screen's top, dimmed behind the sheet. */
const billsBehind = (
	<>
		<h1 class="font-serif text-4xl font-semibold tracking-tight">Bills</h1>
		<p class="mt-2 font-serif text-lg italic">
			2 bills to pay soon, $207.00 in all
		</p>
	</>
);

/** The demo's five categories in their order (src/demo/seed.ts), as the form lists them. */
const BILL_CATEGORIES = [
	{ name: "Groceries", icon: "groceries", color: "cat-blue" },
	{ name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	{ name: "Gas", icon: "gas", color: "cat-slate" },
	{ name: "Kids", icon: "kids", color: "cat-ochre" },
	{ name: "Household", icon: "household", color: "cat-brown" },
];

type BillForm = {
	/** Prefix for this picture's ids and radio names, so no two pictures share a group. */
	id: string;
	name: string;
	amount: string;
	day: string;
	paidTo: string;
	/** The category the person picked. */
	category: string;
	nameError?: string;
	amountError?: string;
	/** Drawn right under the amount: A's confirm chip. */
	afterAmount?: Child;
	save?: string;
};

/**
 * The Add a bill form as src/routes/bills.tsx renders it (P15), from the same components: name,
 * amount, due day, how often, category and the bank's text, then Cancel and Save. A monthly bill,
 * so the yearly month field stays hidden, as its CSS hides it.
 */
function billForm(f: BillForm) {
	return (
		<>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<TextInput
				id={`${f.id}-name`}
				label="Name"
				value={f.name}
				error={f.nameError}
				surface="paper"
			/>
			<MoneyInput
				id={`${f.id}-amount`}
				name="amount"
				label="Amount"
				value={f.amount}
				error={f.amountError}
			/>
			{f.afterAmount}
			<div class="flex flex-wrap items-end gap-3">
				<TextInput
					id={`${f.id}-day`}
					label="Due day"
					value={f.day}
					surface="paper"
					class="w-24"
					inputmode="numeric"
				/>
				<fieldset>
					<legend>How often</legend>
					<div class="mt-1 flex gap-2">
						<Chip type="radio" name={`${f.id}-often`} value="monthly" checked>
							Monthly
						</Chip>
						<Chip type="radio" name={`${f.id}-often`} value="yearly">
							Yearly
						</Chip>
					</div>
				</fieldset>
			</div>
			<fieldset>
				<legend>Category</legend>
				<div class="mt-1 flex flex-wrap gap-2">
					{BILL_CATEGORIES.map((c) => (
						<Chip
							type="radio"
							name={`${f.id}-category`}
							value={c.name}
							checked={c.name === f.category}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{c.name}
						</Chip>
					))}
				</div>
			</fieldset>
			<TextInput
				id={`${f.id}-paid-to`}
				label="Paid to (the bank's text)"
				value={f.paidTo}
				surface="paper"
			/>
			<div class="flex items-center justify-between gap-3">
				<div class="flex gap-3">
					<Button kind="secondary" type="button">
						Cancel
					</Button>
					<Button type="button">{f.save ?? "Save"}</Button>
				</div>
			</div>
		</>
	);
}

/**
 * Rent typed with two zeros too many: 150000 for 1500, so $150,000.00, over spec §8.5's $100,000.
 * Typed as "150000": "150,000.00" is wider than the money input's field on a phone and is cut off.
 */
const RENT = {
	name: "Rent",
	amount: "150000",
	day: "1",
	category: "Household",
	paidTo: "HARBOR PROPERTY MGMT",
};
const TOO_BIG = "$150,000.00 is a lot for a bill.";

/** A: the form comes back with the line under the amount and a toggle chip to tick before Save. */
const confirmTick = (
	<TallSheet behind={billsBehind}>
		{billForm({
			id: "p45-a",
			...RENT,
			amountError: TOO_BIG,
			afterAmount: (
				<div class="flex justify-center">
					<Chip
						type="checkbox"
						name="p45-a-confirm"
						value="15000000"
						describedBy="p45-a-amount-error"
					>
						Yes, $150,000.00 is right
					</Chip>
				</div>
			),
		})}
	</TallSheet>
);

/** B: the sheet turns into one question, with the bill's details to check against. */
const confirmStep = (
	<Sheet behind={billsBehind}>
		<h2 class="font-serif text-4xl font-semibold tracking-tight">
			Save a $150,000.00 bill?
		</h2>
		<p class="text-lg">Rent · Household · monthly, due on the 1st</p>
		<p class="text-muted">
			That's more than most bills. Check it isn't a typo.
		</p>
		<div class="flex flex-col gap-3">
			<Button type="button" class="w-full">
				Save it
			</Button>
			<Button kind="secondary" type="button" class="w-full">
				Change the amount
			</Button>
		</div>
	</Sheet>
);

/** C: the same line, and Save says what it will do; drawn scrolled down to Save. */
const saveAnyway = (
	<TallSheet behind={billsBehind} scrolled>
		{billForm({
			id: "p45-c",
			...RENT,
			amountError: TOO_BIG,
			save: "Save $150,000.00 anyway",
		})}
	</TallSheet>
);

/** Both: a second active bill with the same name is a field error under Name. */
const duplicateName = (
	<TallSheet behind={billsBehind}>
		{billForm({
			id: "p45-dup",
			name: "Internet",
			amount: "65.00",
			day: "8",
			category: "Household",
			paidTo: "AMAZON.COM*RT4K2",
			nameError: "You already have a bill called Internet.",
		})}
	</TallSheet>
);

/** P38–P40 and P45 on the proposals page. */
export function Phase35StatesProposals() {
	return (
		<>
			<Specimen
				id="p38-failed-save"
				title="P38 · A failed save"
				tier="visual"
				sentence="What you see when a save doesn't reach Tally, here the budget sheet on a bad connection. Pick where the words go."
			>
				<Fixed>
					a failed htmx request shows “{COULDNT_SAVE}” in role="alert" (§8.5).
				</Fixed>
				<NeedsLine settled="decision 72">
					A failed request (a dropped connection or a 500 reply) raises an error
					toast with the alert icon, “Couldn't save. Check your connection and
					try again.” (“Couldn't load. Check your connection and try again.” for
					a GET), and leaves the page as it is, so an open sheet keeps what was
					typed and Save comes back to rest. The toast region sits above the
					sheet (z-60 over the sheet's z-50) and lets taps through, so Save can
					be tapped again.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · An error toast",
							picked: true,
							note: "The toast you already know, with an alert icon, where every toast shows (above the tab bar; drawn flat here, the real one floats a little); the sheet stays open with what was typed.",
							tradeoff:
								"it goes after 4 seconds, and over a sheet it covers part of the form until it does.",
							recommended:
								"one place for every failed request, including Adjust taps and Sync now, which have no sheet, and the listener already exists.",
							screen: failedBudgetSheet("p38-a", "toast"),
						},
						{
							name: "Option B · A line in the sheet",
							note: "Above Save, the alert icon and the words; outside a sheet it falls back to the toast.",
							tradeoff:
								"two looks for one failure, and a dropped connection brings no reply to carry the line, so a script has to add it.",
							screen: failedBudgetSheet("p38-b", "line"),
						},
						{
							name: "Option C · Both at once",
							note: "The line in the sheet and the toast together.",
							tradeoff: "it says the same thing twice.",
							screen: failedBudgetSheet("p38-c", "both"),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p39-error-pages"
				title="P39 · The app's own 404 and 500 pages"
				tier="visual"
				sentence="The page for a link that goes nowhere, and the page for a mistake on Tally's side. Pick their look."
			>
				<Fixed>the app has its own 404 and 500 pages (§8.5).</Fixed>
				<NeedsLine settled="decision 72">
					Both pages are drawn inside the Layout, so the navigation is there and
					nobody is stuck, and the 500 page never shows what failed (no message,
					code or request detail). Try again retries a failed GET on its own
					address; a failed form post goes back to the page the form was on (the
					Referer's path and query, only when it is this site's, never one that
					starts with {"“//”"}), and with no such page there is no Try again and
					“Go to Home” is the one secondary button.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · EmptyState",
							note: "The magnifier, one sentence, a hint and Go to Home, centred; a heading names the page for screen readers.",
							tradeoff:
								"none of the three drawings means “broken”, so the 500 page borrows the magnifier.",
							recommended:
								"the same calm look as every empty list, inside the navigation so you're never stuck.",
							screen: errorEmpty("404"),
						},
						{
							name: "Option A · The 500 page",
							note: "The same, saying it's Tally's mistake, with Try again (the same address).",
							screen: errorEmpty("500"),
						},
						{
							name: "Option B · A plain page",
							note: "A serif title, a sentence and two links back, Home and Transactions; no drawing. The 500 page changes the words, not the look.",
							tradeoff:
								"it looks unlike every other empty or missing thing in Tally.",
							screen: errorPlain,
						},
						{
							name: "Option C · The ledger drawing",
							picked: true,
							note: "Home's notebook drawing, larger, over a serif 404 and the sentence. The 500 page says “500” and its own sentence.",
							tradeoff:
								"an error number means nothing to most people, and the drawing is Home's.",
							screen: errorLedger,
						},
						{
							name: "Option C · The 500 page",
							note: "The same drawing over a serif “500”, “Something went wrong on our side.” and a muted hint. Try again loads the same address; Go to Home is the way out. It never shows what failed.",
							screen: errorLedger500,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p40-first-visit"
				title="P40 · The first visit's empty Transactions list"
				tier="visual"
				sentence="Transactions before the bank's first ones arrive, in the family app: before a bank is linked, and while the first import runs. Pick how it says so."
			>
				<Fixed>
					the first visit's empty list says “Importing your transactions…” or
					“Link a bank to see transactions”, not “No transactions match” (§8.5).
				</Fixed>
				<NeedsLine>
					For “this page shows them when they're in” to be true, the page has to
					refresh itself while importing, and the “few minutes” is to be checked
					against a real first sync. Already settled (decision 72): “nothing at
					all” means no transaction in any month, and a month, search or filter
					with no results still says “No transactions match these filters.”;
					“Link a bank to see transactions.” shows while no connected bank is
					linked, as a secondary link to Accounts, not decision 55's primary
					button, because Plaid Link loads only on Accounts (§10); and
					“Importing your transactions…” (no button) shows once one is.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Two EmptyStates",
							picked: true,
							note: "Before a bank: the add sign and Link a bank. Search, filters and Select wait for the first transaction; Add cash stays, since cash works without a bank.",
							tradeoff:
								"with no bank yet, Add cash and Link a bank are two outline buttons on one screen.",
							recommended:
								"the same EmptyState as every list (decisions 54 and 55), and each says the one thing to do or wait for.",
							family: true,
							screen: firstNoBank,
						},
						{
							name: "Option A · Importing",
							note: "While the first import runs: the magnifier (Tally is looking; the tick would say done), the sentence and how long it takes; no button.",
							family: true,
							screen: firstImporting,
						},
						{
							name: "Option B · Only a line",
							note: "Before a bank: the title, Add cash and one muted sentence with the link in it.",
							tradeoff:
								"a lone muted line is what decision 54 replaced, so choosing it means a new decision entry; and a ring turning for minutes looks stuck.",
							family: true,
							screen: lineNoBank,
						},
						{
							name: "Option B · Importing",
							note: "While the first import runs: the turning ring and the sentence.",
							family: true,
							screen: lineImporting,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p45-bill-checks"
				title="P45 · Confirming a bill amount over $100,000"
				tier="visual"
				sentence="Add a bill asks once more before it saves an amount that big, here Rent typed with two zeros too many. Pick how it asks."
			>
				<Fixed>
					an amount over $100,000 needs confirming, and no two active bills
					share a name (§8.5); the form is in a bottom sheet (§8.2), and invalid
					input comes back as a field error in role="alert" (§10).
				</Fixed>
				<NeedsLine settled="decisions 72 and 80">
					“Over” means more than $100,000.00, so exactly that saves without
					asking. Adding or editing an amount over it comes back unsaved until a
					“Yes, $X is right” chip under the amount's alert is ticked, and the
					tick covers that exact amount only, so changing the amount asks again.
					Names are compared ignoring A to Z capitals and spaces around them,
					and reactivating an inactive bill that would repeat an active one's
					name is refused the same way.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A tick to confirm",
							picked: true,
							note: "The form comes back with a line under the amount and a chip to tick, “Yes, $150,000.00 is right”, before Save.",
							tradeoff: "one more tap, in the middle of the form.",
							recommended:
								"it works without JavaScript, and the amount is read out once more before it saves.",
							screen: confirmTick,
						},
						{
							name: "Option B · A confirm step",
							note: "The sheet becomes one question, with Save it and Change the amount.",
							tradeoff:
								"a step away from the form, so fixing the amount means going back.",
							screen: confirmStep,
						},
						{
							name: "Option C · Save anyway",
							note: "The same line under the amount, and Save becomes “Save $150,000.00 anyway” (drawn scrolled down to it).",
							tradeoff:
								"the same Save button saves it, so a habitual second tap can confirm without reading, and its long label takes two lines on a phone.",
							screen: saveAnyway,
						},
						{
							name: "Both · The duplicate name",
							note: "Every option: a second active bill with the same name is a field error under Name.",
							screen: duplicateName,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
