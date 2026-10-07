// Typed fake data for the catalog. It never touches the database; TypeScript checks each value
// against the component's props, so a changed component fails `npm run typecheck` here first.
import { MAX_BUDGET_CENTS } from "../budgets/amount";
import { daysBefore } from "../dates";
import type { ListRow } from "../db/transactions";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import { type NetWorthPoint, netWorthView } from "../net-worth";
import { type BankSync, flaggedBanks, homeBankNotice } from "../stale-bank";
import { tidyName } from "../transactions/tidy-name";
import type { MonthSpend, TrendCategory, TrendsInput } from "../trends";

// An unnamed merchant: nobody has chosen a display name for it yet, so the row shows tidyName's
// output (spec §7), with the raw bank text underneath.
const rawName = "DD *DOORDASH TACO";
const row: ListRow = {
	id: 1,
	date: "2026-09-22",
	amountCents: 1240,
	rawName,
	displayName: tidyName(rawName),
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
};

/** One transaction row in each state it can show. */
export const TRANSACTION_ROWS: { label: string; row: ListRow }[] = [
	{
		label: "With a category",
		row: {
			...row,
			id: 2,
			displayName: "Trader Joe's",
			rawName: "TRADER JOE'S #552",
			amountCents: 8614,
			categoryId: 1,
			categoryName: "Groceries",
			categoryIcon: "groceries",
			categoryColor: "cat-blue",
		},
	},
	{
		label: "Payment linked to a bill",
		row: {
			...row,
			id: 8,
			displayName: "Harbor Property",
			rawName: "HARBOR PROPERTY MGMT",
			amountCents: 120000,
			categoryId: 5,
			categoryName: "Rent",
			categoryIcon: "rent",
			categoryColor: "cat-slate",
			paysBill: true,
			billName: "Rent",
		},
	},
	{ label: "Needs a category (unnamed merchant, raw text tidied)", row },
	{
		label: "Income",
		row: {
			...row,
			id: 3,
			displayName: "Payroll",
			rawName: "ACME PAYROLL",
			amountCents: -325000,
			income: true,
		},
	},
	{
		label: "Excluded",
		row: {
			...row,
			id: 4,
			displayName: "Transfer to savings",
			rawName: "ONLINE TRANSFER",
			amountCents: 50000,
			excluded: true,
		},
	},
	// Pending (P34 A, decision 72): the word joins the one caption line, and goes first when the caption says more.
	{
		label: "Pending, with a category: Pending follows it",
		row: {
			...row,
			id: 5,
			displayName: "Trader Joe's",
			rawName: "TRADER JOE'S #552",
			amountCents: 6412,
			categoryId: 1,
			categoryName: "Groceries",
			categoryIcon: "groceries",
			categoryColor: "cat-blue",
			pending: true,
		},
	},
	{
		label: "Pending, needs a category: Pending takes the bank text's place",
		row: { ...row, id: 6, pending: true },
	},
	{
		label: "Pending and excluded: the caption says more, so Pending goes first",
		row: {
			...row,
			id: 7,
			displayName: "Transfer to savings",
			rawName: "ONLINE TRANSFER",
			amountCents: 50000,
			excluded: true,
			pending: true,
		},
	},
	{
		label: "Pending and a split part: Pending goes first",
		row: {
			...row,
			id: 8,
			displayName: "Costco",
			rawName: "COSTCO WHSE #0421",
			amountCents: 8240,
			categoryId: 1,
			categoryName: "Groceries",
			categoryIcon: "groceries",
			categoryColor: "cat-blue",
			parentId: 9,
			parentName: "Costco",
			pending: true,
		},
	},
	// A name Tally guessed (P29 A, P87 B, decisions 64 and 80): the sparkles icon and a dashed underline, until a person chooses.
	{
		label: "A name Tally guessed: the sparkles icon, then the name dashed",
		row: {
			...row,
			id: 10,
			displayName: "DoorDash",
			nameSuggested: true,
		},
	},
	{
		label: "A name the bank sent: dashed too, but no icon",
		row: {
			...row,
			id: 12,
			displayName: "CVS Pharmacy",
			rawName: "CHECKCARD 0921 CVS",
			amountCents: 1643,
			nameSuggested: true,
			nameFromBank: true,
		},
	},
	{
		label:
			"A guessed name on a row with a category, and one long enough to be cut off",
		row: {
			...row,
			id: 11,
			displayName: "Blue Bottle Coffee Roasters and Cafe on Market Street",
			rawName: "SQ *BLUE BOTTLE COF 0412",
			amountCents: 650,
			categoryId: 2,
			categoryName: "Eating Out",
			categoryIcon: "eating-out",
			categoryColor: "cat-plum",
			nameSuggested: true,
		},
	},
];

