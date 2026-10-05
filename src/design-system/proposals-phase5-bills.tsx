// P57–P61 (spec §8.4, decision 66; D1–D3 and A9 from decision 67): more bill frequencies, partial
// payments, a bill's category on its payments, a monthly bills total, and a bill's amount history.
// Each option is drawn on a phone's first screen from the real components with demo-style data
// (today is Mon Oct 5), so the owner can pick by seeing (decision 47). Amounts are worked out here
// from integer cents, the way the rules will, so every picture adds up. Nothing here is decided
// until the owner picks.

import type { Child } from "hono/jsx";
import type { BillStatus } from "../bills/status";
import { dayLabel } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { BillOccurrenceRow, StatusTag } from "../views/bill-occurrence-row";
import { BillMonthExplanation } from "../views/bill-payment-picker";
import {
	BillRow,
	type BillRowData,
	BillStatusHeading,
	billStatusLine,
} from "../views/bill-row";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { Specimen } from "./specimen";

/** A rule the spec still needs before the feature is built. */
function NeedsLine({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">Rule to write before building: </span>
			{children}
		</p>
	);
}

const TODAY = "2026-10-05";
export const dollars = (cents: number) =>
	formatCents(cents, { wholeDollars: true });

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: October, five days in.

type Cat = { name: string; icon: string; color: string };
const KIDS: Cat = { name: "Kids", icon: "kids", color: "cat-ochre" };
const GAS: Cat = { name: "Gas", icon: "gas", color: "cat-slate" };
const GROCERIES: Cat = {
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
};
const HOUSEHOLD: Cat = {
	name: "Household",
	icon: "household",
	color: "cat-brown",
};
export const RENT_CAT: Cat = { name: "Rent", icon: "rent", color: "cat-slate" };
export const UTILITIES: Cat = {
	name: "Utilities",
	icon: "utilities",
	color: "cat-blue",
};

/** A bill as Bills lists it; a paid one was paid on its due date. */
export const bill = (
	id: number,
	name: string,
	amountCents: number,
	status: BillStatus,
	dueDate: string,
	cat: Cat,
): BillRowData => ({
	id,
	name,
	amountCents,
	status,
	dueDate,
	paidDate: status === "paid" ? dueDate : undefined,
	icon: cat.icon,
	color: cat.color,
});

export const ELECTRIC = bill(
	1,
	"City Electric",
	14200,
	"due",
	"2026-10-08",
	HOUSEHOLD,
);
const DAYCARE = bill(2, "Daycare", 24000, "due", "2026-10-09", KIDS);
const SWIM = bill(3, "Swim lessons", 6000, "due", "2026-10-10", KIDS);
export const INTERNET = bill(
	4,
	"Internet",
	7000,
	"upcoming",
	"2026-10-18",
	HOUSEHOLD,
);
export const CAR = bill(
	5,
	"Car insurance",
	11800,
	"upcoming",
	"2026-10-20",
	GAS,
);
const RENT = bill(6, "Rent", 120000, "paid", "2026-10-01", RENT_CAT);
/** A yearly bill: paid in March, so Bills shows next March's as Upcoming. */
const SOCCER = bill(7, "Youth soccer", 54000, "upcoming", "2027-03-15", KIDS);

const rows = (bills: BillRowData[]) =>
	bills.map((b) => <BillRow bill={b} today={TODAY} />);
const sum = (bills: BillRowData[]) =>
	bills.reduce((n, b) => n + b.amountCents, 0);
/** Bills' status sentence, as the page writes it. */
export const toPay = (n: number, cents: number) =>
	`${n} ${n === 1 ? "bill" : "bills"} to pay soon, ${formatCents(cents)} in all`;

/**
 * A BillRow with its status sentence given, for the proposals that change what the row says. `side`
 * is a muted small line under the amount.
 */
export function LineRow({
	bill: b,
	line,
	side,
}: {
	bill: BillRowData;
	line: string;
	side?: string;
}) {
	return (
		<li>
			<span class="flex min-h-16 items-center gap-4">
				<CategoryIcon icon={b.icon} color={b.color} />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">{b.name}</span>
					<span class="block truncate leading-6 text-muted">{line}</span>
				</span>
				<span class="shrink-0 text-right">
					<span class="block text-lg">{formatCents(b.amountCents)}</span>
					{side && (
						<span class="block text-sm leading-5 text-muted">{side}</span>
					)}
				</span>
			</span>
		</li>
	);
}

type Group = {
	status: BillStatus;
	/** Drawn at the right of the group's heading (P60 B). */
	total?: string;
	rows: Child;
};

