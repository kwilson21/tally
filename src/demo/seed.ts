// The Rivera family: the demo household. Plain data, relative to "today", so the demo always looks current.
// Nothing here is real. Designed totals are documented in the Phase 1b plan and asserted in test/seed.test.ts.

import type { BudgetAmount } from "../budget";
import { daysBefore } from "../dates";

export type SeedCategory = {
	id: number;
	name: string;
	icon: string;
	color: string;
	sortOrder: number;
};
/** A linked bank as Plaid would name it. The demo's are made up and hold no token. */
export type SeedBank = {
	id: number;
	name: string;
};
export type SeedAccount = {
	id: number;
	bankId: number | null;
	name: string;
	mask: string | null;
	type: string;
	subtype: string;
	isLiability: boolean;
	balanceCents: number;
};
/** One `merchants` row, keyed by merchant key: Plaid's merchant name when a transaction has one, else its raw name. */
export type SeedMerchant = {
	key: string;
	displayName: string | null;
	defaultCategoryId: number | null;
};
export type SeedTransaction = {
	id?: number;
	parentId?: number | null;
	accountId: number;
	date: string;
	amountCents: number;
	rawName: string;
	/** Plaid's cleaned merchant name; null for a hand-entered cash transaction and most of the demo. */
	merchantName?: string | null;
	categoryId: number | null;
	categorySource: "jev" | "user" | null;
	categoryConfidence: number | null;
	flagTransfer: boolean;
	flagReimbursement: boolean;
	flagIncome: boolean;
	excluded: boolean;
	isSplit: boolean;
	refundOfId?: number | null;
};
/** One bank account's balance on one day, as `balance_history` stores it (cents; for debt, the amount owed). */
export type SeedBalance = {
	accountId: number;
	date: string;
	balanceCents: number;
};
export type Seed = {
	categories: SeedCategory[];
	banks: SeedBank[];
	accounts: SeedAccount[];
	balanceHistory: SeedBalance[];
	merchants: SeedMerchant[];
	budgetAmounts: BudgetAmount[];
	transactions: SeedTransaction[];
};

const GROCERIES = 1;
const EATING_OUT = 2;
const GAS = 3;
const KIDS = 4;
const HOUSEHOLD = 5;
const CHECKING = 1;
const SAVINGS = 2;
const CARD = 3;
const CASH = 4;

const CATEGORIES: SeedCategory[] = [
	{
		id: GROCERIES,
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		sortOrder: 1,
	},
	{
		id: EATING_OUT,
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		sortOrder: 2,
	},
	{ id: GAS, name: "Gas", icon: "gas", color: "cat-slate", sortOrder: 3 },
	{ id: KIDS, name: "Kids", icon: "kids", color: "cat-ochre", sortOrder: 4 },
	{
		id: HOUSEHOLD,
		name: "Household",
		icon: "household",
		color: "cat-brown",
		sortOrder: 5,
	},
];

const HARBOR = 1;
const NORTHLINE = 2;

const BANKS: SeedBank[] = [
	{ id: HARBOR, name: "First Harbor Bank" },
	{ id: NORTHLINE, name: "Northline Card Services" },
];

const ACCOUNTS: SeedAccount[] = [
	{
		id: CHECKING,
		bankId: HARBOR,
		name: "Checking",
		mask: "1234",
		type: "depository",
		subtype: "checking",
		isLiability: false,
		balanceCents: 421055,
	},
	{
		id: SAVINGS,
		bankId: HARBOR,
		name: "Savings",
		mask: "5678",
		type: "depository",
		subtype: "savings",
		isLiability: false,
		balanceCents: 1240000,
	},
	{
		id: CARD,
		bankId: NORTHLINE,
		name: "Credit card",
		mask: "9012",
		type: "credit",
		subtype: "credit card",
		isLiability: true,
		balanceCents: 84217,
	},
	{
		id: CASH,
		bankId: null,
		name: "Cash",
		mask: null,
		type: "cash",
		subtype: "cash",
		isLiability: false,
		balanceCents: 0,
	},
];

