// Typed fake data for the catalog. It never touches the database; TypeScript checks each value
// against the component's props, so a changed component fails `npm run typecheck` here first.
import { MAX_BUDGET_CENTS } from "../budgets/amount";
import type { ListRow } from "../db/transactions";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import { tidyName } from "../transactions/tidy-name";

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
];

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
		text: "12 transactions need a category",
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
	text: "12 transactions need a category",
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