/** Bills as the page draws it: title, sentence, Add a bill, then each group once under its heading. */
function BillsScreen({
	sentence,
	under,
	groups,
}: {
	sentence: string;
	/** A line under the sentence (P60 A). */
	under?: Child;
	groups: Group[];
}) {
	return (
		<>
			<Title>Bills</Title>
			<p class="mt-2 font-serif text-lg italic">{sentence}</p>
			{under}
			<div class="mt-3">
				<Button kind="secondary" type="button">
					Add a bill
				</Button>
			</div>
			{groups.map((g) => (
				<section class="mt-4">
					{g.total ? (
						<div class="flex items-center justify-between gap-3">
							<BillStatusHeading status={g.status} />
							<span class="text-sm text-muted">{g.total}</span>
						</div>
					) : (
						<BillStatusHeading status={g.status} />
					)}
					<ul class="divide-y divide-rule">{g.rows}</ul>
				</section>
			))}
		</>
	);
}

/** A bill's own page as the route draws it: back link, the bank's text, name, amount line, Payments. */
function BillPage({
	merchant,
	name,
	line,
	under,
	children,
}: {
	merchant: string;
	name: string;
	line: string;
	/** A line under the amount line (P61). */
	under?: Child;
	children?: Child;
}) {
	return (
		<>
			<a href="#bills" class="inline-flex min-h-11 items-center">
				Bills
			</a>
			<p class="text-sm text-muted">{merchant}</p>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">{name}</h1>
			<p class="text-lg">{line}</p>
			{under}
			<h2 class="mt-6 text-sm text-muted">Payments</h2>
			<ul class="divide-y divide-rule border-y border-rule">{children}</ul>
		</>
	);
}

/** A payment the matcher linked, in BillOccurrenceRow's shape. */
const paidWith = (
	displayName: string,
	dateLabel: string,
	amountCents: number,
) => ({ displayName, dateLabel, amountCents, matchedBy: "auto" as const });

/** The Bills screen's top, dimmed behind a sheet. */
const billsBehind = (
	<>
		<Title>Bills</Title>
		<p class="mt-2 font-serif text-lg italic">
			{toPay(2, ELECTRIC.amountCents + DAYCARE.amountCents)}
		</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// P57: weekly, every-two-weeks and quarterly bills. Daycare is $240 every Friday: October has
// five of them (the 2nd, 9th, 16th, 23rd and 30th), and the 2nd is paid.

const FRIDAYS = [
	"2026-10-02",
	"2026-10-09",
	"2026-10-16",
	"2026-10-23",
	"2026-10-30",
];
const FRIDAYS_PAID = 1;
const DAYCARE_AMOUNT = formatCents(DAYCARE.amountCents);

/** P57 A and B: Bills with Daycare as one row; only its sentence differs. */
function weeklyList(daycareLine: string) {
	return (
		<BillsScreen
			sentence={toPay(2, ELECTRIC.amountCents + DAYCARE.amountCents)}
			groups={[
				{
					status: "due",
					rows: (
						<>
							{rows([ELECTRIC])}
							<LineRow bill={DAYCARE} line={daycareLine} />
						</>
					),
				},
				{ status: "upcoming", rows: rows([INTERNET]) },
				{ status: "paid", rows: rows([RENT]) },
			]}
		/>
	);
}

/** P57 A: the next Friday that isn't paid, with its status for this week, and how often it repeats. */
const weeklyOneByOne = weeklyList(
	`${billStatusLine(DAYCARE, TODAY)} · every Friday`,
);

/** P57 B: the month's Fridays counted together. */
const weeklySummary = weeklyList(
	`${FRIDAYS_PAID} of ${FRIDAYS.length} paid this month`,
);

/** P57 A: the bill's page lists each Friday with its own status and payment, newest first. */
const weeklyPage = (
	<BillPage
		merchant="LITTLE SPROUTS DAYCARE"
		name="Daycare"
		line={`${DAYCARE_AMOUNT} every Friday`}
	>
		<BillOccurrenceRow
			billId={2}
			period="2026-10-16"
			label="Fri, Oct 16"
			status="upcoming"
		/>
		<BillOccurrenceRow
			billId={2}
			period="2026-10-09"
			label="Fri, Oct 9"
			status="due"
		/>
		<BillOccurrenceRow
			billId={2}
			period="2026-10-02"
			label="Fri, Oct 2"
			status="paid"
			payment={paidWith("Little Sprouts", "Oct 2", DAYCARE.amountCents)}
		/>
		<BillOccurrenceRow
			billId={2}
			period="2026-09-25"
			label="Fri, Sep 25"
			status="paid"
			payment={paidWith("Little Sprouts", "Sep 25", DAYCARE.amountCents)}
		/>
		<BillOccurrenceRow
			billId={2}
			period="2026-09-18"
			label="Fri, Sep 18"
			status="not-paid"
		/>
	</BillPage>
);

/**
 * The Add a bill sheet, drawn in place: it grows to 90% of the screen's height, so only a strip of
 * the page shows above it, and the whole form fits.
 */
function FormSheet({ children }: { children?: Child }) {
	return (
		<div class="relative -mx-5 h-[686px] overflow-hidden">
			<div class="px-5">{billsBehind}</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div class="absolute inset-x-0 bottom-0 top-12 overflow-hidden rounded-t-sheet bg-paper p-5">
				<div class="flex flex-col gap-3">{children}</div>
			</div>
		</div>
	);
}

/** A labeled select, as the form's Month field draws it. */
function Pick({
	label,
	options,
	value,
}: {
	label: string;
	options: string[];
	value: string;
}) {
	return (
		<label class="flex flex-col gap-1">
			<span>{label}</span>
			<select class="min-h-11 rounded-control border border-rule bg-paper px-3">
				{options.map((o) => (
					<option selected={o === value}>{o}</option>
				))}
			</select>
		</label>
	);
}

const DAYS = "Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(
	" ",
);
const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
	new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
		new Date(Date.UTC(2026, i, 1)),
	),
);
const FREQUENCIES = [
	["monthly", "Monthly"],
	["yearly", "Yearly"],
	["weekly", "Weekly"],
	["biweekly", "Every two weeks"],
	["quarterly", "Quarterly"],
] as const;
const FORM_CATEGORIES = [KIDS, HOUSEHOLD, GAS];
/** The bill filled in for each new frequency: one that really repeats that often. */
const FORM_BILLS = {
	weekly: { name: "Daycare", amount: "240.00", category: KIDS },
	biweekly: {
		name: "House cleaner",
		amount: "110.00",
		category: HOUSEHOLD,
	},
	quarterly: { name: "Water and sewer", amount: "186.00", category: HOUSEHOLD },
} as const;