// Categorized merchants: raw name as a bank sends it → display name.
const MERCHANTS: Record<number, [string, string][]> = {
	[GROCERIES]: [
		["TRADER JOE'S #552", "Trader Joe's"],
		["COSTCO WHSE #0431", "Costco"],
		["WHOLEFDS MKT 10233", "Whole Foods"],
	],
	[EATING_OUT]: [
		["BLUE BOTTLE COFFEE", "Blue Bottle Coffee"],
		["CHIPOTLE 2291", "Chipotle"],
		["OLIVE GARDEN 1187", "Olive Garden"],
		["MARIO'S PIZZA", "Mario's Pizza"],
		["STARBUCKS STORE 5521", "Starbucks"],
		["THAI PALACE", "Thai Palace"],
	],
	[GAS]: [
		["SHELL OIL 57442", "Shell"],
		["CHEVRON 0098812", "Chevron"],
	],
	[KIDS]: [
		["TARGET T-1432", "Target"],
		["YOUTH SOCCER LEAGUE", "Youth Soccer League"],
		["BARNES & NOBLE #2831", "Barnes & Noble"],
	],
	[HOUSEHOLD]: [
		["THE HOME DEPOT #6612", "The Home Depot"],
		["AMAZON.COM*RT4K2", "Amazon"],
	],
};

// Plaid's merchant_name for a few raw names, as it would send them (spec §5, decision 67). Two raw names
// share Amazon, so they are one merchant for rules, bills and refunds. Every other transaction has none.
const PLAID_MERCHANT_NAMES: Record<string, string> = {
	"TARGET T-1432": "Target",
	"STARBUCKS STORE 5521": "Starbucks",
	"SHELL OIL 57442": "Shell",
	"CHEVRON 0098812": "Chevron",
	"AMAZON.COM*RT4K2": "Amazon",
	"AMZN MKTP US*2K4": "Amazon",
};

/** The merchant key of a seeded raw name (spec §6.1): Plaid's merchant name, otherwise the raw name. */
export const seedMerchantKey = (rawName: string) =>
	PLAID_MERCHANT_NAMES[rawName] ?? rawName;

// This month, categorized: [targetDay, rawName, categoryId, cents]. Totals per the plan's table.
const THIS_MONTH: [number, string, number, number][] = [
	[2, "TRADER JOE'S #552", GROCERIES, 6418],
	[9, "COSTCO WHSE #0431", GROCERIES, 18742],
	[16, "WHOLEFDS MKT 10233", GROCERIES, 9630],
	[22, "TRADER JOE'S #552", GROCERIES, 6410],
	[3, "BLUE BOTTLE COFFEE", EATING_OUT, 650],
	[6, "CHIPOTLE 2291", EATING_OUT, 3840],
	[12, "OLIVE GARDEN 1187", EATING_OUT, 11280],
	[15, "MARIO'S PIZZA", EATING_OUT, 6430],
	[19, "STARBUCKS STORE 5521", EATING_OUT, 1200],
	[21, "THAI PALACE", EATING_OUT, 5200],
	[4, "SHELL OIL 57442", GAS, 4820],
	[11, "CHEVRON 0098812", GAS, 5210],
	[17, "SHELL OIL 57442", GAS, 3770],
	[20, "CHEVRON 0098812", GAS, 4800],
	[5, "TARGET T-1432", KIDS, 7000],
	[8, "YOUTH SOCCER LEAGUE", KIDS, 9000],
	[18, "BARNES & NOBLE #2831", KIDS, 5000],
	[7, "THE HOME DEPOT #6612", HOUSEHOLD, 6125],
	[13, "AMAZON.COM*RT4K2", HOUSEHOLD, 3375],
];

