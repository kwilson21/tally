// P72: forms, rethought. The owner called Add a bill "quite ugly, cluttered and unintuitive" (P45) and
// asked to rethink every form, so this draws one pattern three ways, on Add a bill and on Add cash,
// for the owner to pick by seeing (decision 47). Nothing here is decided until they pick, and no form
// in the app changes before then. Each picture is the real components (Button, Chip, CategoryIcon,
// Icon, TextInput, MoneyInput) with demo-style data (today is Oct 5), plus two new pieces drawn
// inline as prototypes in tokens: a ledger-line field and a pinned footer. If a pattern is picked,
// those two move into src/views/ and the catalog in the PR that builds it (DESIGN.md).

import type { Child } from "hono/jsx";
import { ordinal } from "../dates";
import { formatCents, toCents } from "../money";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { TextInput } from "../views/text-input";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style.

type Cat = { name: string; icon: string; color: string };
const GROCERIES: Cat = {
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
};
const EATING_OUT: Cat = {
	name: "Eating Out",
	icon: "eating-out",
	color: "cat-plum",
};
const GAS: Cat = { name: "Gas", icon: "gas", color: "cat-slate" };
const KIDS: Cat = { name: "Kids", icon: "kids", color: "cat-ochre" };
const HOUSEHOLD: Cat = {
	name: "Household",
	icon: "household",
	color: "cat-brown",
};
/** The demo's five categories in their order (src/demo/seed.ts), as the forms list them. */
const CATEGORIES = [GROCERIES, EATING_OUT, GAS, KIDS, HOUSEHOLD];

type Bill = {
	name: string;
	/** What the field holds ("1500.00"), as the server writes it. */
	amount: string;
	day: number;
	/** Set for a yearly bill: the month it's due in. */
	month?: string;
	category: Cat;
	/** The bank's text for the payment, as it arrives. */
	paidTo: string;
	nameError?: string;
};

/** A monthly bill: the one the sentences below read back. */
const RENT: Bill = {
	name: "Rent",
	amount: "1500.00",
	day: 1,
	category: HOUSEHOLD,
	paidTo: "HARBOR PROPERTY MGMT",
};

/** A yearly bill whose name is already taken, to draw the longest state and a field error. */
const PRIME: Bill = {
	name: "Amazon Prime",
	amount: "139.00",
	day: 14,
	month: "March",
	category: HOUSEHOLD,
	paidTo: "AMAZON PRIME*RT4K2",
	nameError: "You already have a bill called Amazon Prime.",
};

const CASH = {
	amount: "12.50",
	where: "Corner Deli",
	date: "2026-10-05",
	category: EATING_OUT,
};

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

const money = (amount: string) => formatCents(toCents(amount));

/** The Bills screen's top, dimmed behind the sheet. */
const billsBehind = (
	<>
		<Title>Bills</Title>
		<p class="mt-2 font-serif text-lg italic">
			2 bills to pay soon, $207.00 in all
		</p>
	</>
);

/** The Transactions screen's top, dimmed behind the sheet. */
const transactionsBehind = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">18 transactions in October</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// The sheet, as it sits on a phone.

/**
 * The BottomSheet holding a form, drawn in place like Sheet (the real one is fixed to the viewport,
 * so it can't sit in a picture). The real one grows with its form up to 90% of the screen's height;
 * Sheet's strip is too short for a long form, so this is P45's taller one. By default it fills that
 * height: the form scrolls in the middle and a `footer` stays under it. `fit` is a sheet as tall as
 * its form, for a form that fits without scrolling. A picture can't scroll, so what doesn't fit is
 * cut off at the footer, which is what a person sees before they scroll.
 */