/**
 * P57: the Add a bill form (src/routes/bills.tsx) with the five frequencies as radio Chips, and the
 * one field each new frequency needs. The field shows by CSS alone, as the yearly Month does today.
 */
function frequencyForm(id: string, often: "weekly" | "biweekly" | "quarterly") {
	const { name, amount, category } = FORM_BILLS[often];
	return (
		<FormSheet>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<TextInput id={`${id}-name`} label="Name" value={name} surface="paper" />
			<MoneyInput
				id={`${id}-amount`}
				name={`${id}-amount`}
				label="Amount"
				value={amount}
			/>
			<fieldset>
				<legend>How often</legend>
				<div class="mt-1 flex flex-wrap gap-2">
					{FREQUENCIES.map(([value, label]) => (
						<Chip
							type="radio"
							name={`${id}-often`}
							value={value}
							checked={value === often}
						>
							{label}
						</Chip>
					))}
				</div>
			</fieldset>
			{often === "weekly" && (
				<Pick label="Day of the week" options={DAYS} value="Friday" />
			)}
			{often === "biweekly" && (
				<TextInput
					id={`${id}-paid`}
					label="A date it was paid"
					type="date"
					value="2026-10-02"
					hint="Then every two weeks from that date. Next: Oct 16."
					surface="paper"
				/>
			)}
			{often === "quarterly" && (
				<>
					<div class="flex flex-wrap items-end gap-3">
						<TextInput
							id={`${id}-day`}
							label="Due day"
							value="15"
							surface="paper"
							class="w-24"
							inputmode="numeric"
						/>
						<Pick label="First month" options={MONTH_NAMES} value="October" />
					</div>
					<p class="text-sm text-muted">
						Then every 3 months: October, January, April and July.
					</p>
				</>
			)}
			<fieldset>
				<legend>Category</legend>
				<div class="mt-1 flex flex-wrap gap-2">
					{FORM_CATEGORIES.map((c) => (
						<Chip
							type="radio"
							name={`${id}-category`}
							value={c.name}
							checked={c.name === category.name}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{c.name}
						</Chip>
					))}
				</div>
			</fieldset>
		</FormSheet>
	);
}

// ---------------------------------------------------------------------------------------------
// P58: partial payments. Rent is $1,200 on the 1st. October has had $600 so far; September was
// paid in two payments, $700 and $500.

const RENT_OVERDUE = bill(6, "Rent", 120000, "overdue", "2026-10-01", RENT_CAT);
const PAID_SO_FAR = 60000;
const partPaid = `Part paid: ${dollars(PAID_SO_FAR)} of ${dollars(RENT_OVERDUE.amountCents)}`;

/** P58 A: Bills says it on the row, and sets aside only what's left of the rent. */
const partPaidList = (
	<BillsScreen
		sentence={toPay(
			2,
			RENT_OVERDUE.amountCents - PAID_SO_FAR + ELECTRIC.amountCents,
		)}
		groups={[
			{
				status: "overdue",
				rows: <LineRow bill={RENT_OVERDUE} line={partPaid} />,
			},
			{ status: "due", rows: rows([ELECTRIC]) },
			{ status: "upcoming", rows: rows([INTERNET, CAR]) },
		]}
	/>
);