/** P30 A's suggested-category card, using the same transaction shape as the app. */
export const CATEGORY_SUGGESTION = {
	id: 30,
	name: "Pet Care",
	rows: [
		{
			...row,
			id: 31,
			displayName: "Chewy",
			rawName: "CHEWY",
			amountCents: 6412,
		},
		{
			...row,
			id: 32,
			displayName: "Banfield Pet Hospital",
			rawName: "BANFIELD PET HOSPITAL",
			amountCents: 18900,
		},
		{
			...row,
			id: 33,
			displayName: "Petsmart",
			rawName: "PETSMART",
			amountCents: 2399,
		},
		{
			...row,
			id: 34,
			displayName: "Amazon",
			rawName: "AMAZON",
			amountCents: 4520,
		},
	],
};

/**
 * Budget rows, on track and over. They're shown without links: in the app each row opens its
 * budget sheet, and a link here would go nowhere (DESIGN.md "No broken windows").
 */
export const PROGRESS_ROWS = [
	{
		label: "On track",
		props: {
			name: "Groceries",
			icon: "groceries",
			color: "cat-blue",
			spentCents: 41200,
			budgetCents: 60000,
		},
	},
	{
		label: "Over budget",
		props: {
			name: "Eating out",
			icon: "eating-out",
			color: "cat-plum",
			spentCents: 23850,
			budgetCents: 20000,
		},
	},
];

/**
 * Home's budget list in Adjust mode (#94): a round amount, one between round $10s, one over budget,
 * one at $0 and one at the largest budget. The nudge paths are Home's real ones, but the specimen is Visual, so nothing posts.
 */
export const ADJUST_ROWS = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 41200,
		budgetCents: 70000,
	},
	{
		name: "Household",
		icon: "household",
		color: "cat-brown",
		spentCents: 9500,
		budgetCents: 71200,
	},
	{
		name: "Eating out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 28600,
		budgetCents: 25000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 0,
		budgetCents: 0,
	},
	{
		name: "Rent",
		icon: "rent",
		color: "cat-slate",
		spentCents: 1_000_000,
		budgetCents: MAX_BUDGET_CENTS,
	},
].map((row, i) => ({
	...row,
	// Each row opens the catalog's sheet page, as a Home row opens its budget sheet.
	href: "/design-system/bottom-sheet",
	nudge: { href: `/budget/${i + 1}/nudge`, id: `ds-nudge-${i + 1}` },
}));

/** Home's top with the demo's numbers after a reset (#92), and Home's budget rows under it. */
export const HOME_TOP = {
	month: "September",
	safeToSpendCents: 28300,
	status: "Eating Out is $36 over. Everything else is on track.",
	band: {
		href: "/transactions?uncategorized=1",
		text: "12 need a category",
		detail: "$228 of this month's spending",
	},
};
export const HOME_ROWS = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 41200,
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
		name: "Household",
		icon: "household",
		color: "cat-brown",
		spentCents: 9500,
		budgetCents: 25000,
	},
];

/** The Band links to the demo's real "needs a category" list, which is what it says. */
export const BAND = {
	href: "/transactions?uncategorized=1",
	text: "12 need a category",
};

const BANK_TODAY = "2026-10-05";
const chase = (overrides: Partial<BankSync>): BankSync => ({
	name: "Chase",
	needsAttention: false,
	lastSyncedAt: "2026-09-28 09:00:00",
	...overrides,
});
/** BankBehind's three wordings, from the same helper as Home. */
export const BANK_LINES = {
	stale:
		homeBankNotice(
			flaggedBanks(
				[chase({ lastSyncedAt: "2026-10-02 09:00:00" })],
				BANK_TODAY,
			),
			BANK_TODAY,
		)?.words ?? [],
	signIn:
		homeBankNotice(
			flaggedBanks([chase({ needsAttention: true })], BANK_TODAY),
			BANK_TODAY,
		)?.words ?? [],
	several:
		homeBankNotice(
			flaggedBanks(
				[
					chase({ needsAttention: true }),
					chase({ name: "Citi", lastSyncedAt: "2026-09-20 09:00:00" }),
				],
				BANK_TODAY,
			),
			BANK_TODAY,
		)?.words ?? [],
};