// This month, uncategorized (12 transactions, $228.01): [targetDay, rawName, cents, displayName].
const UNCATEGORIZED: [number, string, number, string | null][] = [
	[22, "SQ *LOCAL BAKERY 4432", 1200, "Local Bakery"],
	[3, "PAYPAL *XYZSHOP", 2349, null],
	[5, "SQ *FARMERS MKT", 1800, null],
	[6, "VENMO *J RIVERA", 4000, null],
	[8, "TST* CORNER DELI", 1425, null],
	[10, "AMZN MKTP US*2K4", 2799, null],
	[11, "SP * CRAFTSUPPLY", 1980, null],
	[13, "POS 4417 CITY PARKING", 800, null],
	[14, "CHECKCARD 0921 CVS", 1643, null],
	[16, "APPLE.COM/BILL", 299, null],
	[18, "GOOGLE *YOUTUBE", 1399, null],
	[20, "DD *DOORDASH TACO", 3107, null],
];

// Previous months' category totals in cents, oldest first (5 months ago → 1 month ago).
const HISTORY: Record<number, number[]> = {
	[GROCERIES]: [64000, 65500, 61000, 69000, 67200],
	[EATING_OUT]: [17000, 19500, 21500, 24000, 26200],
	[GAS]: [17000, 18200, 16500, 19000, 17600],
	[KIDS]: [24000, 31000, 20500, 28000, 26000],
	[HOUSEHOLD]: [12000, 21000, 14000, 9500, 18000],
};