/** One linked payment on the rent's page, with its own Not this one. */
const rentPayment = (date: string, cents: number) => (
	<div>
		<p class="text-muted">
			Harbor Property · {date} · {formatCents(cents)} · by hand
		</p>
		<Button kind="text" type="button" class="-ml-2">
			Not this one
		</Button>
	</div>
);
/** Rent's August: one payment, as every occurrence looks today. */
const augustRent = (
	<BillOccurrenceRow
		billId={6}
		period="2026-08"
		label="August"
		status="paid"
		payment={paidWith("Harbor Property", "Aug 1", RENT.amountCents)}
	/>
);

/** P58 A: the rent's page; October takes a second payment, and September's two made it Paid. */
const partPaidPage = (
	<BillPage
		merchant="HARBOR PROPERTY MGMT"
		name="Rent"
		line={`${formatCents(RENT.amountCents)} a month, due the 1st`}
	>
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">October</span>
				<StatusTag status="overdue" />
			</p>
			<p class="text-lg">{partPaid}</p>
			{rentPayment("Oct 1", PAID_SO_FAR)}
			<Button kind="text" type="button" class="-ml-2">
				Link another payment
			</Button>
		</li>
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">September</span>
				<StatusTag status="paid" />
			</p>
			<p class="text-lg">Paid in two payments</p>
			{rentPayment("Sep 1", 70000)}
			{rentPayment("Sep 3", 50000)}
		</li>
		{augustRent}
	</BillPage>
);

/** P58 B: a month with no payment linked can be marked paid by hand, and undone. */
const markPaidPage = (
	<BillPage
		merchant="HARBOR PROPERTY MGMT"
		name="Rent"
		line={`${formatCents(RENT.amountCents)} a month, due the 1st`}
	>
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">October</span>
				<StatusTag status="overdue" />
			</p>
			<p class="text-muted">No payment linked yet</p>
			<div class="flex flex-wrap">
				<Button kind="text" type="button" class="-ml-2">
					Link a payment
				</Button>
				<Button kind="text" type="button">
					Mark as paid
				</Button>
			</div>
		</li>
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">September</span>
				<StatusTag status="paid" />
			</p>
			<p class="text-muted">Marked as paid, no payment linked</p>
			<Button kind="text" type="button" class="-ml-2">
				Undo
			</Button>
		</li>
		{augustRent}
	</BillPage>
);

// ---------------------------------------------------------------------------------------------
// P59: a bill's category on its payments. Harbor Property ($1,200, Oct 1) has no category and
// pays the Rent bill; Spectrum ($70, Oct 3) pays the Internet bill (Household), but a person
// already put it in Utilities.

/** A transaction as the list stores it; `cat` is left out for one that needs a category. */
function tx(
	id: number,
	date: string,
	name: string,
	cents: number,
	cat?: Cat,
): ListRow {
	return {
		id,
		date,
		amountCents: cents,
		rawName: name,
		displayName: name,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: cat ? id : null,
		categoryName: cat?.name ?? null,
		categoryIcon: cat?.icon ?? null,
		categoryColor: cat?.color ?? null,
	};
}

/** The Transactions list as the page draws it: a muted heading per day, newest first. */
function DayGroup({ date, children }: { date: string; children?: Child }) {
	return (
		<>
			<h2 class="mt-3 text-sm text-muted">{dayLabel(date, TODAY)}</h2>
			<ul class="divide-y divide-rule">{children}</ul>
		</>
	);
}

/**
 * A TransactionRow whose caption also names the bill it paid: the category, then "paid" and the
 * bill, as a refund's "Refund for Sep 3" follows its category.
 */
export function PaymentRow({
	name,
	cents,
	cat,
	bill: paid,
}: {
	name: string;
	cents: number;
	cat: Cat;
	bill: string;
}) {
	return (
		<li>
			<div class="flex h-16 items-center gap-4">
				<CategoryIcon icon={cat.icon} color={cat.color} />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">{name}</span>
					<span class="block truncate leading-6 text-muted">
						{cat.name} · paid {paid} bill
					</span>
				</span>
				<span class="shrink-0 text-lg">{formatCents(cents)}</span>
			</div>
		</li>
	);
}

const TRADER_JOES = tx(3, "2026-10-04", "Trader Joe's", 6412, GROCERIES);
const SHELL = tx(4, "2026-10-04", "Shell", 4180, GAS);
const SPECTRUM = tx(2, "2026-10-03", "Spectrum", 7000, UTILITIES);