/** The money input in each state it can show. */
export const MONEY_STATES = [
	{
		label: "$0: the minus buttons are off",
		props: {
			id: "ds-money-zero",
			name: "ds-money-zero",
			label: "Budget",
			value: "0.00",
		},
	},
	{
		label: "With cents: “Round to” appears",
		props: {
			id: "ds-money-cents",
			name: "ds-money-cents",
			label: "Budget",
			value: "612.40",
			lastMonthCents: 60000,
			averageCents: 65000,
		},
	},
	{
		label: "Equal to last month: its chip is dimmed",
		props: {
			id: "ds-money-last",
			name: "ds-money-last",
			label: "Budget",
			value: "600.00",
			lastMonthCents: 60000,
			averageCents: 60000,
		},
	},
	{
		label: "With an error",
		props: {
			id: "ds-money-error",
			name: "ds-money-error",
			label: "Budget",
			value: "12.3.4",
			error: "Enter a dollar amount, like 250 or 250.50.",
		},
	},
];

export const BUDGET_EXAMPLE = {
	totalBudgetCents: 320000,
	totalSpentCents: 171600,
	safeToSpendCents: 128400,
};
export const TRANSACTIONS_EXAMPLE = {
	counted: 88,
	excluded: 6,
	heldForReview: 2,
	needsCategory: 12,
};
export const EXCLUSIONS_EXAMPLE: {
	counted: number;
	heldForReview: number;
	breakdown: ExcludedBreakdown;
} = {
	counted: 88,
	heldForReview: 2,
	breakdown: { transfer: 3, reimbursement: 1, byPerson: 2 },
};
export const CATEGORIES_EXAMPLE = {
	user: 14,
	merchantRule: 22,
	bill: 5,
	jev: 40,
	waiting: 12,
	income: 3,
	threshold: "80%",
};

/** The Accounts screen (round 5 study): two banks, the second needing its login fixed. Net worth is their sum. */
export const CHECKING = {
	id: 1,
	name: "Checking",
	mask: "4521",
	type: "depository",
	balanceCents: 390412,
	isLiability: false,
};
export const CREDIT_CARD = {
	id: 3,
	name: "Credit card",
	mask: "9012",
	type: "credit",
	balanceCents: 212240,
	isLiability: true,
};
export const BANKS = [
	{
		name: "First Harbor Bank",
		needsAttention: false,
		accounts: [
			CHECKING,
			{
				id: 2,
				name: "Savings",
				mask: "5678",
				type: "depository",
				balanceCents: 1260000,
				isLiability: false,
			},
		],
	},
	{
		name: "Northline Card Services",
		needsAttention: true,
		accounts: [CREDIT_CARD],
	},
];
export const NET_WORTH_CENTS = BANKS.flatMap((b) => b.accounts).reduce(
	(sum, a) => sum + (a.isLiability ? -a.balanceCents : a.balanceCents),
	0,
);

// ---------------------------------------------------------------------------------------------
// Trends (spec §8.3): rows in the demo's style, as buildTrends takes them, so the catalog draws
// the page exactly as the app does. Today is Oct 5; spending is May to October so far.

const TREND_CATEGORIES: TrendCategory[] = [
	{
		id: 1,
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		archived: false,
	},
	{
		id: 2,
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		archived: false,
	},
	{ id: 3, name: "Kids", icon: "kids", color: "cat-ochre", archived: false },
	{ id: 4, name: "Gas", icon: "gas", color: "cat-slate", archived: false },
	{
		id: 5,
		name: "Household",
		icon: "household",
		color: "cat-brown",
		archived: false,
	},
];
const TREND_SERIES: [number, number[]][] = [
	[1, [82000, 79000, 84500, 81000, 86000, 19600]],
	[2, [21000, 24500, 28000, 31800, 36500, 9200]],
	[3, [26000, 24000, 30000, 28000, 25500, 6000]],
	[4, [18000, 17500, 19000, 17200, 18500, 4800]],
	[5, [14000, 19000, 12000, 16000, 15000, 3000]],
];
const TREND_MONTHS_MOCK = [
	"2026-05",
	"2026-06",
	"2026-07",
	"2026-08",
	"2026-09",
	"2026-10",
];
const TREND_SPEND: MonthSpend[] = [
	...TREND_SERIES.flatMap(([categoryId, cents]) =>
		cents.map((c, i) => ({
			month: TREND_MONTHS_MOCK[i] as string,
			categoryId,
			cents: c,
		})),
	),
	{ month: "2026-10", categoryId: null, cents: 2300 },
];