function TallSheet({
	behind,
	footer,
	fit,
	gap = "gap-5",
	children,
}: {
	behind?: Child;
	footer?: Child;
	fit?: boolean;
	gap?: "gap-3" | "gap-5";
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[676px] overflow-hidden">
			<div class="px-5">{behind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div
				class={`absolute inset-x-0 bottom-0 flex flex-col rounded-t-sheet bg-paper ${fit ? "max-h-[628px]" : "top-12"}`}
			>
				<div
					class={`flex min-h-0 flex-col ${gap} overflow-hidden px-5 pt-6 ${footer ? "pb-3" : "pb-5"} ${fit ? "" : "flex-1"}`}
				>
					{children}
				</div>
				{footer && (
					<div class="shrink-0 border-t border-rule px-5 pb-5 pt-3">
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The pinned footer (prototype): Cancel and the one primary side by side, 44px tall, under a rule,
 * outside the part of the sheet that scrolls, so they're on screen however long the form is.
 */
function Footer({ save }: { save: string }) {
	return (
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				{save}
			</Button>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The ledger-line pieces (prototypes): small muted labels over lines, no boxes.

type LedgerProps = {
	id: string;
	name: string;
	label: string;
	value: string;
	/** The label stays for screen readers only (the row above it already says it). */
	hideLabel?: boolean;
	hint?: string;
	error?: string;
	/** The amount's size: the serif of the sheet title role, the one big thing. */
	big?: boolean;
	/** "$" before the text. */
	prefix?: string;
	type?: "text" | "date";
	inputmode?: "decimal";
	max?: string;
};

/**
 * A ledger-line field: a small muted label above, then the text on a bottom rule with no box. The
 * rule is muted, not the pale `rule`, because it marks where to type (a 3:1 edge); `rule` stays
 * for lines that only separate. Focus draws the accent ring around the line; an error turns the
 * line brick and says why under it in role="alert", with its words, as FormField does.
 */
function LedgerField({
	id,
	name,
	label,
	value,
	hideLabel,
	hint,
	error,
	big,
	prefix,
	type = "text",
	inputmode,
	max,
}: LedgerProps) {
	const describedBy =
		[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
		undefined;
	return (
		<div class="flex flex-col gap-1">
			<label for={id} class={hideLabel ? "sr-only" : "text-sm text-muted"}>
				{label}
			</label>
			<div
				class={`flex items-baseline gap-2 border-b ${error ? "border-over" : "border-muted"} has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent`}
			>
				{prefix && (
					<span
						aria-hidden="true"
						class={
							big ? "font-serif text-4xl text-muted" : "text-lg text-muted"
						}
					>
						{prefix}
					</span>
				)}
				<input
					id={id}
					name={name}
					type={type}
					value={value}
					max={max}
					inputmode={inputmode}
					autocomplete="off"
					aria-invalid={error ? "true" : undefined}
					aria-describedby={describedBy}
					class={`min-w-0 flex-1 bg-transparent focus-visible:outline-none ${big ? "min-h-14 font-serif text-4xl font-semibold tabular-nums" : "min-h-11 text-lg"} ${error ? "field-shake" : ""}`}
				/>
			</div>
			{hint && (
				<p id={`${id}-hint`} class="text-sm text-muted">
					{hint}
				</p>
			)}
			{error && (
				<p id={`${id}-error`} role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
		</div>
	);
}

// A disclosure row's summary and chevron, as Settings draws them (DESIGN.md "Disclosure"): 48px at
// least, the chevron turns when it opens, no script.
const summaryRow =
	"flex min-h-12 cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden";
const Chevron = ({ push }: { push?: boolean }) => (
	<span
		class={`${push ? "ml-auto " : ""}shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none`}
	>
		<Icon name="chevron-right" class="size-5" />
	</span>
);

/**
 * A quiet row: its name in muted words, then what it holds (never a control) and a chevron. A short
 * choice sits at the right (`value`); a long one sits under the name (`sub`), so it isn't cut off.
 * It opens in place. Built with `<details>`, so it needs no JavaScript, and what's inside still
 * posts while it's closed. The row opens itself when its field has an error (`open`). Here the
 * shown choice is drawn as given; in the app the server draws it, from what was saved or posted,
 * so after a new pick it's the chips that show the choice until the page redraws (on an error, or
 * through the Chip's own `hx-get` where htmx is running). That is a build detail, not a look.
 */
function Row({
	label,
	value,
	sub,
	open,
	children,
}: {
	label: string;
	value?: Child;
	sub?: Child;
	open?: boolean;
	children?: Child;
}) {
	return (
		<details class="group border-b border-rule" open={open}>
			<summary class={summaryRow}>
				<span class="flex min-w-0 flex-col py-1">
					<span class="text-muted">{label}</span>
					{sub && <span class="truncate text-sm text-muted">{sub}</span>}
				</span>
				{value && (
					<span class="ml-auto flex min-w-0 items-center gap-2">{value}</span>
				)}
				<Chevron push={!value} />
			</summary>
			{children}
		</details>
	);
}

/** A category as the row shows it: its icon and name, so the row says what's chosen. */
const categoryValue = (c: Cat) => (
	<>
		<CategoryIcon icon={c.icon} color={c.color} />
		<span class="truncate text-lg">{c.name}</span>
	</>
);

/** The categories as radio chips, the real Chip. Closed inside a Row, they still post. */
function CategoryChips({ id, selected }: { id: string; selected: Cat }) {
	return (
		<fieldset class="pb-3">
			<legend class="sr-only">Category</legend>
			<div class="flex flex-wrap gap-2">
				{CATEGORIES.map((c) => (
					<Chip
						type="radio"
						name={`${id}-category`}
						value={c.name}
						checked={c.name === selected.name}
						icon={<CategoryIcon icon={c.icon} color={c.color} />}
					>
						{c.name}
					</Chip>
				))}
			</div>
		</fieldset>
	);
}

/**
 * "Paid to (the bank's text)" is bank jargon, so it's "Match payments from": the name your bank
 * shows on the payment, which Tally uses to find the bill's payments. Tally fills it in (from
 * Possible bills, or a payment it recognises), so a closed row, muted, is all most people see. It
 * opens itself when it's empty or has an error. (Today it's required, so a bill added by hand with
 * nothing to fill in needs a rule: that's for the owner to settle if A or B is picked.)
 */
function MatchRow({
	id,
	paidTo,
	open,
}: {
	id: string;
	paidTo: string;
	open?: boolean;
}) {
	return (
		<Row label="Match payments from" sub={paidTo} open={open}>
			<div class="pb-3">
				<LedgerField
					id={`${id}-match`}
					name="merchant_raw_name"
					label="Match payments from"
					hideLabel
					value={paidTo}
					hint="How your bank writes it. Tally uses it to match payments to this bill."
				/>
			</div>
		</Row>
	);
}

/**
 * "Due on the 1st every month" as one row of words with native pickers, which a phone shows in its
 * own wheel, so there's nothing to type or parse. A yearly bill adds "in March" on a second line;
 * the real form shows that line from the frequency choice in CSS (`:has`), as `.bill-month` does
 * today. `lead` is the words before the day. The legend is for screen readers: the visible words
 * already say it.
 */
function DueRow({
	id,
	bill,
	lead,
	big,
}: {
	id: string;
	bill: Bill;
	lead: string;
	big?: boolean;
}) {
	const size = big ? "text-2xl" : "text-lg";
	const select = `min-h-11 border-b border-muted bg-transparent px-1 ${size}`;
	return (
		<fieldset class="flex flex-col">
			<legend class="sr-only">When it's due</legend>
			<div class={`flex flex-wrap items-center gap-x-2 ${size}`}>
				<span>{lead}</span>
				<select
					name="due_day"
					aria-label="Day of the month"
					id={`${id}-day`}
					class={select}
				>
					{DAYS.map((d) => (
						<option value={d} selected={d === bill.day}>
							{ordinal(d)}
						</option>
					))}
				</select>
				<select name="frequency" aria-label="How often" class={select}>
					<option value="monthly" selected={!bill.month}>
						every month
					</option>
					<option value="yearly" selected={!!bill.month}>
						every year
					</option>
				</select>
			</div>
			{bill.month && (
				<div class={`flex items-center gap-2 ${size}`}>
					<span>in</span>
					<select name="anchor_month" aria-label="Month" class={select}>
						{MONTH_NAMES.map((m) => (
							<option value={m} selected={m === bill.month}>
								{m}
							</option>
						))}
					</select>
				</div>
			)}
		</fieldset>
	);
}

// ---------------------------------------------------------------------------------------------
// Option A: a quiet ledger form.

/**
 * Add a bill as one quiet column: the amount is the one big thing, right under the title; Name and
 * the Due sentence follow on lines; Category and Match payments from fold into a row each; Save is
 * pinned. The title steps down from the sheet title role (4xl) to 2xl so two serif lines of similar
 * size don't compete (DESIGN.md, Type); the amount takes that role's size. `open` draws the
 * Category row open, for the longest state.
 */
function BillA({ id, bill, open }: { id: string; bill: Bill; open?: boolean }) {
	return (
		<TallSheet behind={billsBehind} footer={<Footer save="Save" />}>
			<h2 class="font-serif text-2xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<LedgerField
				big
				prefix="$"
				id={`${id}-amount`}
				name="amount"
				label="Amount"
				value={bill.amount}
				inputmode="decimal"
			/>
			<LedgerField
				id={`${id}-name`}
				name="name"
				label="Name"
				value={bill.name}
				error={bill.nameError}
			/>
			<DueRow id={id} bill={bill} lead="Due on the" />
			<div class="border-t border-rule">
				<Row label="Category" value={categoryValue(bill.category)} open={open}>
					<CategoryChips id={id} selected={bill.category} />
				</Row>
				<MatchRow id={id} paidTo={bill.paidTo} />
			</div>
		</TallSheet>
	);
}

/** Add cash in the same pattern: the amount, where, the date on lines; Category and a note as rows. */
function CashA() {
	const id = "p72-a-cash";
	return (
		<TallSheet behind={transactionsBehind} footer={<Footer save="Add" />}>
			<h2 class="font-serif text-2xl font-semibold tracking-tight">Add cash</h2>
			<LedgerField
				big
				prefix="$"
				id={`${id}-amount`}
				name="amount"
				label="Amount"
				value={CASH.amount}
				inputmode="decimal"
			/>
			<LedgerField
				id={`${id}-where`}
				name="merchant"
				label="Where"
				value={CASH.where}
			/>
			<LedgerField
				id={`${id}-date`}
				name="date"
				label="Date"
				type="date"
				value={CASH.date}
				max={CASH.date}
			/>
			<div class="border-t border-rule">
				<Row label="Category" value={categoryValue(CASH.category)}>
					<CategoryChips id={id} selected={CASH.category} />
				</Row>
				<Row
					label="Note"
					value={<span class="text-sm text-muted">Optional</span>}
				>
					<div class="pb-3">
						<LedgerField
							id={`${id}-note`}
							name="note"
							label="Note (optional)"
							hideLabel
							value=""
						/>
					</div>
				</Row>
			</div>
		</TallSheet>
	);
}

// ---------------------------------------------------------------------------------------------
// Option B: one question at a time.

/**
 * The top of a step: where you are, in words (not a bar: bars here mean a budget), and Cancel,
 * a quiet terracotta text action that is never beside the primary.
 */
function StepTop({ text }: { text: string }) {
	return (
		<div class="flex items-center justify-between">
			<p class="text-sm text-muted">{text}</p>
			<Button kind="text" type="button" class="-mr-2">
				Cancel
			</Button>
		</div>
	);
}

/**
 * Back and Next pinned to the bottom of the sheet, which keeps one height from step to step so they
 * never move. Next posts to the next step (`?step=4`) and the page comes back with the earlier
 * answers in hidden fields, so it needs no script; Back goes to the step before.
 */
function StepFooter({ back = "Back", next }: { back?: string; next: string }) {
	return (
		<div class="mt-auto grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				{back}
			</Button>
			<Button type="button" class="w-full">
				{next}
			</Button>
		</div>
	);
}

/** The step's question in large type, the one thing on the sheet (sheet title role). */
const Question = ({ children }: { children?: Child }) => (
	<h2 class="font-serif text-4xl font-semibold tracking-tight">{children}</h2>
);

/** Add a bill, question 3 of 4: the earlier answers are muted under the question and ride along hidden. */
const billStep = (
	<Sheet behind={billsBehind}>
		<input type="hidden" name="name" value={RENT.name} />
		<input type="hidden" name="amount" value={RENT.amount} />
		<StepTop text="Question 3 of 4" />
		<Question>When is it due?</Question>
		<p class="text-muted">
			{RENT.name} · {money(RENT.amount)}
		</p>
		<DueRow id="p72-b" bill={RENT} lead="On the" big />
		<StepFooter next="Next" />
	</Sheet>
);

/** One link of the summary's "Change" line: it goes back to that step, the answers kept. */
const ChangeLink = ({ what }: { what: string }) => (
	<Button
		kind="text"
		type="button"
		class="min-w-11"
		aria-label={`Change ${what.toLowerCase()}`}
	>
		{what}
	</Button>
);

/**
 * Add a bill, the last step: the bill read back as a sentence, then the one primary. Fixing
 * something is a jump back to its step (the Change line); the bank's text, which Tally filled in,
 * is changed from here too.
 */
const billSummary = (
	<Sheet behind={billsBehind}>
		<input type="hidden" name="name" value={RENT.name} />
		<input type="hidden" name="amount" value={RENT.amount} />
		<input type="hidden" name="due_day" value={RENT.day} />
		<input type="hidden" name="frequency" value="monthly" />
		<input type="hidden" name="category" value={RENT.category.name} />
		<input type="hidden" name="merchant_raw_name" value={RENT.paidTo} />
		<StepTop text="Last step" />
		<h2 class="font-serif text-3xl font-semibold leading-tight">
			{RENT.name}, {money(RENT.amount)}, due on the {ordinal(RENT.day)} every
			month, in {RENT.category.name}.
		</h2>
		<div class="flex flex-wrap items-center">
			<span class="text-muted">Change</span>
			<ChangeLink what="Name" />
			<ChangeLink what="Amount" />
			<ChangeLink what="Due" />
			<ChangeLink what="Category" />
		</div>
		<div class="flex items-center justify-between gap-2">
			<p class="text-sm text-muted">Payments are matched from {RENT.paidTo}.</p>
			<Button
				kind="text"
				type="button"
				class="-mr-2"
				aria-label="Change what payments are matched from"
			>
				Change
			</Button>
		</div>
		<StepFooter next="Save" />
	</Sheet>
);

/** Add cash, question 3 of 3: the category chips with room to breathe; the date and note come last. */
const cashStep = (
	<Sheet behind={transactionsBehind}>
		<input type="hidden" name="amount" value={CASH.amount} />
		<input type="hidden" name="merchant" value={CASH.where} />
		<StepTop text="Question 3 of 3" />
		<Question>Which category?</Question>
		<p class="text-muted">
			{money(CASH.amount)} at {CASH.where}
		</p>
		<CategoryChips id="p72-b-cash" selected={CASH.category} />
		<StepFooter next="Next" />
	</Sheet>
);

// ---------------------------------------------------------------------------------------------
// Option C: a sentence to fill in.

// Every blank in the sentence: serif like the sentence, on a muted line, 44px tall.
const blank =
	"min-h-11 border-b border-muted bg-transparent px-1 font-serif text-2xl font-semibold";
// A typed blank is as wide as its words (`field-sizing`), so the comma or "at" after it sits against
// it instead of floating past a fixed-width box; `size` is its width where a browser can't do that.
const typed = `${blank} field-sizing-content min-w-16 max-w-full`;

/** One word of the sentence (or a word and its punctuation), kept together when the line wraps. */
const W = ({ children }: { children?: Child }) => <span>{children}</span>;

/**
 * Add a bill as a sentence: "Rent costs $1,500.00, due on the 1st of every month, in Household."
 * Every blank is a real control with its label hidden for screen readers (the fieldset's legend
 * names the whole sentence). A yearly bill adds "in March" after "every year". Category is a native
 * picker here, so the chips and their icons are gone.
 */
function BillC({ id, bill }: { id: string; bill: Bill }) {
	return (
		<TallSheet fit behind={billsBehind}>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<fieldset>
				<legend class="sr-only">The bill, as a sentence</legend>
				<div class="flex flex-wrap items-baseline gap-x-2 gap-y-2 font-serif text-2xl leading-snug">
					<label for={`${id}-name`} class="sr-only">
						Name
					</label>
					<input
						id={`${id}-name`}
						name="name"
						value={bill.name}
						autocomplete="off"
						size={6}
						class={typed}
					/>
					<W>costs</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-amount`} class="sr-only">
							Amount
						</label>
						<span aria-hidden="true">$</span>
						<input
							id={`${id}-amount`}
							name="amount"
							value={bill.amount}
							inputmode="decimal"
							autocomplete="off"
							size={7}
							class={typed}
						/>
						<span>,</span>
					</span>
					<W>due on the</W>
					<label for={`${id}-day`} class="sr-only">
						Day of the month
					</label>
					<select id={`${id}-day`} name="due_day" class={blank}>
						{DAYS.map((d) => (
							<option value={d} selected={d === bill.day}>
								{ordinal(d)}
							</option>
						))}
					</select>
					<W>of</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-often`} class="sr-only">
							How often
						</label>
						<select id={`${id}-often`} name="frequency" class={blank}>
							<option value="monthly" selected={!bill.month}>
								every month
							</option>
							<option value="yearly" selected={!!bill.month}>
								every year
							</option>
						</select>
						{!bill.month && <span>,</span>}
					</span>
					{bill.month && (
						<>
							<W>in</W>
							<span class="inline-flex items-baseline">
								<label for={`${id}-month`} class="sr-only">
									Month
								</label>
								<select id={`${id}-month`} name="anchor_month" class={blank}>
									{MONTH_NAMES.map((m) => (
										<option value={m} selected={m === bill.month}>
											{m}
										</option>
									))}
								</select>
								<span>,</span>
							</span>
						</>
					)}
					<W>in</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-category`} class="sr-only">
							Category
						</label>
						<select id={`${id}-category`} name="category" class={blank}>
							{CATEGORIES.map((c) => (
								<option value={c.name} selected={c.name === bill.category.name}>
									{c.name}
								</option>
							))}
						</select>
						<span>.</span>
					</span>
				</div>
			</fieldset>
			<div class="border-t border-rule">
				<MatchRow id={id} paidTo={bill.paidTo} />
			</div>
			<Footer save="Save" />
		</TallSheet>
	);
}

/** Add cash as a sentence, with the note on its own line under it. */
function CashC() {
	const id = "p72-c-cash";
	return (
		<TallSheet fit behind={transactionsBehind}>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">Add cash</h2>
			<fieldset>
				<legend class="sr-only">The cash spending, as a sentence</legend>
				<div class="flex flex-wrap items-baseline gap-x-2 gap-y-2 font-serif text-2xl leading-snug">
					<W>I spent</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-amount`} class="sr-only">
							Amount
						</label>
						<span aria-hidden="true">$</span>
						<input
							id={`${id}-amount`}
							name="amount"
							value={CASH.amount}
							inputmode="decimal"
							autocomplete="off"
							size={6}
							class={typed}
						/>
					</span>
					<W>at</W>
					<label for={`${id}-where`} class="sr-only">
						Where
					</label>
					<input
						id={`${id}-where`}
						name="merchant"
						value={CASH.where}
						autocomplete="off"
						size={10}
						class={typed}
					/>
					<W>on</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-date`} class="sr-only">
							Date
						</label>
						<input
							id={`${id}-date`}
							name="date"
							type="date"
							value={CASH.date}
							max={CASH.date}
							class={`${blank} w-48`}
						/>
						<span>,</span>
					</span>
					<W>in</W>
					<span class="inline-flex items-baseline">
						<label for={`${id}-category`} class="sr-only">
							Category
						</label>
						<select id={`${id}-category`} name="category" class={blank}>
							{CATEGORIES.map((c) => (
								<option value={c.name} selected={c.name === CASH.category.name}>
									{c.name}
								</option>
							))}
						</select>
						<span>.</span>
					</span>
				</div>
			</fieldset>
			<LedgerField
				id={`${id}-note`}
				name="note"
				label="Note (optional)"
				value=""
			/>
			<Footer save="Add" />
		</TallSheet>
	);
}

// ---------------------------------------------------------------------------------------------
// Today: Add a bill as src/routes/bills.tsx draws it, for comparison.

/**
 * The form as it is now, from the same components (P15, and P45's drawing of it): every field in a
 * box at the same volume, Due day beside How often, five chips, the bank's text, and Save and
 * Cancel last, below where a phone's sheet stops. A monthly bill, so the yearly month stays hidden.
 */
function BillToday() {
	const id = "p72-today";
	return (
		<TallSheet behind={billsBehind} gap="gap-3">
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<TextInput
				id={`${id}-name`}
				label="Name"
				value={RENT.name}
				surface="paper"
			/>
			<MoneyInput
				id={`${id}-amount`}
				name="amount"
				label="Amount"
				value={RENT.amount}
			/>
			<div class="flex flex-wrap items-end gap-3">
				<TextInput
					id={`${id}-day`}
					label="Due day"
					value={String(RENT.day)}
					surface="paper"
					class="w-24"
					inputmode="numeric"
				/>
				<fieldset>
					<legend>How often</legend>
					<div class="mt-1 flex gap-2">
						<Chip type="radio" name={`${id}-often`} value="monthly" checked>
							Monthly
						</Chip>
						<Chip type="radio" name={`${id}-often`} value="yearly">
							Yearly
						</Chip>
					</div>
				</fieldset>
			</div>
			<fieldset>
				<legend>Category</legend>
				<div class="mt-1 flex flex-wrap gap-2">
					{CATEGORIES.map((c) => (
						<Chip
							type="radio"
							name={`${id}-category`}
							value={c.name}
							checked={c.name === RENT.category.name}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{c.name}
						</Chip>
					))}
				</div>
			</fieldset>
			<TextInput
				id={`${id}-paid-to`}
				label="Paid to (the bank's text)"
				value={RENT.paidTo}
				surface="paper"
			/>
			<div class="flex gap-3">
				<Button kind="secondary" type="button">
					Cancel
				</Button>
				<Button type="button">Save</Button>
			</div>
		</TallSheet>
	);
}

// ---------------------------------------------------------------------------------------------

/** P72 on the proposals page. */
export function FormsProposals() {
	return (
		<Specimen
			id="p72-forms"
			title="P72 · Forms, rethought"
			tier="visual"
			sentence="Add a bill felt cluttered (P45), so every form gets one pattern. Today every field shouts at the same volume, Due day and How often are squeezed side by side, the category chips take half the sheet, “Paid to (the bank's text)” is bank jargon, the ±$1 buttons don't suit a bill, and Save is far below the fold on a phone. Pick a pattern; each is drawn on Add a bill and on Add cash, with today's form first to compare."
		>
			<Fixed>
				every field has a label (seen, or read by screen readers) and its error
				under it in role="alert" (§10); 44px targets and focus rings; forms are
				plain posts that work without JavaScript, with htmx only smoothing them;
				on a phone a form opens in the bottom sheet (§8.2); one primary button
				per sheet; a budget keeps MoneyInput, the owner's own design (decisions
				39 and 41).
			</Fixed>
			<p class="max-w-prose text-sm">
				<span class="font-medium">Yours to decide, in every picture: </span>
				Add a bill and Add cash are drawn with a plain amount field, since a
				bill isn't nudged a dollar at a time. Say so if you'd rather they keep
				MoneyInput.
			</p>
			<Options
				options={[
					{
						name: "Today · Add a bill",
						note: "As it is now: every field in a box at the same volume. Cancel and Save are below where this sheet stops, so a phone scrolls to reach them.",
						screen: <BillToday />,
					},
					{
						name: "Option A · A quiet ledger form",
						picked: true,
						note: "One quiet column: small labels over lines, the amount as the one big thing, Due as a sentence of pickers. Category and the bank's text fold into a row each. Save stays pinned.",
						tradeoff:
							"Category and the bank's text are one tap away, not on show.",
						recommended:
							"one thing is loud, the rest is quiet, and Save is never below the fold.",
						screen: <BillA id="p72-a" bill={RENT} />,
					},
					{
						name: "Option B · One question at a time",
						note: "One question per step, in large type. The step is in the URL and earlier answers ride along, so it needs no script. A last step reads the bill back, with Save.",
						tradeoff:
							"four taps to add a bill, and a fix means jumping back from the summary.",
						screen: billStep,
					},
					{
						name: "Option C · A sentence to fill in",
						note: "The bill as a sentence with its blanks filled in: “Rent costs $1500.00, due on the 1st of every month, in Household.” Each blank is a real control.",
						tradeoff:
							"charming, but long text wraps awkwardly on a phone, a picker replaces the category chips, and errors are harder to place.",
						screen: <BillC id="p72-c" bill={RENT} />,
					},
				]}
			/>
			<p class="max-w-prose text-sm font-medium">
				Add cash, in the same pattern
			</p>
			<Options
				options={[
					{
						name: "Option A · Add cash",
						note: "The amount first and big, then Where and Date on lines; Category and a note fold into rows.",
						screen: <CashA />,
					},
					{
						name: "Option B · Add cash",
						note: "Three questions, then a summary. This is the category question; the date is today until the summary changes it.",
						screen: cashStep,
					},
					{
						name: "Option C · Add cash",
						note: "“I spent $12.50 at Corner Deli on 10/05/2026, in Eating Out.” The note sits on its own line under it.",
						screen: <CashC />,
					},
				]}
			/>
			<p class="max-w-prose text-sm font-medium">
				The longest state of each: a yearly bill
			</p>
			<Options
				options={[
					{
						name: "Option A · The longest state",
						note: "A yearly bill with Category open and a field error. The form scrolls; Save and Cancel don't.",
						screen: <BillA id="p72-a-open" bill={PRIME} open />,
					},
					{
						name: "Option B · The last step",
						note: "The bill read back as a sentence, with a Change line to jump to a step and Save.",
						screen: billSummary,
					},
					{
						name: "Option C · A yearly bill",
						note: "“Amazon Prime costs $139.00, due on the 14th of every year in March, in Household.” One more blank, and one more line.",
						screen: <BillC id="p72-c-year" bill={PRIME} />,
					},
				]}
			/>
		</Specimen>
	);
}