/** The Transactions screen's top and rows, with the rows of the two bill payments given. */
function paymentsList(rentRow: Child, spectrumRow: Child) {
	return (
		<>
			<Title>Transactions</Title>
			<p class="mt-4 text-sm text-muted">4 transactions in October</p>
			<DayGroup date="2026-10-04">
				<TransactionRow row={TRADER_JOES} />
				<TransactionRow row={SHELL} />
			</DayGroup>
			<DayGroup date="2026-10-03">{spectrumRow}</DayGroup>
			<DayGroup date="2026-10-01">{rentRow}</DayGroup>
		</>
	);
}

/** P59, today: both payments are linked to their bills, and the rent still needs a category. */
const categoryToday = paymentsList(
	<TransactionRow row={tx(1, "2026-10-01", "Harbor Property", 120000)} />,
	<TransactionRow row={SPECTRUM} />,
);

/** P59 A: after linking; Rent took the bill's category, Spectrum kept the one a person chose. */
const categoryOnList = paymentsList(
	<PaymentRow
		name="Harbor Property"
		cents={120000}
		cat={RENT_CAT}
		bill="Rent"
	/>,
	<PaymentRow name="Spectrum" cents={7000} cat={UTILITIES} bill="Internet" />,
);

/**
 * P59 B: the picker's link step (BillPaymentPicker, src/views/bill-payment-picker.tsx) after a
 * payment with no category is chosen, with the tick between the payment and the month. The rest is
 * as the real picker draws it.
 */
const categoryTick = (
	<section class="border-t border-rule pt-4">
		<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
		<p class="mt-2 text-lg">
			To October's Rent, {formatCents(RENT.amountCents)}.
		</p>
		<p class="mt-1 text-muted">
			Within 30 days of Oct 1, same merchant first, then closest amount.
		</p>
		<div class="mt-4 flex flex-col gap-3">
			<fieldset>
				<legend>Payment</legend>
				<div class="mt-1 flex flex-col gap-2">
					<Chip type="radio" name="p59-b-payment" value="1" checked>
						Harbor Property · Oct 1 · {formatCents(120000)}
					</Chip>
					<Chip type="radio" name="p59-b-payment" value="2">
						Home Depot · Oct 1 · {formatCents(3827)}
					</Chip>
				</div>
			</fieldset>
			<div>
				<Chip type="checkbox" name="p59-b-category" value="rent">
					Also set its category to Rent
				</Chip>
				<p class="mt-1 text-sm text-muted">
					Harbor Property has no category yet.
				</p>
			</div>
			<fieldset>
				<legend>Which month's bill does it pay?</legend>
				<div class="mt-2 flex flex-wrap gap-2">
					<Chip type="radio" name="p59-b-month" value="2026-10" checked>
						October
					</Chip>
					<Chip type="radio" name="p59-b-month" value="2026-09">
						September
					</Chip>
				</div>
				<BillMonthExplanation countedMonth="2026-10" paymentDate="2026-10-01" />
			</fieldset>
			<div class="flex gap-3">
				<Button type="button">Link</Button>
				<Button kind="text" type="button">
					Cancel
				</Button>
			</div>
		</div>
	</section>
);

// ---------------------------------------------------------------------------------------------
// P60: a monthly bills total. A yearly bill counts as a twelfth of itself; "still to pay" is every
// unpaid bill due this month. Soccer is next due in March, so it isn't in October's.

const MONTH_BILLS = [ELECTRIC, SWIM, INTERNET, CAR, RENT, SOCCER];
const perMonth = (b: BillRowData) =>
	b === SOCCER ? Math.round(b.amountCents / 12) : b.amountCents;
const MONTHLY_TOTAL = MONTH_BILLS.reduce((n, b) => n + perMonth(b), 0);
const LEFT_IN_OCTOBER = MONTH_BILLS.filter(
	(b) => b.status !== "paid" && b.dueDate.startsWith("2026-10"),
).reduce((n, b) => n + b.amountCents, 0);
const SOCCER_A_MONTH = `about ${dollars(perMonth(SOCCER))} a month`;
const SOON = [ELECTRIC, SWIM];

/** P60: Bills' groups, with the proposal's one change slotted in. */
function totalsList({
	under,
	totals,
	soccer = rows([SOCCER]),
}: {
	under?: Child;
	totals?: [string, string, string];
	soccer?: Child;
}) {
	return (
		<BillsScreen
			sentence={toPay(SOON.length, sum(SOON))}
			under={under}
			groups={[
				{ status: "due", total: totals?.[0], rows: rows(SOON) },
				{
					status: "upcoming",
					total: totals?.[1],
					rows: (
						<>
							{rows([INTERNET, CAR])}
							{soccer}
						</>
					),
				},
				{ status: "paid", total: totals?.[2], rows: rows([RENT]) },
			]}
		/>
	);
}

/** P60 A: a quiet line under the sentence. */
const totalLine = totalsList({
	under: (
		<p class="mt-1 text-muted">
			{dollars(MONTHLY_TOTAL)} a month in bills, {dollars(LEFT_IN_OCTOBER)}{" "}
			still to pay in October
		</p>
	),
});

