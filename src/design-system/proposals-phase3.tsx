// P15–P22 (spec §11 Phase 3, decisions 57 and 58): bills, splits, and the four features joining
// Phase 3, each option drawn on a phone's first screen from the real components with demo-style
// data, so the owner can pick them all in one pass. Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon, type IconName } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { PhoneFrame, Specimen } from "./specimen";

type Option = {
	name: string;
	/** What it is, in one plain line. */
	note: string;
	/** What it costs, in one line. */
	tradeoff?: string;
	/** Why it's the recommended one, in one line. */
	recommended?: string;
	/** Drawn at desktop width instead of on a phone. */
	desktop?: boolean;
	screen: Child;
};

/** A proposal's options side by side, each named, described and weighed above its picture. */
function Options({ options }: { options: Option[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{options.map((o) => (
				<div
					class={`flex ${o.desktop ? "w-[722px]" : "w-[392px]"} max-w-full flex-col gap-2`}
				>
					<div class={`flex flex-col gap-1 ${o.tradeoff ? "lg:min-h-52" : ""}`}>
						<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
							{o.name}
							{o.recommended && (
								<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
									Recommended
								</span>
							)}
						</h4>
						<p class="text-sm">{o.note}</p>
						{o.tradeoff && (
							<p class="text-sm text-muted">Trade-off: {o.tradeoff}</p>
						)}
						{o.recommended && (
							<p class="text-sm text-muted">Why: {o.recommended}</p>
						)}
					</div>
					{o.desktop ? (
						<DesktopFrame label={`${o.name}, on desktop`}>
							{o.screen}
						</DesktopFrame>
					) : (
						<PhoneFrame label={`${o.name}, on a phone`}>{o.screen}</PhoneFrame>
					)}
				</div>
			))}
		</div>
	);
}

/** A desktop window's first screen, cropped: a picture, with nothing inside to Tab to. */
function DesktopFrame({
	label,
	children,
}: {
	label: string;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={label}
				class="h-[560px] w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert class="px-8 pt-8">
					{children}
				</div>
			</div>
		</div>
	);
}

/** What the spec and decisions already fix for a proposal, so no option contradicts them. */
function Fixed({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Already fixed by the spec: </span>
			{children}
		</p>
	);
}

function Title({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-4xl font-semibold tracking-tight">{children}</h1>
	);
}

/**
 * The BottomSheet as it sits on a phone, drawn in place: the real one is fixed to the viewport, so
 * it can't sit inside a picture. The page behind it shows, dimmed, above its top edge.
 */
function Sheet({
	behind,
	top = "top-20",
	children,
}: {
	behind?: Child;
	/** How far down the screen the sheet starts (a Tailwind top-* class). */
	top?: "top-10" | "top-20" | "top-40" | "top-64";
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[686px] overflow-hidden">
			<div class="px-5">{behind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div
				class={`absolute inset-x-0 bottom-0 ${top} flex flex-col gap-3 overflow-hidden rounded-t-sheet bg-paper p-5`}
			>
				{children}
			</div>
		</div>
	);
}

/** The edit panel's top: the bank's text, the name and amount in the serif, then date and account. */
function SheetHead({
	raw,
	name,
	cents,
	meta,
}: {
	raw?: string;
	name: string;
	cents: number;
	meta: string;
}) {
	return (
		<div>
			{raw && <p class="text-sm text-muted">{raw}</p>}
			<h2 class="font-serif text-4xl font-semibold tracking-tight">{name}</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(cents, { signed: true })}
			</p>
			<p class="text-muted">{meta}</p>
		</div>
	);
}

/** Cancel and the primary action, side by side, as in the edit panel. */
function SheetActions({ primary }: { primary: string }) {
	return (
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				{primary}
			</Button>
		</div>
	);
}

/** An open no-JavaScript disclosure, as the edit panel draws "Rename or add a note". */
function Disclosure({ label, children }: { label: string; children?: Child }) {
	return (
		<details open class="group border-t border-rule">
			<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
				<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-5" />
				</span>
				{label}
			</summary>
			<div class="flex flex-col gap-3 pt-1">{children}</div>
		</details>
	);
}

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style (today is Sep 29).

const CATS = {
	groceries: { id: 1, name: "Groceries", icon: "groceries", color: "cat-blue" },
	eatingOut: {
		id: 2,
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
	},
	gas: { id: 3, name: "Gas", icon: "gas", color: "cat-slate" },
	kids: { id: 4, name: "Kids", icon: "kids", color: "cat-ochre" },
	household: {
		id: 5,
		name: "Household",
		icon: "household",
		color: "cat-brown",
	},
	utilities: {
		id: 6,
		name: "Utilities",
		icon: "utilities",
		color: "cat-slate",
	},
} as const;
type Cat = (typeof CATS)[keyof typeof CATS];

/** A list row; `caption` stands in for the category line where a proposal adds to it. */
function tx(
	id: number,
	displayName: string,
	amountCents: number,
	cat: Cat | null,
	caption?: string,
): ListRow {
	return {
		id,
		date: "2026-09-01",
		amountCents,
		rawName: displayName,
		displayName,
		note: null,
		excluded: false,
		income: false,
		categoryId: cat?.id ?? null,
		categoryName: caption ?? cat?.name ?? null,
		categoryIcon: cat?.icon ?? null,
		categoryColor: cat?.color ?? null,
	};
}

const CHIP_CATS: Cat[] = [
	CATS.groceries,
	CATS.eatingOut,
	CATS.gas,
	CATS.kids,
	CATS.household,
];

function CategoryChips({
	name,
	type = "radio",
	checked = [],
}: {
	name: string;
	type?: "radio" | "checkbox";
	checked?: number[];
}) {
	return (
		<div class="flex flex-wrap gap-2">
			{CHIP_CATS.map((c) => (
				<Chip
					type={type}
					name={name}
					value={String(c.id)}
					checked={checked.includes(c.id)}
					icon={<CategoryIcon icon={c.icon} color={c.color} />}
				>
					{c.name}
				</Chip>
			))}
		</div>
	);
}

/** A select drawn as the Transactions filter pills are. */
function Pick({ label, value }: { label: string; value: string }) {
	return (
		<label class="flex flex-col gap-1">
			<span class="sr-only">{label}</span>
			<select class="min-h-11 rounded-full border border-rule bg-paper px-4 text-base text-ink">
				<option selected>{value}</option>
			</select>
		</label>
	);
}

// Bill status is always a word and an icon (spec §6; DESIGN.md: never color alone). Green and brick
// are the only status colors; due is ink and upcoming is muted.
type Status = "paid" | "due" | "overdue" | "upcoming";
const STATUS: Record<Status, [IconName, string, string]> = {
	overdue: ["alert", "text-over", "Overdue"],
	due: ["bills", "text-ink", "Due"],
	upcoming: ["bills", "text-muted", "Upcoming"],
	paid: ["check", "text-ok", "Paid"],
};

type Bill = {
	name: string;
	cents: number;
	status: Status;
	when: string;
	cat: { icon: string; color: string };
};

const BILLS: Bill[] = [
	{
		name: "Electric",
		cents: 14200,
		status: "overdue",
		when: "Was due Sep 24",
		cat: CATS.utilities,
	},
	{
		name: "Rent",
		cents: 185000,
		status: "due",
		when: "Due Oct 1",
		cat: { icon: "rent", color: "cat-brown" },
	},
	{
		name: "Internet",
		cents: 6500,
		status: "due",
		when: "Due Oct 2",
		cat: { icon: "subscriptions", color: "cat-plum" },
	},
	{
		name: "Car insurance",
		cents: 11840,
		status: "due",
		when: "Due Oct 4",
		cat: { icon: "car", color: "cat-blue" },
	},
	{
		name: "Phone",
		cents: 8500,
		status: "upcoming",
		when: "Due Oct 15",
		cat: { icon: "subscriptions", color: "cat-plum" },
	},
	{
		name: "Water",
		cents: 4820,
		status: "paid",
		when: "Paid Sep 23, 3 days late",
		cat: CATS.utilities,
	},
	{
		name: "Streaming",
		cents: 1549,
		status: "paid",
		when: "Paid Sep 12",
		cat: { icon: "entertainment", color: "cat-ochre" },
	},
];

/** A status in words with its icon, as a small tag (the TransactionRow's "Needs category" shape). */
function StatusTag({ status }: { status: Status }) {
	const [icon, tone, word] = STATUS[status];
	return (
		<span class="inline-flex shrink-0 items-center gap-1 rounded-control bg-band px-2 text-sm text-ink">
			<span class={tone}>
				<Icon name={icon} class="size-4" />
			</span>
			{word}
		</span>
	);
}

/** One bill: its category icon, name, when, amount, and (in one list) its status tag. */
function BillRow({ bill, tag }: { bill: Bill; tag?: boolean }) {
	return (
		<li class="flex h-16 items-center gap-4">
			<CategoryIcon icon={bill.cat.icon} color={bill.cat.color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{bill.name}</span>
				<span class="flex min-w-0 items-center gap-2 leading-6">
					{tag && <StatusTag status={bill.status} />}
					<span class="truncate text-muted">
						{tag ? bill.when.replace(/^Paid /, "") : bill.when}
					</span>
				</span>
			</span>
			<span class="shrink-0 text-lg">{formatCents(bill.cents)}</span>
		</li>
	);
}

const toPay = BILLS.filter((b) => b.status === "overdue" || b.status === "due");
const toPaySentence = `${toPay.length} bills to pay soon, ${formatCents(toPay.reduce((s, b) => s + b.cents, 0))} in all.`;

/** The Bills screen's top: title, what's owed in a sentence, and Add a bill. */
function BillsTop() {
	return (
		<>
			<Title>Bills</Title>
			<p class="mt-2 font-serif text-lg italic">{toPaySentence}</p>
			<div class="mt-3">
				<Button kind="secondary" type="button">
					Add a bill
				</Button>
			</div>
		</>
	);
}

const GROUPS: [Status, string][] = [
	["overdue", "Overdue"],
	["due", "Due in the next 7 days"],
	["upcoming", "Upcoming"],
	["paid", "Paid this month"],
];

/** The bills grouped under a heading per status, each heading with its icon (P15 A). */
function BillsGrouped({ only }: { only?: Status[] }) {
	return (
		<>
			{GROUPS.filter(([s]) => !only || only.includes(s)).map(([s, heading]) => {
				const [icon, tone] = STATUS[s];
				return (
					<section class="mt-4">
						<h2 class="flex items-center gap-2 text-sm text-muted">
							<span class={tone}>
								<Icon name={icon} class="size-4" />
							</span>
							{heading}
						</h2>
						<ul class="divide-y divide-rule">
							{BILLS.filter((b) => b.status === s).map((b) => (
								<BillRow bill={b} />
							))}
						</ul>
					</section>
				);
			})}
		</>
	);
}

/** P15 A: grouped by status, overdue first. */
const billsGrouped = (
	<>
		<BillsTop />
		<BillsGrouped />
		<p class="mt-2 flex min-h-11 items-center border-t border-rule text-accent">
			Inactive (1)
		</p>
	</>
);

/** P15 B: one list in due-date order, a status tag on every row. */
const billsOneList = (
	<>
		<BillsTop />
		<ul class="mt-4 divide-y divide-rule">
			{[
				BILLS[6],
				BILLS[5],
				BILLS[0],
				BILLS[1],
				BILLS[2],
				BILLS[3],
				BILLS[4],
			].map((b) => b && <BillRow bill={b} tag />)}
		</ul>
		<p class="mt-2 flex min-h-11 items-center border-t border-rule text-accent">
			Inactive (1)
		</p>
	</>
);

/** P15, both: adding or editing a bill, with Deactivate as the form's extra text action. */
const billForm = (
	<Sheet behind={billsGrouped} top="top-10">
		<h2 class="font-serif text-4xl font-semibold tracking-tight">Electric</h2>
		<TextInput id="p15-name" label="Name" value="Electric" surface="paper" />
		<MoneyInput
			id="p15-amount"
			name="p15-amount"
			label="Amount"
			value="142.00"
		/>
		<div class="flex flex-wrap items-end gap-3">
			<TextInput
				id="p15-day"
				label="Due day"
				value="24"
				surface="paper"
				class="w-24"
			/>
			<fieldset class="flex flex-col gap-1">
				<legend class="text-base text-ink">How often</legend>
				<div class="flex gap-2">
					<Chip type="radio" name="p15-often" value="m" checked>
						Monthly
					</Chip>
					<Chip type="radio" name="p15-often" value="y">
						Yearly
					</Chip>
				</div>
			</fieldset>
		</div>
		<TextInput
			id="p15-merchant"
			label="Paid to (the bank's text)"
			value="CITY POWER & LIGHT"
			surface="paper"
		/>
		<div class="flex items-center justify-between gap-3">
			<Button type="button">Save</Button>
			<Button kind="text" type="button">
				Deactivate
			</Button>
		</div>
	</Sheet>
);

// ---------------------------------------------------------------------------------------------
// P16: a bill's occurrences and the payment linked to each.

type Occurrence = {
	month: string;
	status: Status;
	line: string;
	action: string;
};

const OCCURRENCES: Occurrence[] = [
	{
		month: "September",
		status: "overdue",
		line: "No payment linked yet",
		action: "Link a payment",
	},
	{
		month: "August",
		status: "paid",
		line: "City Power & Light · Aug 25 · $139.12",
		action: "Not this one",
	},
	{
		month: "July",
		status: "paid",
		line: "CPL Autopay · Jul 23 · $151.80 · by hand",
		action: "Not this one",
	},
];

function Occurrences() {
	return (
		<ul class="divide-y divide-rule border-y border-rule">
			{OCCURRENCES.map((o) => (
				<li class="py-2">
					<p class="flex items-center justify-between gap-3">
						<span class="text-lg">{o.month}</span>
						<StatusTag status={o.status} />
					</p>
					<p class="text-muted">{o.line}</p>
					<Button kind="text" type="button" class="-ml-2">
						{o.action}
					</Button>
				</li>
			))}
		</ul>
	);
}

/** P16 A: its own page, reached from the Bills list. */
const billPage = (
	<>
		<a href="#p16-bill" class="inline-flex min-h-11 items-center gap-1">
			Bills
		</a>
		<p class="text-sm text-muted">CITY POWER & LIGHT</p>
		<Title>Electric</Title>
		<p class="text-lg">$142.00 a month, due the 24th</p>
		<p class="mt-4 text-sm text-muted">Payments</p>
		<Occurrences />
		<div class="mt-3 flex items-center justify-between">
			<Button kind="secondary" type="button">
				Edit bill
			</Button>
			<Button kind="text" type="button">
				Deactivate
			</Button>
		</div>
	</>
);

/** P16 B: the same, in a bottom sheet over the Bills list. */
const billSheet = (
	<Sheet behind={billsGrouped} top="top-20">
		<div>
			<p class="text-sm text-muted">CITY POWER & LIGHT</p>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">Electric</h2>
			<p class="text-lg">$142.00 a month, due the 24th</p>
		</div>
		<Occurrences />
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Close
			</Button>
			<Button kind="secondary" type="button" class="w-full">
				Edit bill
			</Button>
		</div>
	</Sheet>
);

/** P16, both: linking a payment by hand to one occurrence. */
const linkPicker = (
	<>
		<Title>Link a payment</Title>
		<p class="mt-2 text-lg">To September's Electric, $142.00.</p>
		<p class="mt-1 text-muted">
			Payments not linked to another bill, closest to Sep 24 first.
		</p>
		<fieldset class="mt-4 flex flex-col gap-2">
			<legend class="sr-only">Payment</legend>
			<Chip type="radio" name="p16-pick" value="1" checked>
				CPL Autopay · Sep 27 · $142.00
			</Chip>
			<Chip type="radio" name="p16-pick" value="2">
				City Power & Light · Sep 3 · $12.00
			</Chip>
			<Chip type="radio" name="p16-pick" value="3">
				Online transfer · Sep 22 · $150.00
			</Chip>
		</fieldset>
		<div class="mt-5 flex items-center gap-3">
			<Button type="button">Link</Button>
			<Button kind="text" type="button">
				Cancel
			</Button>
		</div>
		<p class="mt-6 border-t border-rule pt-3 text-sm text-muted">
			"Not this one" on a linked payment unlinks it, and Tally won't suggest it
			for that month again.
		</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// P17: splitting a transaction in the edit panel.

const COSTCO = 18742;
const costcoHead = (
	<SheetHead
		raw="COSTCO WHSE #0431"
		name="Costco"
		cents={COSTCO}
		meta="Sep 9 · Checking ••4410"
	/>
);

const transactionsBehind = (
	<>
		<Title>Transactions</Title>
		<ul class="mt-2 divide-y divide-rule">
			<TransactionRow row={tx(1, "Costco", COSTCO, CATS.groceries)} />
		</ul>
	</>
);

/** P17 A: part rows, each a category and an amount, with what's left always in view. */
const splitRows = (
	<Sheet behind={transactionsBehind} top="top-10">
		{costcoHead}
		<p class="flex items-center justify-between gap-3 border-t border-rule pt-3">
			<span class="text-lg font-medium">$25.42 left to assign</span>
			<Button kind="text" type="button">
				Add a part
			</Button>
		</p>
		<div class="flex flex-col gap-2">
			<Pick label="Part 1 category" value="Groceries" />
			<MoneyInput
				id="p17a-1"
				name="p17a-1"
				label="Part 1 amount"
				value="150.00"
			/>
		</div>
		<div class="flex flex-col gap-2 border-t border-rule pt-3">
			<Pick label="Part 2 category" value="Household" />
			<MoneyInput
				id="p17a-2"
				name="p17a-2"
				label="Part 2 amount"
				value="12.00"
			/>
		</div>
		<SheetActions primary="Save split" />
	</Sheet>
);

/** P17 B: pick the categories first, then the amounts, with Even split. */
const splitChoose = (
	<Sheet behind={transactionsBehind} top="top-10">
		{costcoHead}
		<fieldset class="flex flex-col gap-2 border-t border-rule pt-3">
			<legend class="text-base text-ink">1. Split between</legend>
			<CategoryChips
				name="p17b"
				type="checkbox"
				checked={[CATS.groceries.id, CATS.household.id]}
			/>
		</fieldset>
		<div class="flex items-center justify-between gap-3">
			<p class="text-base">2. How much each</p>
			<Button kind="secondary" type="button">
				Even split
			</Button>
		</div>
		<p class="flex items-center gap-2 text-lg font-medium">
			<span class="text-ok">
				<Icon name="check" class="size-5" />
			</span>
			Adds up to {formatCents(COSTCO)}
		</p>
		<MoneyInput id="p17b-1" name="p17b-1" label="Groceries" value="93.71" />
		<MoneyInput id="p17b-2" name="p17b-2" label="Household" value="93.71" />
	</Sheet>
);

// ---------------------------------------------------------------------------------------------
// P18: bills found from recurring charges.

type Found = { name: string; raw: string; cents: number; seen: string };
const FOUND: Found[] = [
	{
		name: "Youth Soccer League",
		raw: "YOUTH SOCCER LEAGUE",
		cents: 9000,
		seen: "6 charges, around the 8th",
	},
	{
		name: "YouTube",
		raw: "GOOGLE *YOUTUBE",
		cents: 1399,
		seen: "6 charges, around the 18th",
	},
	{
		name: "Apple",
		raw: "APPLE.COM/BILL",
		cents: 299,
		seen: "5 charges, around the 16th",
	},
];

/** One found charge: what it is, how often it was seen, and Add or Not a bill. */
function FoundRow({ f }: { f: Found }) {
	return (
		<>
			<p class="flex items-baseline justify-between gap-3 text-lg">
				<span>{f.name}</span>
				<span>About {formatCents(f.cents)}</span>
			</p>
			<p class="text-sm text-muted">
				{f.raw} · {f.seen}
			</p>
			<div class="mt-2 flex items-center gap-3">
				<Button kind="secondary" type="button">
					Add
				</Button>
				<Button kind="text" type="button">
					Not a bill
				</Button>
			</div>
		</>
	);
}

/** P18 A: the Band on Bills, the one next thing to do. */
const foundBand = (
	<>
		<BillsTop />
		<div class="mt-4">
			<Band href="#p18-found" detail="Charges that repeat about monthly">
				3 possible bills found
			</Band>
		</div>
		<BillsGrouped only={["overdue", "due"]} />
	</>
);

/** P18 A: the review list the Band opens. */
const foundReview = (
	<>
		<a href="#p18-found" class="inline-flex min-h-11 items-center">
			Bills
		</a>
		<Title>Possible bills</Title>
		<p class="mt-2 text-muted">
			About the same amount, about a month apart. Nothing becomes a bill until
			you add it.
		</p>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			{FOUND.map((f) => (
				<li class="py-3">
					<FoundRow f={f} />
				</li>
			))}
		</ul>
	</>
);

/** P18 B: suggestions at the top of the list, outlined dashed ("not decided yet"). */
const foundInline = (
	<>
		<BillsTop />
		<h2 class="mt-4 text-sm text-muted">Suggested from repeat charges</h2>
		<ul class="mt-2 flex flex-col gap-2">
			{FOUND.slice(0, 2).map((f) => (
				<li class="rounded-control border border-dashed border-muted px-3 py-2">
					<FoundRow f={f} />
				</li>
			))}
		</ul>
		<p class="mt-1 text-sm text-muted">And 1 more</p>
		<BillsGrouped only={["overdue", "due"]} />
	</>
);

// ---------------------------------------------------------------------------------------------
// P19: a refund linked to its purchase.

const REFUND = -2499;
const PURCHASE = 8499;

/** P19 A: the refund's panel asks which purchase it refunds. */
const refundSide = (
	<Sheet behind={transactionsBehind} top="top-10">
		<SheetHead
			raw="TARGET T-1432"
			name="Target"
			cents={REFUND}
			meta="Sep 26 · Credit card ••8812"
		/>
		<fieldset class="flex flex-col gap-2 border-t border-rule pt-3">
			<legend class="text-base text-ink">Category</legend>
			<CategoryChips name="p19a-cat" checked={[CATS.kids.id]} />
		</fieldset>
		<Disclosure label="This refunds…">
			<p class="text-sm text-muted">Target purchases in the last 90 days</p>
			<Chip type="radio" name="p19a" value="1" checked>
				Sep 5 · $84.99 · Kids
			</Chip>
			<Chip type="radio" name="p19a" value="2">
				Aug 14 · $42.10 · Household
			</Chip>
			<Chip type="radio" name="p19a" value="3">
				Jul 30 · $19.99 · Kids
			</Chip>
		</Disclosure>
		<SheetActions primary="Save" />
	</Sheet>
);

/** P19 B: the purchase's panel asks which refund came back for it. */
const purchaseSide = (
	<Sheet behind={transactionsBehind} top="top-10">
		<SheetHead
			raw="TARGET T-1432"
			name="Target"
			cents={PURCHASE}
			meta="Sep 5 · Credit card ••8812"
		/>
		<fieldset class="flex flex-col gap-2 border-t border-rule pt-3">
			<legend class="text-base text-ink">Category</legend>
			<CategoryChips name="p19b-cat" checked={[CATS.kids.id]} />
		</fieldset>
		<Disclosure label="Refunded by…">
			<p class="text-sm text-muted">Money back from Target since Sep 5</p>
			<Chip type="radio" name="p19b" value="1" checked>
				Sep 26 · +$24.99
			</Chip>
		</Disclosure>
		<SheetActions primary="Save" />
	</Sheet>
);

/** P19, both: how a linked pair reads in the list, on the row's own caption line. */
const refundPair = (
	<>
		<Title>Transactions</Title>
		<p class="mt-4 text-sm text-muted">Saturday, Sep 26</p>
		<ul class="divide-y divide-rule">
			<TransactionRow
				row={tx(1, "Target", REFUND, CATS.kids, "Kids · Refund for Sep 5")}
			/>
			<TransactionRow row={tx(2, "Thai Palace", 5200, CATS.eatingOut)} />
		</ul>
		<p class="mt-3 text-sm text-muted">Saturday, Sep 5</p>
		<ul class="divide-y divide-rule">
			<TransactionRow
				row={tx(3, "Target", PURCHASE, CATS.kids, "Kids · $24.99 refunded")}
			/>
			<TransactionRow row={tx(4, "Shell", 4820, CATS.gas)} />
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// P20: selecting several transactions at once.

const SELECT_ROWS: [ListRow, boolean][] = [
	[tx(1, "Trader Joe's", 6410, CATS.groceries), false],
	[tx(2, "Venmo J Rivera", 4000, null), true],
	[tx(3, "Paypal Xyzshop", 2349, null), true],
	[tx(4, "Mario's Pizza", 6430, CATS.eatingOut), false],
	[tx(5, "Amzn Mktp US", 2799, null), true],
	[tx(6, "Chevron", 4800, CATS.gas), false],
];

/** The selection mark: an empty ring, or the Chip's checked look (band, ink edge and a check). */
function Mark({ on }: { on: boolean }) {
	return on ? (
		<span class="flex size-7 shrink-0 items-center justify-center rounded-full border border-ink bg-band">
			<Icon name="check" class="size-4" />
		</span>
	) : (
		<span class="size-7 shrink-0 rounded-full border border-muted" />
	);
}

function SelectList({ rows }: { rows: [ListRow, boolean][] }) {
	return (
		<div class="divide-y divide-rule">
			{rows.map(([row, on]) => (
				<div class="flex items-center gap-3">
					<Mark on={on} />
					<ul class="min-w-0 flex-1">
						<TransactionRow row={row} />
					</ul>
				</div>
			))}
		</div>
	);
}

function SelectBar() {
	return (
		<div class="flex flex-wrap items-center gap-2 border-t border-ink bg-paper py-3">
			<p class="mr-auto text-lg">3 selected</p>
			<Button kind="secondary" type="button" class="px-3">
				Set category
			</Button>
			<Button kind="secondary" type="button" class="px-3">
				Exclude
			</Button>
		</div>
	);
}

/** P20 A: Select turns the rows into checkboxes, with a bar pinned above the tab bar. */
const selectMode = (
	<div class="flex h-[686px] flex-col">
		<div class="flex items-center justify-between gap-3">
			<Title>Transactions</Title>
			<Button kind="text" type="button">
				Done
			</Button>
		</div>
		<p class="mt-2 text-sm text-muted">Tap rows to select them.</p>
		<p class="mt-3 text-sm text-muted">Sunday, Sep 20</p>
		<SelectList rows={SELECT_ROWS} />
		<div class="mt-auto">
			<SelectBar />
		</div>
	</div>
);

/** P20 B: on desktop the checkboxes are always there, and the bar appears over the list. */
const selectDesktop = (
	<>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			Transactions
		</h1>
		<div class="mt-4">
			<SelectBar />
		</div>
		<p class="text-sm text-muted">Sunday, Sep 20</p>
		<SelectList rows={SELECT_ROWS} />
	</>
);

// ---------------------------------------------------------------------------------------------
// P21: a cash transaction added by hand.

const listRows = (
	<>
		<p class="mt-4 text-sm text-muted">Today</p>
		<ul class="divide-y divide-rule">
			<TransactionRow
				row={tx(1, "Farmers market", 2000, CATS.groceries, "Groceries · Cash")}
			/>
			<TransactionRow row={tx(2, "Local Bakery", 1200, null)} />
		</ul>
		<p class="mt-3 text-sm text-muted">Sunday, Sep 27</p>
		<ul class="divide-y divide-rule">
			<TransactionRow row={tx(3, "Trader Joe's", 6410, CATS.groceries)} />
			<TransactionRow row={tx(4, "Thai Palace", 5200, CATS.eatingOut)} />
		</ul>
	</>
);

/** P21 A: an Add cash button under the Transactions title. */
const cashButton = (
	<>
		<Title>Transactions</Title>
		<div class="mt-3">
			<Button kind="secondary" type="button" class="gap-2">
				<Icon name="plus" class="size-5" />
				Add cash
			</Button>
		</div>
		{listRows}
	</>
);

/** P21 B: a round + pinned on Transactions and Home, above the Feedback button. */
const cashFloating = (
	<div class="relative h-[686px]">
		<Title>September</Title>
		<p class="mt-4 text-muted">Safe to spend</p>
		<p class="font-serif text-6xl font-semibold">$283</p>
		<p class="mt-2 font-serif text-lg italic">About $28 a day for 10 days.</p>
		<div class="mt-4">
			<Band href="#p21-cash" detail="$228.01 of this month's spending">
				12 transactions need a category
			</Band>
		</div>
		<span class="absolute right-0 bottom-20 flex size-14 items-center justify-center rounded-full bg-ink text-paper">
			<Icon name="plus" class="size-7" />
		</span>
		<span class="absolute right-0 bottom-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-ink bg-paper px-4 text-sm font-medium text-ink">
			<Icon name="message" class="size-5" />
			Feedback
		</span>
	</div>
);

/** P21, both: the form, in the edit panel's shape. */
const cashForm = (
	<Sheet behind={cashButton} top="top-10">
		<h2 class="font-serif text-4xl font-semibold tracking-tight">
			Add cash spending
		</h2>
		<MoneyInput
			id="p21-amount"
			name="p21-amount"
			label="Amount"
			value="20.00"
		/>
		<div class="grid grid-cols-2 gap-3">
			<TextInput
				id="p21-date"
				label="Date"
				type="date"
				value="2026-09-29"
				surface="paper"
			/>
			<TextInput
				id="p21-where"
				label="Where"
				value="Farmers market"
				surface="paper"
			/>
		</div>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-base text-ink">Category</legend>
			<CategoryChips name="p21-cat" checked={[CATS.groceries.id]} />
		</fieldset>
		<TextInput
			id="p21-note"
			label="Note (optional)"
			value="Peaches and eggs"
			surface="paper"
		/>
		<SheetActions primary="Add" />
	</Sheet>
);

// ---------------------------------------------------------------------------------------------
// P22: a late bill payment counted in its bill's month.

/** P22 A: linking a payment from the bill, choosing which month's bill it pays. */
const countsLink = (
	<>
		<Title>Link a payment</Title>
		<p class="mt-2 text-lg">To Water, $48.20 a month, due the 28th.</p>
		<fieldset class="mt-4 flex flex-col gap-2">
			<legend class="text-base text-ink">Payment</legend>
			<Chip type="radio" name="p22a-pay" value="1" checked>
				City Water · Sep 2 · $48.20
			</Chip>
		</fieldset>
		<fieldset class="mt-4 flex flex-col gap-2">
			<legend class="text-base text-ink">
				Which month's bill does it pay?
			</legend>
			<div class="flex flex-wrap gap-2">
				<Chip type="radio" name="p22a-month" value="08" checked>
					August
				</Chip>
				<Chip type="radio" name="p22a-month" value="09">
					September
				</Chip>
			</div>
			<p class="text-sm text-muted">
				It counts in August's spending, not September's. The bank's date stays
				Sep 2.
			</p>
		</fieldset>
		<div class="mt-5 flex items-center gap-3">
			<Button type="button">Link</Button>
			<Button kind="text" type="button">
				Cancel
			</Button>
		</div>
		<p class="mt-8 text-sm text-muted">Then, in Transactions</p>
		<p class="mt-1 text-sm text-muted">Wednesday, Sep 2</p>
		<ul class="divide-y divide-rule">
			<TransactionRow
				row={tx(
					1,
					"City Water",
					4820,
					CATS.utilities,
					"Utilities · Counts in August",
				)}
			/>
			<TransactionRow row={tx(2, "Trader Joe's", 6418, CATS.groceries)} />
		</ul>
	</>
);

/** P22 B: the payment's own edit panel, shown only when it pays a bill. */
const countsPanel = (
	<Sheet behind={transactionsBehind} top="top-10">
		<SheetHead
			raw="CITY WATER DEPT"
			name="City Water"
			cents={4820}
			meta="Sep 2 · Checking ••4410"
		/>
		<p class="flex items-center gap-2 text-muted">
			<Icon name="bills" class="size-5" />
			Pays the Water bill
		</p>
		<fieldset class="flex flex-col gap-2 border-t border-rule pt-3">
			<legend class="text-base text-ink">Counts toward</legend>
			<div class="flex flex-wrap gap-2">
				<Chip type="radio" name="p22b" value="08" checked>
					August's bill
				</Chip>
				<Chip type="radio" name="p22b" value="09">
					September's bill
				</Chip>
			</div>
			<p class="text-sm text-muted">
				Choosing a month links it to that month's Water bill. The bank's date
				stays Sep 2.
			</p>
		</fieldset>
		<SheetActions primary="Save" />
	</Sheet>
);

/** The eight open proposals, P15–P22. */
export function Phase3Proposals() {
	return (
		<>
			<Specimen
				id="p15-bills"
				title="P15 · The Bills screen"
				tier="visual"
				sentence="Every active bill with its status in a word and an icon (paid, due, overdue, upcoming), plus Add a bill, and edit and deactivate in its form. Pick how the list is ordered."
			>
				<Fixed>
					"Due" means due within the next 7 days (§6), so the group says that
					rather than "this week". Status colors are green and brick only; "due"
					is ink and "upcoming" muted, each with its word.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Grouped by status",
							note: "Overdue, Due in the next 7 days, Upcoming, then Paid this month, each under a heading with its icon.",
							tradeoff:
								"a bill moves between groups as its status changes, so it isn't always in the same place.",
							recommended:
								"what needs paying is at the top, and each status is said once, not on every row (a sign appears once).",
							screen: billsGrouped,
						},
						{
							name: "Option B · One list by due date",
							note: "Every bill in due-date order, each with a small status tag.",
							tradeoff:
								"the order never jumps, but an overdue bill can sit below paid ones and the tag repeats on every row.",
							screen: billsOneList,
						},
						{
							name: "Both · Add or edit a bill",
							note: "The form in a bottom sheet; Deactivate is its text action, and inactive bills wait under Inactive (1).",
							screen: billForm,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p16-bill"
				title="P16 · A bill's payments"
				tier="visual"
				sentence="A bill's months, each with the payment linked to it: Link a payment by hand, or Not this one to unlink. Pick where it opens."
			>
				<Fixed>
					unlinking records a dismissal, so the matcher never picks that payment
					for that month again (§6.1); one payment per month and one bill per
					payment. The spec doesn't yet say which transactions the hand picker
					lists; drawn here as unlinked payments nearest the due date, which
					would need a line in §6.1.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Its own page",
							note: "Tapping a bill opens /bills/:id: its details, every month's payment, Edit bill and Deactivate.",
							tradeoff:
								"one more page to build and a Back link, but it has room for a long history.",
							recommended:
								"a year of months and the picker need room, and a page has its own address to come back to.",
							screen: billPage,
						},
						{
							name: "Option B · A bottom sheet over Bills",
							note: "The same content in the BottomSheet, like the Transactions edit panel.",
							tradeoff:
								"the list stays in place, but a long history scrolls inside the sheet and the picker becomes a sheet on a sheet.",
							screen: billSheet,
						},
						{
							name: "Both · Link a payment",
							note: "Pick the transaction that paid this month's bill; the link is marked as made by hand.",
							screen: linkPicker,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p17-split"
				title="P17 · Split a transaction"
				tier="visual"
				sentence="In the Transactions edit panel: divide one purchase between categories. Pick how the parts are entered."
			>
				<Fixed>
					the parts must add up exactly to the whole, or the save is rejected
					with a field error (§6.1, §10). A live "left to assign" line needs no
					new script: the form re-asks the server as you type (htmx), and the
					line is an aria-live announcer. Even split gives any leftover cent to
					the first part.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Parts with what's left",
							note: "Each part is a category and a money input; one line says how much is left to assign, and Add a part adds a row.",
							tradeoff:
								"each money input is tall, so three or more parts scroll.",
							recommended:
								"real splits are uneven (Costco groceries versus household), and what's left is always in view.",
							screen: splitRows,
						},
						{
							name: "Option B · Categories, then amounts",
							note: "Tick the categories first, then set each amount; Even split fills them in.",
							tradeoff:
								"two steps, and Even split is rarely the real answer, but it's quick for a shared bill.",
							screen: splitChoose,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p18-found"
				title="P18 · Find bills from repeat charges"
				tier="visual"
				sentence="Tally suggests bills from merchants that charge about the same amount about monthly; a person adds each one or says it isn't a bill. Pick where the suggestions appear."
			>
				<Fixed>
					nothing becomes a bill without a person (AI suggests, code calculates,
					people decide): Add opens the bill form filled in. The finding is
					code, not AI. "Not a bill" has to be remembered, which the data model
					doesn't have yet (a new column or table in §5).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · A Band, then a review list",
							note: "“3 possible bills found” is the Band on Bills; it opens a list with Add and Not a bill on each.",
							tradeoff: "one more tap to see them, and a second page.",
							recommended:
								"the Band is already the one next action on a screen, and the bills list stays only real bills.",
							screen: foundBand,
						},
						{
							name: "Option B · Suggested rows at the top",
							note: "Dashed rows (dashed means not decided yet) above the bills, each with Add and Not a bill.",
							tradeoff:
								"no extra tap, but suggestions push the overdue bill down and mix guesses with real bills.",
							screen: foundInline,
						},
						{
							name: "Option A, next · The review list",
							note: "Where A's Band leads: what each one is, how often it was seen, and the two choices.",
							screen: foundReview,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p19-refund"
				title="P19 · Link a refund to its purchase"
				tier="visual"
				sentence="A refund (money back, a negative amount) points at the purchase it refunds. Pick which edit panel the link is made from; the list reads the same either way."
			>
				<Fixed>
					a refund already reduces its category's spending in its own month
					(§6). The spec doesn't say what linking changes (for example, the
					refund taking the purchase's category), nor has the data model a
					column for the link; both need adding to §5 and §6.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · From the refund",
							note: "The refund's panel has “This refunds…”, listing the same merchant's purchases from the last 90 days.",
							tradeoff:
								"only shown on money in, and an old purchase can fall outside the 90 days.",
							recommended:
								"the refund is what's new and unfamiliar when it arrives, so that's where a person asks what it's for.",
							screen: refundSide,
						},
						{
							name: "Option B · From the purchase",
							note: "The purchase's panel has “Refunded by…”, listing the same merchant's money in since that date.",
							tradeoff:
								"shown on every purchase though few are refunded, and a person must remember which purchase it was.",
							screen: purchaseSide,
						},
						{
							name: "Both · The pair in the list",
							note: "Each row's caption line says it: “Refund for Sep 5” and “$24.99 refunded”, with no third line.",
							screen: refundPair,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p20-select"
				title="P20 · Select several transactions"
				tier="visual"
				sentence="Set a category, or exclude, for many transactions at once. Pick how selecting starts."
			>
				<Fixed>
					no new script without a decision (CLAUDE.md): selection is a form of
					checkboxes, Select is a link to the same list with ?select=1, and the
					count updates through htmx. Long-press would need custom JavaScript
					(decision 45), so it isn't drawn.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · A Select button",
							note: "Select (beside the filters) turns rows into checkboxes; a bar pinned above the tab bar says how many and offers Set category and Exclude.",
							tradeoff: "one tap to start selecting, on every screen size.",
							recommended:
								"the same on phone and desktop, and rows stay single links to their panel the rest of the time.",
							screen: selectMode,
						},
						{
							name: "Option B · Always there on desktop",
							note: "On desktop every row has a checkbox and the bar appears above the list once one is ticked; phones use Select as in A.",
							tradeoff:
								"no mode on desktop, but two behaviors to learn and a checkbox beside every row that's rarely used.",
							desktop: true,
							screen: selectDesktop,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p21-cash"
				title="P21 · Add cash spending"
				tier="visual"
				sentence="A hand-entered transaction for cash, with date, amount, where, category and note. Pick where Add lives; the form is the same."
			>
				<Fixed>
					amounts are cents and money out is positive (Plaid's convention), so
					the form records spending only. The data model needs a place for
					these: an account named Cash and a transaction with no Plaid id (today
					only split parts have none), both new lines in §5.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Add cash on Transactions",
							note: "A secondary button under the title opens the form in the edit panel; the row then says Cash.",
							tradeoff: "on one screen only, so it's two taps from Home.",
							recommended:
								"cash is rare, and a floating button would sit on top of Feedback and compete with Home's Band.",
							screen: cashButton,
						},
						{
							name: "Option B · A round + on Transactions and Home",
							note: "A button pinned above Feedback on both screens opens the same form.",
							tradeoff:
								"always in reach, but it stacks two pinned buttons over the list and adds a second primary action to Home.",
							screen: cashFloating,
						},
						{
							name: "Both · The form",
							note: "The edit panel's shape: amount first, then date, where, category and a note.",
							screen: cashForm,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p22-counts"
				title="P22 · Count a payment in its bill's month"
				tier="visual"
				sentence="A late payment (Sep 2 for August's water bill) counts in August's spending instead of September's, never both; the bank's date doesn't change. Pick where the month is chosen."
			>
				<Fixed>
					the month comes from the bill month the payment is linked to (§6,
					decision 58), not from a separate setting, and only an earlier month
					moves it. So B's picker is drawn as choosing which month's bill it
					pays (relinking), not as a free month field.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · When linking, from the bill",
							note: "Linking a payment asks which month's bill it pays; the row then says “Counts in August” on its caption line.",
							tradeoff:
								"only reachable from the bill, not from the transaction.",
							recommended:
								"the month and the link are one choice made in one place, which is exactly how the spec counts it.",
							screen: countsLink,
						},
						{
							name: "Option B · Counts toward, in the edit panel",
							note: "A payment linked to a bill shows “Counts toward” in its own panel, with that bill's months.",
							tradeoff:
								"findable from the transaction, but relinking a bill from Transactions is a second place to do it.",
							screen: countsPanel,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