/** A household with history from before these six months, Eating Out creeping up. */
export const TRENDS_INPUT: TrendsInput = {
	today: "2026-10-05",
	firstDate: "2026-04-15",
	categories: TREND_CATEGORIES,
	amounts: [
		{ categoryId: 1, effectiveMonth: "2026-01", amountCents: 90000 },
		{ categoryId: 2, effectiveMonth: "2026-01", amountCents: 30000 },
		{ categoryId: 3, effectiveMonth: "2026-01", amountCents: 30000 },
		{ categoryId: 4, effectiveMonth: "2026-01", amountCents: 20000 },
		{ categoryId: 5, effectiveMonth: "2026-01", amountCents: 15000 },
	],
	spend: TREND_SPEND,
	sameDays: [
		{ categoryId: 1, cents: 22400 },
		{ categoryId: 2, cents: 6100 },
		{ categoryId: 3, cents: 4500 },
		{ categoryId: 4, cents: 5200 },
		{ categoryId: 5, cents: 5800 },
	],
};

/** History started May 12: May is a part month, so it's drawn striped but not judged. */
export const TRENDS_PART_INPUT: TrendsInput = {
	...TRENDS_INPUT,
	firstDate: "2026-05-12",
};

/** Only last month and this one: Tally started in September, so there's nothing to compare yet (P31). */
export const TRENDS_EARLY_INPUT: TrendsInput = {
	...TRENDS_INPUT,
	firstDate: "2026-09-12",
	spend: TREND_SPEND.filter((r) => r.month >= "2026-09"),
};

/** Tally's very first month. */
export const TRENDS_FIRST_MONTH_INPUT: TrendsInput = {
	...TRENDS_INPUT,
	firstDate: "2026-10-02",
	spend: TREND_SPEND.filter((r) => r.month === "2026-10"),
};

/** No transactions at all. */
export const TRENDS_EMPTY_INPUT: TrendsInput = {
	...TRENDS_INPUT,
	firstDate: null,
	spend: [],
	sameDays: [],
};

/** The net-worth chart's fake "today", so its words don't change with the calendar. */
export const NET_WORTH_TODAY = "2026-10-05";
// Weekly from May 1, climbing $3,600 to today's net worth with a small wobble in between.
const WOBBLE = [
	0, 9000, -6000, 14000, 3000, -12000, 8000, 16000, -4000, 5000, -9000,
];
/** The climbing weeks, ending on `endCents` today (a headline the picture sits under). */
const climbing = (endCents: number): NetWorthPoint[] => [
	...Array.from({ length: 22 }, (_, week) => ({
		date: daysBefore("2026-05-01", -7 * week),
		cents:
			endCents -
			360000 +
			Math.floor((360000 * week) / 22) +
			(week === 0 ? 0 : (WOBBLE[week % WOBBLE.length] ?? 0)),
	})),
	{ date: NET_WORTH_TODAY, cents: endCents },
];
const CLIMBING = climbing(NET_WORTH_CENTS);

/** The climbing line ending on `endCents`, for a mock whose headline isn't NET_WORTH_CENTS. */
export const netWorthViewEnding = (endCents: number) =>
	netWorthView(climbing(endCents), NET_WORTH_TODAY);

/** The chart space in each state it can show (P25 A, P31), built by the same function the app uses. */
export const NET_WORTH_VIEWS = {
	rising: netWorthView(CLIMBING, NET_WORTH_TODAY),
	// The same weeks mirrored about today's net worth: the line starts $3,600 higher and falls to
	// NET_WORTH_CENTS, so it ends on the same headline as the others.
	falling: netWorthView(
		CLIMBING.map((p) => ({
			date: p.date,
			cents: 2 * NET_WORTH_CENTS - p.cents,
		})),
		NET_WORTH_TODAY,
	),
	// Linked this month: the line starts on a day, not a month.
	startedThisMonth: netWorthView(
		[
			{ date: "2026-10-01", cents: NET_WORTH_CENTS - 12000 },
			{ date: "2026-10-03", cents: NET_WORTH_CENTS - 4000 },
			{ date: NET_WORTH_TODAY, cents: NET_WORTH_CENTS },
		],
		NET_WORTH_TODAY,
	),
	firstDay: netWorthView(
		[{ date: NET_WORTH_TODAY, cents: NET_WORTH_CENTS }],
		NET_WORTH_TODAY,
	),
	none: netWorthView([], NET_WORTH_TODAY),
	// A connected account has no balance recorded yet, so there is no line until it has one.
	waiting: netWorthView([], NET_WORTH_TODAY, 1),
};