/** P60 B: each group's heading ends with what it adds up to; Upcoming counts only this month's. */
const totalPerGroup = totalsList({
	totals: [
		formatCents(sum(SOON)),
		`${formatCents(INTERNET.amountCents + CAR.amountCents)} this month`,
		formatCents(RENT.amountCents),
	],
});

/** P60 C: only the yearly bill's row changes. */
const yearlyShare = totalsList({
	soccer: (
		<LineRow
			bill={SOCCER}
			line={billStatusLine(SOCCER, TODAY)}
			side={SOCCER_A_MONTH}
		/>
	),
});

// ---------------------------------------------------------------------------------------------
// P61: a bill's amount history. Netflix was $15.49 and went up to $17.99 from October.

const OLD_PRICE = 1549;
const NEW_PRICE = 1799;
const HISTORY: [string, number][] = [
	["October", NEW_PRICE],
	["January", OLD_PRICE],
];

const netflixTop = {
	merchant: "NETFLIX.COM",
	name: "Netflix",
	line: `${formatCents(NEW_PRICE)} a month, due the 2nd`,
};

/** One of Netflix's months, with the payment the matcher linked (none for next month's). */
const netflixMonth = (
	period: string,
	label: string,
	status: "paid" | "upcoming",
	paid?: [string, number],
) => (
	<BillOccurrenceRow
		billId={1}
		period={period}
		label={label}
		status={status}
		payment={paid ? paidWith("Netflix", paid[0], paid[1]) : undefined}
	/>
);

/** P61 A: each month shows its own amount, and one muted line says when it changed. */
const historyLine = (
	<BillPage
		{...netflixTop}
		under={
			<p class="text-muted">
				Price went up to {formatCents(NEW_PRICE)} in October
			</p>
		}
	>
		{netflixMonth(
			"2026-11",
			`November · ${formatCents(NEW_PRICE)}`,
			"upcoming",
		)}
		{netflixMonth("2026-10", `October · ${formatCents(NEW_PRICE)}`, "paid", [
			"Oct 2",
			NEW_PRICE,
		])}
		{netflixMonth("2026-09", `September · ${formatCents(OLD_PRICE)}`, "paid", [
			"Sep 2",
			OLD_PRICE,
		])}
		{netflixMonth("2026-08", `August · ${formatCents(OLD_PRICE)}`, "paid", [
			"Aug 2",
			OLD_PRICE,
		])}
	</BillPage>
);

/** P61 B: the months stay as they are; an Amount history disclosure, drawn open, lists each change. */
const historyDisclosure = (
	<BillPage
		{...netflixTop}
		under={
			<details open class="group">
				<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
					<Icon name="chevron" class="size-5 group-open:rotate-90" />
					Amount history
				</summary>
				<dl class="divide-y divide-rule border-y border-rule">
					{HISTORY.map(([month, cents]) => (
						<div class="flex justify-between gap-4 py-1.5">
							<dt>From {month}</dt>
							<dd>{formatCents(cents)}</dd>
						</div>
					))}
				</dl>
			</details>
		}
	>
		{netflixMonth("2026-11", "November", "upcoming")}
		{netflixMonth("2026-10", "October", "paid", ["Oct 2", NEW_PRICE])}
		{netflixMonth("2026-09", "September", "paid", ["Sep 2", OLD_PRICE])}
		{netflixMonth("2026-08", "August", "paid", ["Aug 2", OLD_PRICE])}
	</BillPage>
);

/** P61, both: the edit sheet says what a new amount touches, from the amount being replaced. */
const editSheet = (
	<Sheet
		behind={
			<BillPage
				{...netflixTop}
				line={`${formatCents(OLD_PRICE)} a month, due the 2nd`}
			/>
		}
	>
		<h2 class="font-serif text-4xl font-semibold tracking-tight">Netflix</h2>
		<TextInput id="p61-name" label="Name" value="Netflix" surface="paper" />
		<div>
			<MoneyInput
				id="p61-amount"
				name="p61-amount"
				label="Amount"
				value="17.99"
			/>
			<p class="mt-2 text-center text-muted">
				Applies from October on. Earlier months keep {formatCents(OLD_PRICE)}.
			</p>
		</div>
	</Sheet>
);