export function monthOffset(today: string, monthsAgo: number): string {
	const [y, m] = today.split("-").map(Number) as [number, number];
	const index = y * 12 + (m - 1) - monthsAgo;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function day(month: string, d: number): string {
	return `${month}-${String(d).padStart(2, "0")}`;
}

function spend(
	accountId: number,
	date: string,
	rawName: string,
	categoryId: number | null,
	amountCents: number,
): SeedTransaction {
	return {
		accountId,
		date,
		amountCents,
		rawName,
		merchantName: PLAID_MERCHANT_NAMES[rawName] ?? null,
		categoryId,
		categorySource: categoryId === null ? null : "jev",
		categoryConfidence: categoryId === null ? null : 0.94,
		flagTransfer: false,
		flagReimbursement: false,
		flagIncome: false,
		excluded: false,
		isSplit: false,
	};
}

/**
 * The demo's balance history (spec §9, feature 7): a balance for each bank account on every day from
 * the net-worth chart's first day to today, so the chart shows. Each is today's balance plus a plain
 * pattern in whole cents, so the line ends where the headline does and the same today always makes
 * the same rows. Checking creeps up $5 a day with a $450 swell each month; Savings gains the $500
 * of each monthly transfer on its date; the Credit card builds $15 a day and is paid down every 30.
 */
function balanceHistory(
	today: string,
	transactions: SeedTransaction[],
): SeedBalance[] {
	const balanceToday = (id: number) =>
		ACCOUNTS.find((a) => a.id === id)?.balanceCents ?? 0;
	const transferDates = transactions
		.filter((t) => t.flagTransfer)
		.map((t) => t.date);
	// `k` is how many days before today.
	const checkingSwell = (k: number) => 3000 * Math.abs((k % 30) - 15);
	const cardBuildUp = (k: number) => 1500 * (k % 30);

	const start = `${monthOffset(today, 5)}-01`;
	let oldest = 0;
	while (daysBefore(today, oldest + 1) >= start) oldest++;

	const rows: SeedBalance[] = [];
	for (let k = oldest; k >= 0; k--) {
		const date = daysBefore(today, k);
		rows.push(
			{
				accountId: CHECKING,
				date,
				balanceCents:
					balanceToday(CHECKING) -
					500 * k +
					checkingSwell(k) -
					checkingSwell(0),
			},
			{
				accountId: SAVINGS,
				date,
				balanceCents:
					balanceToday(SAVINGS) -
					50000 * transferDates.filter((d) => d > date).length,
			},
			{
				accountId: CARD,
				date,
				balanceCents:
					balanceToday(CARD) + 120 * k + cardBuildUp(k) - cardBuildUp(0),
			},
		);
	}
	return rows;
}

/** Builds the Rivera household relative to today ('YYYY-MM-DD'). */
export function buildSeed(today: string): Seed {
	const thisMonth = today.slice(0, 7);
	const todayDay = Number(today.slice(8, 10));
	const clamp = (target: number) => day(thisMonth, Math.min(target, todayDay));
	const transactions: SeedTransaction[] = [];

	// Previous 5 months: three transactions per category (days 5, 14, 23), plus paychecks and the savings transfer.
	for (let monthsAgo = 5; monthsAgo >= 1; monthsAgo--) {
		const month = monthOffset(today, monthsAgo);
		for (const category of CATEGORIES) {
			const total = HISTORY[category.id]?.[5 - monthsAgo] ?? 0;
			const merchants = MERCHANTS[category.id] ?? [];
			const third = Math.floor(total / 3);
			[third, third, total - 2 * third].forEach((cents, i) => {
				const [rawName] = merchants[i % merchants.length] as [string, string];
				transactions.push(
					spend(
						i === 2 ? CARD : CHECKING,
						day(month, [5, 14, 23][i] as number),
						rawName,
						category.id,
						cents,
					),
				);
			});
		}
		transactions.push(
			income(day(month, 1)),
			income(day(month, 15)),
			transfer(day(month, 2)),
		);
	}

	// This month.
	for (const [target, rawName, categoryId, cents] of THIS_MONTH) {
		transactions.push(
			spend(CHECKING, clamp(target), rawName, categoryId, cents),
		);
	}
	for (const [target, rawName, cents] of UNCATEGORIZED) {
		transactions.push(spend(CARD, clamp(target), rawName, null, cents));
	}
	transactions.push({
		...spend(CASH, clamp(20), "Farmers market", GROCERIES, 2000),
		categorySource: "user",
		categoryConfidence: null,
	});
	// A plausible Streaming charge that is deliberately outside the five-day
	// matching window. It makes the demo show why merchant and amount alone are
	// not enough to claim a payment.
	const streamingDueDay = Math.min(16, todayDay);
	const priorMonth = monthOffset(today, 1);
	const priorMonthEnd = new Date(
		Date.UTC(Number(priorMonth.slice(0, 4)), Number(priorMonth.slice(5, 7)), 0),
	).getUTCDate();
	const streamingLookalike = new Date(
		`${day(priorMonth, Math.min(streamingDueDay, priorMonthEnd))}T00:00:00Z`,
	);
	streamingLookalike.setUTCDate(streamingLookalike.getUTCDate() + 8);
	transactions.push(
		spend(
			CARD,
			streamingLookalike.toISOString().slice(0, 10),
			"APPLE.COM/BILL",
			HOUSEHOLD,
			299,
		),
	);
	transactions.push(
		income(clamp(1)),
		income(clamp(15)),
		transfer(clamp(2)),
		reimbursement(clamp(10)),
	);

	// Repeat services intentionally not represented by bills, for the bill finder.
	const subscriptions = [
		["GOOGLE *YOUTUBE PREMIUM", 1399],
		["PROCREATE DREAMS", 499],
		["CITY GYM MEMBERSHIP", 4250],
	] as const;
	const subscriptionDay = Math.min(todayDay, 12);
	for (const [rawName, amount] of subscriptions)
		for (const monthsAgo of [2, 1])
			transactions.push(
				spend(
					CARD,
					day(monthOffset(today, monthsAgo), subscriptionDay),
					rawName,
					HOUSEHOLD,
					amount,
				),
			);

	// Spec §9 row 4: the warehouse purchase is already split across two categories.
	const costcoIndex = transactions.findIndex(
		(t) => t.rawName === "COSTCO WHSE #0431" && t.date.startsWith(thisMonth),
	);
	const costco = transactions[costcoIndex];
	if (costco) {
		costco.isSplit = true;
		const parentId = costcoIndex + 1;
		transactions.push(
			{
				...spend(
					costco.accountId,
					costco.date,
					costco.rawName,
					GROCERIES,
					15000,
				),
				parentId,
			},
			{
				...spend(
					costco.accountId,
					costco.date,
					costco.rawName,
					HOUSEHOLD,
					3742,
				),
				parentId,
			},
		);
	}
	// P19: a refund linked to its purchase. The purchase is about 30 days ago, always last month, and
	// the refund 5 days ago, so the refund usually shows counting in the purchase's month.
	const lastMonthEnd = daysBefore(`${thisMonth}-01`, 1);
	const thirtyDaysAgo = daysBefore(today, 30);
	const targetPurchaseId = transactions.length + 1;
	transactions.push(
		spend(
			CARD,
			thirtyDaysAgo < lastMonthEnd ? thirtyDaysAgo : lastMonthEnd,
			"TARGET T-1432",
			KIDS,
			8499,
		),
		{
			...spend(CARD, daysBefore(today, 5), "TARGET T-1432", KIDS, -2499),
			refundOfId: targetPurchaseId,
		},
	);
	transactions.forEach((transaction, index) => {
		transaction.id = index + 1;
	});

	const startMonth = monthOffset(today, 5);
	const budgetAmounts: BudgetAmount[] = [
		{ categoryId: GROCERIES, effectiveMonth: startMonth, amountCents: 70000 },
		{ categoryId: EATING_OUT, effectiveMonth: startMonth, amountCents: 20000 },
		{
			categoryId: EATING_OUT,
			effectiveMonth: monthOffset(today, 2),
			amountCents: 25000,
		},
		{ categoryId: GAS, effectiveMonth: startMonth, amountCents: 20000 },
		{ categoryId: KIDS, effectiveMonth: startMonth, amountCents: 30000 },
		{ categoryId: HOUSEHOLD, effectiveMonth: startMonth, amountCents: 25000 },
	];

	const merchantRows: SeedMerchant[] = [
		...Object.values(MERCHANTS)
			.flat()
			.map(([rawName, displayName]) => ({
				key: seedMerchantKey(rawName),
				displayName,
				defaultCategoryId: null,
			})),
		...UNCATEGORIZED.map(([, rawName, , displayName]) => ({
			key: seedMerchantKey(rawName),
			displayName,
			defaultCategoryId: null,
		})),
		{
			key: "Farmers market",
			displayName: "Farmers market",
			defaultCategoryId: null,
		},
		{
			key: "ACME CORP PAYROLL",
			displayName: "Paycheck, Acme Corp",
			defaultCategoryId: null,
		},
		{
			key: "ONLINE TRANSFER TO SAV ...5678",
			displayName: "Transfer to Savings",
			defaultCategoryId: null,
		},
		{
			key: "DR MARTIN FAMILY PRACTICE REFUND",
			displayName: "Reimbursement, doctor's office",
			defaultCategoryId: null,
		},
		...subscriptions.map(([rawName]) => ({
			key: rawName,
			displayName:
				rawName === "GOOGLE *YOUTUBE PREMIUM"
					? "YouTube Premium"
					: rawName === "PROCREATE DREAMS"
						? "Procreate Dreams"
						: "City Gym",
			defaultCategoryId: HOUSEHOLD,
		})),
	];
	// One row per merchant key. Raw names that share a key (the two Amazons) share its row, the first one's name winning.
	const merchants = merchantRows.filter(
		(m, i) => merchantRows.findIndex((o) => o.key === m.key) === i,
	);

	return {
		categories: CATEGORIES,
		banks: BANKS,
		accounts: ACCOUNTS,
		balanceHistory: balanceHistory(today, transactions),
		merchants,
		budgetAmounts,
		transactions,
	};
}

function income(date: string): SeedTransaction {
	return {
		...spend(CHECKING, date, "ACME CORP PAYROLL", null, -245000),
		flagIncome: true,
	};
}

function transfer(date: string): SeedTransaction {
	return {
		...spend(CHECKING, date, "ONLINE TRANSFER TO SAV ...5678", null, 50000),
		flagTransfer: true,
		excluded: true,
	};
}

function reimbursement(date: string): SeedTransaction {
	return {
		...spend(CHECKING, date, "DR MARTIN FAMILY PRACTICE REFUND", null, -6000),
		flagReimbursement: true,
		excluded: true,
	};
}
