// P34–P37 (spec §8.5, decision 67): the Phase 3.5 fixes that change what a screen shows. A pending
// charge, the household's time zone, a bill whose price changed, and a bank that stopped syncing.
// Each option is drawn on a phone's first screen from the real components with demo-style data
// (today is Oct 5), so the owner can pick by seeing (decision 47). New pieces are drawn here as
// prototypes, in tokens only, and live on this page until picked. Nothing here is decided yet.

import type { Child } from "hono/jsx";
import { dayLabel, shortDay } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { BillOccurrenceRow, StatusTag } from "../views/bill-occurrence-row";
import type { BillRowData } from "../views/bill-row";
import { BillRow, BillStatusHeading } from "../views/bill-row";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { FormField } from "../views/form-field";
import { HomeTop } from "../views/home-top";
import { Icon } from "../views/icons";
import { ProgressRow } from "../views/progress-row";
import { rowCaption, TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

const TODAY = "2026-10-05";

/** A rule the spec still needs before the feature is built: open, not fixed. */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Rule to write before building: </span>
			{children}
		</p>
	);
}

/** The demo's five categories (src/demo/seed.ts). */
const CATS = {
	groceries: { name: "Groceries", icon: "groceries", color: "cat-blue" },
	eatingOut: { name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	gas: { name: "Gas", icon: "gas", color: "cat-slate" },
	kids: { name: "Kids", icon: "kids", color: "cat-ochre" },
	household: { name: "Household", icon: "household", color: "cat-brown" },
} as const;
type Cat = (typeof CATS)[keyof typeof CATS];

// ---------------------------------------------------------------------------------------------
// P34: the Pending marker.

/** One transaction as the list stores it; no category means it needs one. */
function tx(
	id: number,
	date: string,
	displayName: string,
	rawName: string,
	cents: number,
	cat?: Cat,
): ListRow {
	return {
		id,
		date,
		amountCents: cents,
		rawName,
		displayName,
		note: null,
		excluded: false,
		income: false,
		categoryId: cat ? id : null,
		categoryName: cat?.name ?? null,
		categoryIcon: cat?.icon ?? null,
		categoryColor: cat?.color ?? null,
	};
}

const TRADER_JOES = tx(
	1,
	"2026-10-05",
	"Trader Joe's",
	"TRADER JOE S #552",
	6412,
	CATS.groceries,
);
const LUPITAS = tx(
	2,
	"2026-10-04",
	"Lupita's Taqueria",
	"TST* LUPITAS TAQ",
	2240,
);
const SHELL = tx(3, "2026-10-04", "Shell", "SHELL OIL 57442", 4180, CATS.gas);
const NETFLIX_TX = tx(
	4,
	"2026-10-03",
	"Netflix",
	"NETFLIX.COM",
	1799,
	CATS.household,
);
const TARGET = tx(
	5,
	"2026-10-03",
	"Target",
	"TARGET 00012",
	3827,
	CATS.household,
);

/** The two the bank hasn't finished yet: today's groceries, and last night's tacos (which need a category). */
const PENDING = new Set([TRADER_JOES.id, LUPITAS.id]);

type PendingLook = "caption" | "tag" | "grouped";

/** Option B's mark: a small tag with a solid rule border (a dashed one would mean a suggestion). */
function PendingTag() {
	return (
		<span class="shrink-0 rounded-control border border-rule px-2 text-sm text-ink">
			Pending
		</span>
	);
}

/**
 * A pending row, drawn as TransactionRow draws it (same box, icon, two lines and amount) with the
 * mark added. A: "Pending" on the caption line, never cut off; a row that needs a category says
 * "Pending" where the bank's text would be (the panel still shows it). B: the tag beside the amount.
 */
function PendingRow({ row, look }: { row: ListRow; look: "caption" | "tag" }) {
	const { kind, caption, tag } = rowCaption(row);
	const lead = look === "caption" && kind === "needs" ? null : caption;
	return (
		<li>
			<div class="flex h-16 items-center gap-4 text-ink">
				{row.categoryIcon && row.categoryColor ? (
					<CategoryIcon icon={row.categoryIcon} color={row.categoryColor} />
				) : (
					<span class="shrink-0 text-muted">
						<Icon name="circle-dashed" class="size-7" />
					</span>
				)}
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">
						{row.displayName}
					</span>
					<span class="flex min-w-0 items-center gap-2 leading-6">
						{lead && <span class="truncate text-muted">{lead}</span>}
						{look === "caption" && (
							<span class="shrink-0 text-muted">{lead && "· "}Pending</span>
						)}
						{tag && (
							<span class="shrink-0 rounded-control bg-band px-2 text-sm text-ink">
								Needs category
							</span>
						)}
					</span>
				</span>
				<span class="flex shrink-0 items-center gap-2">
					{look === "tag" && <PendingTag />}
					<span class="text-lg">
						{formatCents(row.amountCents, { signed: true })}
					</span>
				</span>
			</div>
		</li>
	);
}

/** A row in the list: the real TransactionRow, or the prototype when it's pending and A or B is drawn. */
function Row({ row, look }: { row: ListRow; look: PendingLook }) {
	return PENDING.has(row.id) && look !== "grouped" ? (
		<PendingRow row={row} look={look} />
	) : (
		<TransactionRow row={row} />
	);
}

/** A group of rows under its small muted heading, as Transactions groups them by day. */
function DayGroup({
	heading,
	rows,
	look,
}: {
	heading: string;
	rows: ListRow[];
	look: PendingLook;
}) {
	return (
		<>
			<h2 class="mt-3 text-sm text-muted">{heading}</h2>
			<ul class="divide-y divide-rule">
				{rows.map((row) => (
					<Row row={row} look={look} />
				))}
			</ul>
		</>
	);
}

/**
 * Transactions with five rows, two pending. A and B keep the days in order; C lifts the pending
 * rows into their own group at the top, unchanged.
 */
function transactions(look: PendingLook) {
	const day = (date: string) => dayLabel(date, TODAY);
	return (
		<>
			<Title>Transactions</Title>
			<p class="mt-4 text-sm text-muted">14 transactions in October</p>
			{look === "grouped" ? (
				<>
					<DayGroup
						heading="Pending"
						rows={[TRADER_JOES, LUPITAS]}
						look={look}
					/>
					<DayGroup heading={day(SHELL.date)} rows={[SHELL]} look={look} />
				</>
			) : (
				<>
					<DayGroup
						heading={day(TRADER_JOES.date)}
						rows={[TRADER_JOES]}
						look={look}
					/>
					<DayGroup
						heading={day(LUPITAS.date)}
						rows={[LUPITAS, SHELL]}
						look={look}
					/>
				</>
			)}
			<DayGroup
				heading={day(NETFLIX_TX.date)}
				rows={[NETFLIX_TX, TARGET]}
				look={look}
			/>
		</>
	);
}

/** A clock in Lucide's style (1.75 stroke, currentColor); a prototype that joins icons.tsx if A is picked. */
function Clock() {
	return (
		<svg
			class="size-5"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 6v6l4 2" />
		</svg>
	);
}

/**
 * The edit panel for a pending charge. A: a muted line under the date, with a clock, like the
 * Excluded line's transfer icon, saying what pending means. B: the same tag by the amount.
 */
function pendingPanel(look: "caption" | "tag") {
	const amount = formatCents(TRADER_JOES.amountCents, { signed: true });
	return (
		<Sheet behind={transactions(look)}>
			<div>
				<p class="text-sm text-muted">{TRADER_JOES.rawName}</p>
				<h2 class="font-serif text-4xl font-semibold tracking-tight">
					{TRADER_JOES.displayName}
				</h2>
				{look === "tag" ? (
					<p class="flex items-center gap-3">
						<span class="font-serif text-4xl font-semibold">{amount}</span>
						<PendingTag />
					</p>
				) : (
					<p class="font-serif text-4xl font-semibold">{amount}</p>
				)}
				<p class="text-muted">
					{dayLabel(TRADER_JOES.date, TODAY)} · Checking ••1234
				</p>
			</div>
			{look === "caption" && (
				<p class="flex items-start gap-2 text-muted">
					<span class="mt-0.5 shrink-0">
						<Clock />
					</span>
					Pending. The bank hasn't finished it, so its amount can still change.
				</p>
			)}
			<fieldset class="flex flex-col gap-2">
				<legend class="text-base text-ink">Category</legend>
				<div class="flex flex-wrap gap-2">
					{Object.values(CATS).map((c) => (
						<Chip
							type="radio"
							name={`p34-${look}`}
							value={c.name}
							checked={c.name === TRADER_JOES.categoryName}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{c.name}
						</Chip>
					))}
				</div>
			</fieldset>
		</Sheet>
	);
}

// ---------------------------------------------------------------------------------------------
// P35: the household's time zone in Settings.

/** Each demo category's monthly budget this month, in cents (src/demo/seed.ts): $1,700 in all. */
const BUDGETS = {
	groceries: 70000,
	eatingOut: 25000,
	gas: 20000,
	kids: 30000,
	household: 25000,
};
const BUDGET_TOTAL = Object.values(BUDGETS).reduce((n, cents) => n + cents, 0);

/**
 * The end of Settings' Categories list: its last two rows. A phone's first screen can't hold the
 * whole list and the new piece under it, so the picture starts partway down the list.
 */
const SETTINGS_BUDGETS: [Cat, number][] = [
	[CATS.kids, BUDGETS.kids],
	[CATS.household, BUDGETS.household],
];

// The Settings list's summary row and chevron (src/routes/settings.tsx), so a new row has the same shape.
const summaryClass =
	"flex min-h-11 list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden";
const chevron = (
	<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
		<Icon name="chevron-right" class="size-5" />
	</span>
);

/** Settings' Categories section as the page draws it, every row closed, ending in Add category. */
const categoriesSection = (
	<section class="mt-8">
		<h2 class="font-serif text-3xl font-semibold">Categories</h2>
		<div class="mt-3 border-t border-rule">
			{SETTINGS_BUDGETS.map(([c, cents]) => (
				<details class="group border-b border-rule">
					<summary class={summaryClass}>
						<CategoryIcon icon={c.icon} color={c.color} />
						<span class="min-w-0 truncate text-lg font-medium">{c.name}</span>
						<span class="ml-auto shrink-0 tabular-nums">
							{formatCents(cents, { wholeDollars: true })}
							<span class="text-muted"> a month</span>
						</span>
						{chevron}
					</summary>
				</details>
			))}
			<details class="group border-b border-rule">
				<summary class={`${summaryClass} text-accent`}>
					<Icon name="plus" class="size-5" />
					Add category
				</summary>
			</details>
		</div>
	</section>
);

const ZONE_HINT =
	"Decides when a new month starts and when a bill is due. Transactions keep the bank's dates.";

/** The US zones first, by their everyday names, then every other zone (a few shown here). */
const US_ZONES: [string, string][] = [
	["America/New_York", "Eastern"],
	["America/Chicago", "Central"],
	["America/Denver", "Mountain"],
	["America/Los_Angeles", "Pacific"],
	["America/Anchorage", "Alaska"],
	["Pacific/Honolulu", "Hawaii"],
];
const OTHER_ZONES: [string, string][] = [
	["America/Phoenix", "Phoenix"],
	["America/Puerto_Rico", "Puerto Rico"],
	["America/Toronto", "Toronto"],
	["Europe/London", "London"],
];

/** The native select: nothing to script, and a phone shows its own picker. */
function ZoneSelect({
	id,
	attrs,
	others = true,
}: {
	id: string;
	attrs?: Record<string, string>;
	/** Only the "Other time zones" list (option B's chips hold the US ones). */
	others?: "only" | boolean;
}) {
	return (
		<select
			id={id}
			name="time_zone"
			class="min-h-11 rounded-control border border-rule bg-paper px-3 text-lg"
			{...attrs}
		>
			{others !== "only" &&
				US_ZONES.map(([value, label]) => (
					<option value={value} selected={value === "America/New_York"}>
						{label}
					</option>
				))}
			{others && (
				<optgroup label="Other time zones">
					{OTHER_ZONES.map(([value, label]) => (
						<option value={value}>{label}</option>
					))}
				</optgroup>
			)}
		</select>
	);
}

/**
 * The labeled select with its hint, through the real FormField. Inside option A's open row the
 * summary right above already says "Time zone", so the label stays for screen readers only.
 */
function ZoneField({ id, hideLabel }: { id: string; hideLabel?: boolean }) {
	return (
		<FormField id={id} label="Time zone" hideLabel={hideLabel} hint={ZONE_HINT}>
			{(a11y) => <ZoneSelect id={id} attrs={a11y} />}
		</FormField>
	);
}

/** Settings top to bottom: the title, Categories, the new Household section, then Your data. */
function settingsWith(household: Child) {
	return (
		<>
			<Title>Settings</Title>
			{categoriesSection}
			<section class="mt-8 border-t border-rule pt-6">
				<h2 class="font-serif text-3xl font-semibold">Household</h2>
				{household}
			</section>
			<section class="mt-8 border-t border-rule pt-6">
				<h2 class="font-serif text-3xl font-semibold">Your data</h2>
				<p class="mt-1 text-muted">
					Everything Tally has stored, to keep or open elsewhere. Bank logins
					are never included.
				</p>
			</section>
		</>
	);
}

/**
 * P35 A: one disclosure row, "Time zone" with "Eastern" at the right and the chevron at the far
 * right, like a category row. Open, it holds the select, its hint, and Save and Cancel.
 */
function zoneRow(open: boolean) {
	return settingsWith(
		<div class="mt-3 border-t border-rule">
			<details class="group border-b border-rule" open={open}>
				<summary class={summaryClass}>
					<span class="min-w-0 truncate text-lg font-medium">Time zone</span>
					<span class="ml-auto shrink-0">Eastern</span>
					{chevron}
				</summary>
				<div class="flex flex-col gap-4 pb-5">
					<ZoneField id={`p35-a-${open ? "open" : "closed"}`} hideLabel />
					<div class="flex flex-wrap items-center gap-3">
						<Button type="button">Save</Button>
						<Button kind="secondary" type="button">
							Cancel
						</Button>
					</div>
				</div>
			</details>
		</div>,
	);
}

/** P35 B: the six US zones as radio chips, every other zone behind "Other time zones", then Save. */
const zoneChips = settingsWith(
	<fieldset class="mt-3 flex flex-col gap-2" aria-describedby="p35-b-hint">
		<legend class="text-base text-ink">Time zone</legend>
		<div class="flex flex-wrap gap-2">
			{US_ZONES.map(([value, label]) => (
				<Chip
					type="radio"
					name="p35-b"
					value={value}
					checked={value === "America/New_York"}
				>
					{label}
				</Chip>
			))}
		</div>
		<details class="group">
			<summary class="flex min-h-11 list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
				<span class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-5" />
				</span>
				Other time zones
			</summary>
			<FormField id="p35-b-other" label="Other time zones" hideLabel>
				{(a11y) => <ZoneSelect id="p35-b-other" attrs={a11y} others="only" />}
			</FormField>
		</details>
		<p id="p35-b-hint" class="text-sm text-muted">
			{ZONE_HINT}
		</p>
		<div class="mt-2">
			<Button type="button">Save</Button>
		</div>
	</fieldset>,
);

/** P35 C: the labeled select, its hint and Save, always open under the heading. */
const zoneField = settingsWith(
	<div class="mt-3 flex flex-col gap-4">
		<ZoneField id="p35-c" />
		<div>
			<Button type="button">Save</Button>
		</div>
	</div>,
);

// ---------------------------------------------------------------------------------------------
// P36: a bill whose price changed.

const NETFLIX_BILL: BillRowData = {
	id: 1,
	name: "Netflix",
	amountCents: 1549,
	status: "overdue",
	dueDate: "2026-10-02",
	icon: "household",
	color: "cat-brown",
};
/** The payment the matcher left alone: P34's Netflix charge, same merchant and in the date window, but 16% more. */
const NEW_PRICE = { cents: NETFLIX_TX.amountCents, date: NETFLIX_TX.date };

const DUE: BillRowData[] = [
	{
		id: 2,
		name: "City Electric",
		amountCents: 14200,
		status: "due",
		dueDate: "2026-10-09",
		icon: "household",
		color: "cat-brown",
	},
	{
		id: 3,
		name: "Swim lessons",
		amountCents: 6000,
		status: "due",
		dueDate: "2026-10-10",
		icon: "kids",
		color: "cat-ochre",
	},
];
const UPCOMING: BillRowData[] = [
	{
		id: 4,
		name: "Car insurance",
		amountCents: 11800,
		status: "upcoming",
		dueDate: "2026-10-20",
		icon: "gas",
		color: "cat-slate",
	},
];
const PAID: BillRowData[] = [
	{
		id: 5,
		name: "Internet",
		amountCents: 7000,
		status: "paid",
		dueDate: "2026-10-01",
		paidDate: "2026-10-01",
		icon: "household",
		color: "cat-brown",
	},
];

const SOON = [NETFLIX_BILL, ...DUE];
const paidOn = `Paid ${formatCents(NEW_PRICE.cents)} on ${shortDay(NEW_PRICE.date, TODAY)}`;

/** One status group, under its heading, as Bills draws it. */
function BillGroup({
	status,
	children,
}: {
	status: BillRowData["status"];
	children?: Child;
}) {
	return (
		<section class="mt-4">
			<BillStatusHeading status={status} />
			<ul class="divide-y divide-rule">{children}</ul>
		</section>
	);
}

/** Bills as the page draws it: title, sentence, Add a bill, the Band if any, then each group. */
function bills({ overdue, band }: { overdue: Child; band?: Child }) {
	return (
		<>
			<Title>Bills</Title>
			<p class="mt-2 font-serif text-lg italic">
				{SOON.length} bills to pay soon,{" "}
				{formatCents(SOON.reduce((n, b) => n + b.amountCents, 0))} in all
			</p>
			<div class="mt-3">
				<Button kind="secondary" type="button">
					Add a bill
				</Button>
			</div>
			{band}
			<BillGroup status="overdue">{overdue}</BillGroup>
			<BillGroup status="due">
				{DUE.map((b) => (
					<BillRow bill={b} today={TODAY} />
				))}
			</BillGroup>
			<BillGroup status="upcoming">
				{UPCOMING.map((b) => (
					<BillRow bill={b} today={TODAY} />
				))}
			</BillGroup>
			<BillGroup status="paid">
				{PAID.map((b) => (
					<BillRow bill={b} today={TODAY} />
				))}
			</BillGroup>
		</>
	);
}

/** P36 A and C: the Overdue row as today, "Was due Oct 2". */
const overdueToday = <BillRow bill={NETFLIX_BILL} today={TODAY} />;

/**
 * P36 B: the Overdue row drawn as BillRow draws it, with its status line asking instead: "Price
 * changed?" in ink, then the payment in muted words. At 390px both don't fit one truncated line
 * (the date would be cut off), so they take a line each and the row grows by one.
 */
const overdueAsks = (
	<li>
		<span class="flex min-h-16 items-center gap-4 py-2">
			<CategoryIcon icon={NETFLIX_BILL.icon} color={NETFLIX_BILL.color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">
					{NETFLIX_BILL.name}
				</span>
				<span class="block leading-6">Price changed?</span>
				<span class="block leading-6 text-muted">{paidOn}</span>
			</span>
			<span class="shrink-0 text-lg">
				{formatCents(NETFLIX_BILL.amountCents)}
			</span>
		</span>
	</li>
);

/** P36 C: a Band under Add a bill, where the repeat-charge Band sits, leading to the bill's page. */
const priceBand = (
	<div class="mt-4">
		<Band
			href="#p36-price"
			detail={`Netflix: ${formatCents(NEW_PRICE.cents)}, not ${formatCents(NETFLIX_BILL.amountCents)}`}
		>
			1 bill may have a new price
		</Band>
	</div>
);

/**
 * Every option: Netflix's page. The newest month asks, with the payment's amount and date; Update
 * links that payment and changes the amount from this month on, and Not this bill leaves it Overdue.
 */
const billPage = (
	<>
		<a href="#p36-price" class="inline-flex min-h-11 items-center">
			Bills
		</a>
		<p class="text-sm text-muted">NETFLIX.COM</p>
		<h1 class="font-serif text-5xl font-semibold tracking-tight">Netflix</h1>
		<p class="text-lg">
			{formatCents(NETFLIX_BILL.amountCents)} a month, due the 2nd
		</p>
		<h2 class="mt-6 text-sm text-muted">Payments</h2>
		<ul class="divide-y divide-rule border-y border-rule">
			<li class="py-2">
				<p class="flex justify-between gap-3">
					<span class="text-lg">October</span>
					<StatusTag status="overdue" />
				</p>
				<p class="mt-1 text-lg">
					Netflix charged {formatCents(NEW_PRICE.cents)} on{" "}
					{shortDay(NEW_PRICE.date, TODAY)}, not{" "}
					{formatCents(NETFLIX_BILL.amountCents)}.
				</p>
				<p class="text-muted">
					Updating the bill links that payment and makes it{" "}
					{formatCents(NEW_PRICE.cents)} a month from October on.
				</p>
				<div class="mt-3">
					<Button type="button">
						Update the bill to {formatCents(NEW_PRICE.cents)}
					</Button>
				</div>
				<Button kind="text" type="button" class="-ml-2">
					Not this bill
				</Button>
			</li>
			<BillOccurrenceRow
				billId={1}
				period="2026-09"
				label="September"
				status="paid"
				payment={{
					displayName: "Netflix",
					dateLabel: "Sep 2",
					amountCents: 1549,
					matchedBy: "auto",
				}}
			/>
			<BillOccurrenceRow
				billId={1}
				period="2026-08"
				label="August"
				status="paid"
				payment={{
					displayName: "Netflix",
					dateLabel: "Aug 2",
					amountCents: 1549,
					matchedBy: "auto",
				}}
			/>
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// P37: a bank that needs attention or hasn't synced, flagged on Home (family app only).

/**
 * October's counted spending so far, in cents, by category: Household is P34's Target and Netflix
 * charges, and the 4 transactions that need a category add up to $96 (the Band says so).
 */
const SPENT = {
	groceries: 19600,
	eatingOut: 9200,
	gas: 4800,
	kids: 6000,
	household: TARGET.amountCents + NETFLIX_TX.amountCents,
	uncategorized: 9600,
};
/**
 * Safe to spend as §6 adds it up: the whole budget, less every counted dollar (uncategorized too),
 * less the bills that are due or overdue and unpaid (P36's three, $217.49): $934 here.
 */
const SAFE_TO_SPEND =
	BUDGET_TOTAL -
	Object.values(SPENT).reduce((n, cents) => n + cents, 0) -
	SOON.reduce((n, b) => n + b.amountCents, 0);

const HOME = {
	month: "October",
	safeToSpendCents: SAFE_TO_SPEND,
	status: "Everything is on track.",
};
const NEEDS_BAND = {
	href: "#p37-bank",
	text: "4 transactions need a category",
	detail: `${formatCents(SPENT.uncategorized, { wholeDollars: true })} of this month's spending`,
};
const HOME_ROWS = [
	{ cat: CATS.groceries, spent: SPENT.groceries, budget: BUDGETS.groceries },
	{ cat: CATS.eatingOut, spent: SPENT.eatingOut, budget: BUDGETS.eatingOut },
	{ cat: CATS.gas, spent: SPENT.gas, budget: BUDGETS.gas },
	{ cat: CATS.kids, spent: SPENT.kids, budget: BUDGETS.kids },
];

const SYNC_LATE = "Chase hasn't synced since Oct 1";
const SIGN_IN = "Chase needs you to sign in again";

/** Home's top as given, then the Budget heading and its first rows (the real ProgressRow). */
function home(top: Child) {
	return (
		<>
			{top}
			<h2 class="mt-8 font-serif text-3xl font-semibold">Budget</h2>
			<ul class="mt-2 divide-y divide-rule">
				{HOME_ROWS.map(({ cat, spent, budget }) => (
					<ProgressRow
						name={cat.name}
						icon={cat.icon}
						color={cat.color}
						spentCents={spent}
						budgetCents={budget}
					/>
				))}
			</ul>
		</>
	);
}

/**
 * P37 A: a line under the status sentence, before the Band: an alert icon and ink words (it isn't
 * over budget, so not brick), what it means for the number above, and a 44px link to Accounts.
 */
function bankLine(words: string) {
	return home(
		<>
			<HomeTop {...HOME} />
			<div class="mt-3 flex items-start gap-2">
				<span class="mt-0.5 shrink-0">
					<Icon name="alert" class="size-5" />
				</span>
				<div>
					<p>{words}, so Safe to spend may be too high.</p>
					<a href="#p37-bank" class="inline-flex min-h-11 items-center">
						Check Accounts
					</a>
				</div>
			</div>
			<div class="mt-2">
				<Band href={NEEDS_BAND.href} detail={NEEDS_BAND.detail}>
					{NEEDS_BAND.text}
				</Band>
			</div>
		</>,
	);
}

/** P37 B: the bank takes Home's one Band until it's fixed; the needs-category Band waits. */
const bankBand = home(
	<HomeTop
		{...HOME}
		band={{
			href: "#p37-bank",
			text: "Chase needs attention",
			detail: "It hasn't synced since Oct 1, so Safe to spend may be too high.",
		}}
	/>,
);

/**
 * P37 C: a thin tinted strip above the month, the whole strip one link to Accounts. Terracotta
 * never sits on band, so its words are ink and a chevron says it leads somewhere.
 */
const bankStrip = home(
	<>
		<a
			href="#p37-bank"
			class="-mx-5 -mt-2 mb-4 flex min-h-11 items-center gap-2 bg-band px-5 text-sm text-ink no-underline"
		>
			<Icon name="alert" class="size-4 shrink-0" />
			<span class="min-w-0 flex-1">{SYNC_LATE} · Accounts</span>
			<Icon name="chevron-right" class="size-4 shrink-0" />
		</a>
		<HomeTop {...HOME} band={NEEDS_BAND} />
	</>,
);

/** P34–P37 on the proposals page, open for the owner's pick. */
export function Phase35Proposals() {
	return (
		<>
			<Specimen
				id="p34-pending"
				title="P34 · The Pending marker"
				tier="visual"
				sentence="A charge the bank hasn't finished counts in your numbers now, so the list says which ones they are. Pick where the word goes."
			>
				<Fixed>
					a pending transaction counts like any other and shows the word
					“Pending”. When the bank posts it under a new id, the person's
					category, note, exclusion and every link move to the posted one, and
					so does a split if the amount is unchanged (§6, decision 67).
				</Fixed>
				<NeedsLine>
					how Pending sits on a row whose caption already says more (Excluded,
					Split from…, Refund for…, Counts in…), and the panel's words, which
					are a draft here.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · In the caption line",
							picked: true,
							note: "The line under the name says “Groceries · Pending”, in muted words; it's never cut off.",
							tradeoff:
								"quiet, so a pending row is found by reading, not at a glance, and a row that also needs a category shows “Pending” where the bank's text would be.",
							recommended:
								"it's words, it's quiet, and the sign appears once per row.",
							screen: transactions("caption"),
						},
						{
							name: "Option A · The edit panel",
							note: "Under the date, a muted line with a clock says what pending means. C's panel says it the same way.",
							screen: pendingPanel("caption"),
						},
						{
							name: "Option B · A small tag",
							note: "A small “Pending” tag with a solid rule border beside the amount (a dashed one would mean a suggestion, §7), and the same tag by the amount in the panel.",
							tradeoff:
								"easy to spot, but it takes the name's room (Lupita's bank text shrinks to “T…”), and a row needing a category carries two tags.",
							screen: transactions("tag"),
						},
						{
							name: "Option B · The edit panel",
							note: "The tag sits by the amount; the panel doesn't say why it matters.",
							screen: pendingPanel("tag"),
						},
						{
							name: "Option C · Grouped first",
							note: "A small muted “Pending” heading over the pending rows at the top of the list; the rows are unchanged.",
							tradeoff:
								"the list is no longer in date order, and a pending row's day shows only in its panel.",
							screen: transactions("grouped"),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p35-time-zone"
				title="P35 · The household's time zone"
				tier="visual"
				sentence="Your household's time zone decides which day it is for Tally: when a new month starts and when a bill is due. Pick how the choice sits in Settings."
			>
				<Fixed>
					“today”, which decides the current month and bill status, is the
					household's date in its time zone, a Settings choice that starts as
					Eastern (America/New_York); a transaction's own date is never
					converted (§6, decision 67). Detecting the zone from the browser is on
					the Later list, because it needs its own allowed-JS decision (§12).
				</Fixed>
				<NeedsLine>
					which zones the list offers (the six US ones first, then others, as
					drawn), and that a change applies at once, so the month and the bills'
					statuses can change the moment it's saved.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A disclosure row",
							picked: true,
							note: "Under a Household heading, one row, “Time zone” with “Eastern” and the chevron, shaped like a category row.",
							tradeoff: "the choice is one tap away, not in view.",
							recommended:
								"it's rarely changed, so it rests as one quiet row like everything else in Settings.",
							screen: zoneRow(false),
						},
						{
							name: "Option A · Opened",
							note: "The row opens in place to a select (US zones first, then every other), its hint, and Save.",
							screen: zoneRow(true),
						},
						{
							name: "Option B · Chips",
							note: "The six US zones as chips, every other zone behind “Other time zones”, then Save.",
							tradeoff:
								"every US zone in view, but a lot for a choice made once, and two controls set one value.",
							screen: zoneChips,
						},
						{
							name: "Option C · Always-open field",
							note: "The labeled select, its hint and Save, always open under the heading.",
							tradeoff:
								"no tap to open, but a form sits on Settings every visit and pushes Your data down.",
							screen: zoneField,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p36-price"
				title="P36 · “Price changed? Update the bill”"
				tier="visual"
				sentence={`When a bill's price goes up, its payment falls outside the ±10% match, so the bill sits Overdue though it's paid, and Safe to spend sets aside its ${formatCents(NETFLIX_BILL.amountCents)} on top of the ${formatCents(NEW_PRICE.cents)} already spent. Tally offers the payment instead. Pick where it asks.`}
			>
				<Fixed>
					a payment from the same merchant outside ±10% is offered as “Price
					changed? Update the bill” rather than ignored (§8.5). Editing a bill
					changes this month and later, never past occurrences (§8.4, A9; its
					amount history is P61).
				</Fixed>
				<NeedsLine>
					the offer only looks at payments inside §6.1's ±5-day window and not
					already linked; if two qualify, the one closest to the due date, as
					§6.1 picks. Nothing changes until a person taps Update the bill, which
					links that payment and sets the new amount from this month on. Not
					this bill remembers that payment for that month, as Not this one does.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · On the bill's page only",
							note: "Bills stays as today, Netflix under Overdue; the question waits on Netflix's page (drawn last).",
							tradeoff:
								"the list says Overdue with no hint why, so you find out only by opening the bill.",
							screen: bills({ overdue: overdueToday }),
						},
						{
							name: "Option B · On the row and the page",
							picked: true,
							note: `The Overdue row says “Price changed? ${paidOn}” and leads to the question on the bill's page.`,
							tradeoff:
								"the row no longer says the day it was due, and it grows a line.",
							recommended:
								"the question appears where the confusing Overdue is, and is answered on the bill's page.",
							screen: bills({ overdue: overdueAsks }),
						},
						{
							name: "Option C · A Band on Bills",
							note: "A Band, “1 bill may have a new price”, leads to the bill's page; the row is unchanged.",
							tradeoff:
								"Bills already has the repeat-charge Band, and with one Band per screen they'd take turns.",
							screen: bills({ overdue: overdueToday, band: priceBand }),
						},
						{
							name: "All three · The bill's page",
							note: "The newest month asks, with Update the bill as the one primary action and Not this bill under it as text.",
							screen: billPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p37-bank"
				title="P37 · A bank that stopped syncing, on Home"
				tier="visual"
				sentence="When a bank needs you to sign in again, or hasn't synced for 3 days, Safe to spend may be too high. Pick how Home says so. The family app only."
			>
				<Fixed>
					a connected bank (not a disconnected one) that needs attention or
					hasn't synced for 3 days is flagged on Home with a link to Accounts,
					because Safe to spend may be too high (§8.5). Accounts already shows
					each bank's last sync and Fix connection (§8, §8.1). The demo has no
					Plaid, so it never shows this (§4.1). Home's one Band is the
					needs-category one (decision 50).
				</Fixed>
				<NeedsLine>
					a bank that both needs signing in and hasn't synced says the sign-in
					words; with two or more banks, the line names the first and counts the
					rest; the line goes once the bank is fixed or syncs again.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line under the number",
							picked: true,
							note: `Between the sentence and the Band: an alert icon, “${SYNC_LATE}, so Safe to spend may be too high.”, and Check Accounts.`,
							tradeoff: "one more line before the Band.",
							recommended:
								"it sits by the number it affects and leaves the one Band for the one action.",
							family: true,
							screen: bankLine(SYNC_LATE),
						},
						{
							name: "Option A · When it needs signing in",
							note: "The same line, worded for a bank whose login needs fixing.",
							family: true,
							screen: bankLine(SIGN_IN),
						},
						{
							name: "Option B · It takes the Band",
							note: "While a bank needs attention, the Band says so and leads to Accounts; the needs-category Band waits.",
							tradeoff:
								"sorting is hidden until the bank is fixed, which can take days.",
							family: true,
							screen: bankBand,
						},
						{
							name: "Option C · A strip above the month",
							note: `A thin tinted strip at the top, “${SYNC_LATE} · Accounts”, all one link.`,
							tradeoff:
								"a second band-tinted row beside the Band, against one tinted row per screen, and its words are ink, not a terracotta link.",
							family: true,
							screen: bankStrip,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