/** P57–P61 on the proposals page, open for the owner's pick. */
export function Phase5BillsProposals() {
	return (
		<>
			<Specimen
				id="p57-bill-frequencies"
				title="P57 · Weekly, every-two-weeks and quarterly bills"
				tier="visual"
				sentence="Weekly, every-two-weeks and quarterly bills, besides monthly and yearly. Pick how Bills counts several occurrences in a month; the form is the same either way. The list and page are drawn with Daycare, $240 every Friday."
			>
				<Fixed>
					weekly, every two weeks and quarterly bills join monthly and yearly,
					and before they're built §6.1 says how an occurrence is identified
					(today `period` is YYYY-MM or YYYY) and how status counts several in
					one month (§8.4). A bill shows its latest occurrence due by a week
					from now, and a missed one stays overdue until it's paid or the next
					one is due (§6, decision 62). A bill's page lists each month's
					occurrence with its payment (§8.2).
				</Fixed>
				<NeedsLine>
					the period key. K1 (Recommended): a weekly or every-two-weeks
					occurrence is keyed by its own due date, YYYY-MM-DD, and a quarterly
					one by YYYY-Qn, so each key names exactly one occurrence and nothing
					needs a rule for a week that crosses a month or a year. K2: weekly is
					keyed by its ISO week, YYYY-Www, which is shorter but does need that
					rule. Either way the bill_payments period check, which allows only
					YYYY and YYYY-MM today, widens.
				</NeedsLine>
				<NeedsLine>
					how status counts several occurrences in a month. S1 (Recommended,
					drawn as A): the list shows the next unpaid occurrence only, and Safe
					to spend sets aside every occurrence due or overdue; an unpaid one
					from an earlier month shows Not paid and stops being set aside, as for
					a monthly bill. S2 (drawn as B): the month's occurrences together as
					one line, “1 of 5 paid this month”.
				</NeedsLine>
				<NeedsLine>
					the matching window. §6.1 matches a payment within ±5 days of an
					occurrence, which is wider than half a week, so one Friday's payment
					could also fit the Friday before or after; a weekly bill needs a
					narrower window (not drawn).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Occurrences one by one",
							picked: true,
							note: "One row for the next Friday that isn't paid, “Due Oct 9 · every Friday”; its page lists each Friday.",
							tradeoff:
								"a missed Friday is set aside too, so Safe to spend can hold back more than the one row shows.",
							recommended:
								"it's the rule monthly bills already follow, so a missed week can't hide inside a total.",
							screen: weeklyOneByOne,
						},
						{
							name: "Option A · The bill's page",
							note: "Each Friday on its own, with its status and payment, newest first, as a monthly bill lists its months.",
							screen: weeklyPage,
						},
						{
							name: "Option B · A month summary",
							note: "One line counts the month, “1 of 5 paid this month”, in place of the next Friday's date; the bill's page lists each Friday as in A.",
							tradeoff:
								"the row doesn't say which Friday is due, and a missed one hides in the count.",
							screen: weeklySummary,
						},
						{
							name: "Both · Weekly in the form",
							note: "Five choices in How often; Weekly asks for the weekday.",
							screen: frequencyForm("p57-weekly", "weekly"),
						},
						{
							name: "Both · Every two weeks in the form",
							note: "It asks for one date it was paid, and counts every 14 days from it.",
							screen: frequencyForm("p57-fortnight", "biweekly"),
						},
						{
							name: "Both · Quarterly in the form",
							note: "It asks for the first month and the due day, then repeats every 3 months.",
							screen: frequencyForm("p57-quarter", "quarterly"),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p58-partial-payments"
				title="P58 · Partial payments"
				tier="visual"
				sentence="A bill paid in two halves never shows Paid today (gap D1). Pick how a month with only part of its bill paid looks and is counted. Each is drawn with Rent, $1,200, half paid."
			>
				<Fixed>
					partial payments are D1, accepted for Phase 5 (decision 67). A person
					links a payment to a bill's month by hand from its page, and Not this
					one unlinks it (§6.1, §8.2); a month with a linked payment is Paid,
					and a missed one stays overdue (§6).
				</Fixed>
				<NeedsLine>
					bill_payments' unique on bill_id, period goes, and §6.1's “at most one
					payment per period” with it, so one occurrence can have several linked
					payments (a transaction still pays one bill). A month is Paid once its
					payments add up to within ±10% of the amount (the matcher's
					tolerance); until then Safe to spend, and Bills' sentence, set aside
					only what's left ($600 here). The matcher still takes one payment
					within ±10% of the amount, so a half payment is linked by hand, as
					drawn.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Link more than one payment",
							picked: true,
							note: "October stays Overdue as “Part paid: $600 of $1,200” until the links add up; September's two payments made it Paid.",
							tradeoff:
								"Paid now depends on amounts, so linking by hand can leave a month still part paid.",
							recommended:
								"it shows what happened, two payments, and keeps what Safe to spend sets aside to what's left.",
							screen: partPaidPage,
						},
						{
							name: "Option A · On Bills",
							note: "The row says “Part paid: $600 of $1,200”, and Safe to spend sets aside the $600 left.",
							screen: partPaidList,
						},
						{
							name: "Option B · Mark as paid",
							note: "A month with no payment linked gets a Mark as paid action; it then says “Marked as paid”, with Undo.",
							tradeoff:
								"all or nothing: half paid looks unpaid until someone marks it, a slip hides a bill still owed, and bill_payments needs a row with no transaction, which it can't hold today.",
							screen: markPaidPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p59-bill-category"
				title="P59 · A bill's category on its payments"
				tier="visual"
				sentence="A bill's category isn't given to its payments today (gap D2), so the rent payment shows Needs category. Pick how a linked payment gets it. Each is drawn with the Rent bill's $1,200 payment."
			>
				<Fixed>
					every bill has a category (the bill form requires one). A person's
					category choice is never overwritten (§7), and a payment linked to a
					bill's month counts in that month (§6, decision 58).
				</Fixed>
				<NeedsLine>
					§7 gains a fourth way a category is set: a linked payment with no
					category takes its bill's (a new category_source, “bill”), below a
					person's choice and a merchant rule, which replace it. Unlinking the
					payment leaves the category on it.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Today · The payment needs a category",
							note: "Both payments are linked to their bills. The rent payment still shows Needs category, and Spectrum keeps the Utilities a person chose.",
							screen: categoryToday,
						},
						{
							name: "Option A · It takes the bill's category",
							picked: true,
							note: "Linking gives a payment with no category the bill's, and a linked payment's row says which bill it paid. Spectrum stays Utilities, not the Internet bill's Household: a person put it there.",
							recommended:
								"no extra step, and a person's own choice is never touched.",
							screen: categoryOnList,
						},
						{
							name: "Option B · Ask in the link step",
							note: "A tick, “Also set its category to Rent”, shows when the chosen payment has none; it starts unticked.",
							tradeoff:
								"one more choice on each link, and an unticked one leaves the payment needing a category.",
							screen: categoryTick,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p60-bills-total"
				title="P60 · Monthly bills total"
				tier="visual"
				sentence="Bills never says what the bills cost a month (gap D3), and a yearly bill's share isn't shown. Pick where the total goes. Each is Bills on Oct 5."
			>
				<Fixed>
					Bills is grouped by status, each group once under its heading
					(Overdue, Due in the next 7 days, Upcoming, Paid this month) (§8.2). A
					yearly bill is due once a year, in its anchor month (§5, §8.5).
				</Fixed>
				<NeedsLine>
					what “a month” means for each frequency: a yearly bill counts as a
					twelfth (drawn); if P57 ships, weekly is × 52 ÷ 12, every two weeks ×
					26 ÷ 12 and quarterly ÷ 3. “Still to pay” counts every occurrence due
					this month that isn't paid yet, overdue ones included.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line under the title",
							picked: true,
							note: "One quiet line: what the bills cost a month, with a yearly bill as a twelfth, and what's still to pay this month.",
							recommended:
								"it answers the question once, without a new number on every group.",
							screen: totalLine,
						},
						{
							name: "Option B · A total under each group",
							picked: true,
							note: "Each heading ends with what its group adds up to.",
							tradeoff:
								"Upcoming holds next March's soccer fee, so its total isn't the sum of its rows.",
							screen: totalPerGroup,
						},
						{
							name: "Option C · A yearly bill's share",
							note: "Only a yearly bill's row changes: “about $45 a month” under its amount. No total anywhere.",
							tradeoff:
								"it answers a yearly bill's share, not the total the family asked for.",
							screen: yearlyShare,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p61-amount-history"
				title="P61 · A bill's amount history"
				tier="visual"
				sentence="Editing a bill changes this month and later, never past occurrences (A9). Pick how a bill's page shows a price that changed. Each is Netflix, $15.49 until it went up to $17.99 in October."
			>
				<Fixed>
					editing a bill changes this month and later, never past occurrences
					(§8.4, A9). A budget's amount in a month is the latest budget_amounts
					row with effective_month on or before it (§6).
				</Fixed>
				<NeedsLine>
					where the amount history lives. H1 (Recommended): a bill_amounts table
					like budget_amounts (bill_id, effective_month, amount_cents); an
					occurrence's amount is the latest row with effective_month on or
					before its month, the same rule as budgets, which is already
					explained. H2: store the amount on each occurrence when it's created,
					which means occurrences become rows; today one is worked out from its
					bill.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A line on the bill page",
							picked: true,
							note: "Each month shows its own amount, and one muted line says when it changed.",
							tradeoff:
								"only the latest change is in words, an older one shows in the months' amounts, and a paid month says its amount twice.",
							recommended:
								"the history is where you look: each month has its own amount, and one line says when it changed.",
							screen: historyLine,
						},
						{
							name: "Option B · An Amount history list",
							note: "The months stay plain; “Amount history” opens each change, newest first (drawn open).",
							tradeoff:
								"the history is a tap away, and a month's amount isn't on its row until it's paid.",
							screen: historyDisclosure,
						},
						{
							name: "Both · The edit sheet",
							note: "Under the amount it says what a new amount touches, from the one being replaced.",
							screen: editSheet,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
