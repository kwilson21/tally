// The Rivera family: the demo household. Plain data, relative to "today", so the demo always looks current.
// Nothing here is real. Designed totals are documented in the Phase 1b plan and asserted in test/seed.test.ts.

import type { BudgetAmount } from "../budget";

export type SeedCategory = { id: number; name: string; icon: string; color: string; sortOrder: number };
export type SeedAccount = { id: number; name: string; mask: string; type: string; subtype: string; isLiability: boolean; balanceCents: number };
export type SeedMerchant = { rawName: string; displayName: string | null; defaultCategoryId: number | null };
export type SeedTransaction = {
	accountId: number;
	date: string;
	amountCents: number;
	rawName: string;
	categoryId: number | null;
	categorySource: "jev" | null;
	categoryConfidence: number | null;
	flagTransfer: boolean;
	flagReimbursement: boolean;
	flagIncome: boolean;
	excluded: boolean;
	isSplit: boolean;
};
export type Seed = {
	categories: SeedCategory[];
	accounts: SeedAccount[];
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

const CATEGORIES: SeedCategory[] = [
	{ id: GROCERIES, name: "Groceries", icon: "groceries", color: "cat-blue", sortOrder: 1 },
	{ id: EATING_OUT, name: "Eating Out", icon: "eating-out", color: "cat-plum", sortOrder: 2 },
	{ id: GAS, name: "Gas", icon: "gas", color: "cat-slate", sortOrder: 3 },
	{ id: KIDS, name: "Kids", icon: "kids", color: "cat-ochre", sortOrder: 4 },
	{ id: HOUSEHOLD, name: "Household", icon: "household", color: "cat-brown", sortOrder: 5 },
];

const ACCOUNTS: SeedAccount[] = [
	{ id: CHECKING, name: "Checking", mask: "1234", type: "depository", subtype: "checking", isLiability: false, balanceCents: 421055 },
	{ id: SAVINGS, name: "Savings", mask: "5678", type: "depository", subtype: "savings", isLiability: false, balanceCents: 1240000 },
	{ id: CARD, name: "Credit card", mask: "9012", type: "credit", subtype: "credit card", isLiability: true, balanceCents: 84217 },
];

// Categorized merchants: raw name as a bank sends it → display name.
const MERCHANTS: Record<number, [string, string][]> = {
	[GROCERIES]: [["TRADER JOE'S #552", "Trader Joe's"], ["COSTCO WHSE #0431", "Costco"], ["WHOLEFDS MKT 10233", "Whole Foods"]],
	[EATING_OUT]: [["BLUE BOTTLE COFFEE", "Blue Bottle Coffee"], ["CHIPOTLE 2291", "Chipotle"], ["OLIVE GARDEN 1187", "Olive Garden"], ["MARIO'S PIZZA", "Mario's Pizza"], ["STARBUCKS STORE 5521", "Starbucks"], ["THAI PALACE", "Thai Palace"]],
	[GAS]: [["SHELL OIL 57442", "Shell"], ["CHEVRON 0098812", "Chevron"]],
	[KIDS]: [["TARGET T-1432", "Target"], ["YOUTH SOCCER LEAGUE", "Youth Soccer League"], ["BARNES & NOBLE #2831", "Barnes & Noble"]],
	[HOUSEHOLD]: [["THE HOME DEPOT #6612", "The Home Depot"], ["AMAZON.COM*RT4K2", "Amazon"]],
};

// This month, categorized: [targetDay, rawName, categoryId, cents]. Totals per the plan's table.
const THIS_MONTH: [number, string, number, number][] = [
	[2, "TRADER JOE'S #552", GROCERIES, 6418], [9, "COSTCO WHSE #0431", GROCERIES, 18742], [16, "WHOLEFDS MKT 10233", GROCERIES, 9630], [22, "TRADER JOE'S #552", GROCERIES, 6410],
	[3, "BLUE BOTTLE COFFEE", EATING_OUT, 650], [6, "CHIPOTLE 2291", EATING_OUT, 3840], [12, "OLIVE GARDEN 1187", EATING_OUT, 11280], [15, "MARIO'S PIZZA", EATING_OUT, 6430], [19, "STARBUCKS STORE 5521", EATING_OUT, 1200], [21, "THAI PALACE", EATING_OUT, 5200],
	[4, "SHELL OIL 57442", GAS, 4820], [11, "CHEVRON 0098812", GAS, 5210], [17, "SHELL OIL 57442", GAS, 3770], [20, "CHEVRON 0098812", GAS, 4800],
	[5, "TARGET T-1432", KIDS, 8499], [8, "YOUTH SOCCER LEAGUE", KIDS, 9000], [18, "BARNES & NOBLE #2831", KIDS, 3501],
	[7, "THE HOME DEPOT #6612", HOUSEHOLD, 6125], [13, "AMAZON.COM*RT4K2", HOUSEHOLD, 3375],
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

function monthOffset(today: string, monthsAgo: number): string {
	const [y, m] = today.split("-").map(Number) as [number, number];
	const index = y * 12 + (m - 1) - monthsAgo;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function day(month: string, d: number): string {
	return `${month}-${String(d).padStart(2, "0")}`;
}

function spend(accountId: number, date: string, rawName: string, categoryId: number | null, amountCents: number): SeedTransaction {
	return {
		accountId,
		date,
		amountCents,
		rawName,
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
				transactions.push(spend(i === 2 ? CARD : CHECKING, day(month, [5, 14, 23][i] as number), rawName, category.id, cents));
			});
		}
		transactions.push(income(day(month, 1)), income(day(month, 15)), transfer(day(month, 2)));
	}

	// This month.
	for (const [target, rawName, categoryId, cents] of THIS_MONTH) {
		transactions.push(spend(CHECKING, clamp(target), rawName, categoryId, cents));
	}
	for (const [target, rawName, cents] of UNCATEGORIZED) {
		transactions.push(spend(CARD, clamp(target), rawName, null, cents));
	}
	transactions.push(income(clamp(1)), income(clamp(15)), transfer(clamp(2)), reimbursement(clamp(10)));

	const startMonth = monthOffset(today, 5);
	const budgetAmounts: BudgetAmount[] = [
		{ categoryId: GROCERIES, effectiveMonth: startMonth, amountCents: 70000 },
		{ categoryId: EATING_OUT, effectiveMonth: startMonth, amountCents: 20000 },
		{ categoryId: EATING_OUT, effectiveMonth: monthOffset(today, 2), amountCents: 25000 },
		{ categoryId: GAS, effectiveMonth: startMonth, amountCents: 20000 },
		{ categoryId: KIDS, effectiveMonth: startMonth, amountCents: 30000 },
		{ categoryId: HOUSEHOLD, effectiveMonth: startMonth, amountCents: 25000 },
	];

	const merchants: SeedMerchant[] = [
		...Object.values(MERCHANTS)
			.flat()
			.map(([rawName, displayName]) => ({ rawName, displayName, defaultCategoryId: null })),
		...UNCATEGORIZED.map(([, rawName, , displayName]) => ({ rawName, displayName, defaultCategoryId: null })),
		{ rawName: "ACME CORP PAYROLL", displayName: "Paycheck, Acme Corp", defaultCategoryId: null },
		{ rawName: "ONLINE TRANSFER TO SAV ...5678", displayName: "Transfer to Savings", defaultCategoryId: null },
		{ rawName: "DR MARTIN FAMILY PRACTICE REFUND", displayName: "Reimbursement, doctor's office", defaultCategoryId: null },
	];

	return { categories: CATEGORIES, accounts: ACCOUNTS, merchants, budgetAmounts, transactions };
}

function income(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "ACME CORP PAYROLL", null, -245000), flagIncome: true };
}

function transfer(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "ONLINE TRANSFER TO SAV ...5678", null, 50000), flagTransfer: true, excluded: true };
}

function reimbursement(date: string): SeedTransaction {
	return { ...spend(CHECKING, date, "DR MARTIN FAMILY PRACTICE REFUND", null, -6000), flagReimbursement: true, excluded: true };
}
