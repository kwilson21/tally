// The Rivera family: the demo household. Plain data, relative to "today", so the demo always looks current.
// Nothing here is real. Designed totals are documented in the Phase 1b plan and asserted in test/seed.test.ts.

import type { BudgetAmount } from "../budget";
import { daysBefore, daysInMonth } from "../dates";

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
	/** "Not a bill" (decision 60): the finder never suggests this merchant. */
	notABill?: boolean;
	/** Names Tally guessed for it, up to three, waiting for a person (spec §7), so suggestions show right after a reset. */
	suggestedNames?: string[];
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
	categorySource: "jev" | "user" | "bill" | null;
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
const CHILDCARE = 6;
/** Rent (#205): its own budget category, and the rent bill it pays in parts, by hand (decision 101). */
export const RENT_CATEGORY = 7;
export const RENT_PAYEE = "HARBOR PROPERTY MGMT";
export const RENT_CENTS = 120000;

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
	{
		id: CHILDCARE,
		name: "Childcare",
		icon: "kids",
		color: "cat-blue",
		sortOrder: 6,
	},
	{
		id: RENT_CATEGORY,
		name: "Rent",
		icon: "household",
		color: "cat-ochre",
		sortOrder: 7,
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
	// Plaid names this one, so its first suggestion is the bank's own name (spec §8.6, #194).
	"CHECKCARD 0921 CVS": "CVS Pharmacy",
};

/** The demo's one subscription that raised its price: the bill is $15.49, the charge $17.99 (P36 B). */
export const NETFLIX = {
	rawName: "NETFLIX.COM",
	displayName: "Netflix",
	billCents: 1549,
	chargedCents: 1799,
};

/** The merchant key of a seeded raw name (spec §6.1): Plaid's merchant name, otherwise the raw name. */
export const seedMerchantKey = (rawName: string) =>
	PLAID_MERCHANT_NAMES[rawName] ?? rawName;

// This month, categorized: [day, rawName, categoryId, cents]. Each is dated its day of the month (the month's last day
// at most) and is there only once that day has come, so the month fills at a family's pace and Home's forecast agrees
// with its sentence (#322). The 1st's Trader Joe's is there every day: it keeps id 94, which a screenshot uses.
const THIS_MONTH: [number, string, number, number][] = [
	[31, "TRADER JOE'S #552", GROCERIES, 7418],
	[18, "COSTCO WHSE #0431", GROCERIES, 18742],
	[24, "WHOLEFDS MKT 10233", GROCERIES, 8630],
	[1, "TRADER JOE'S #552", GROCERIES, 6410],
	[3, "BLUE BOTTLE COFFEE", EATING_OUT, 650],
	[8, "CHIPOTLE 2291", EATING_OUT, 3840],
	[10, "OLIVE GARDEN 1187", EATING_OUT, 11280],
	[13, "MARIO'S PIZZA", EATING_OUT, 10630],
	[30, "STARBUCKS STORE 5521", EATING_OUT, 1200],
	[20, "THAI PALACE", EATING_OUT, 7200],
	[5, "SHELL OIL 57442", GAS, 4820],
	[14, "CHEVRON 0098812", GAS, 4950],
	[20, "SHELL OIL 57442", GAS, 6330],
	[31, "CHEVRON 0098812", GAS, 2500],
	[22, "TARGET T-1432", KIDS, 6000],
	[26, "YOUTH SOCCER LEAGUE", KIDS, 9000],
	[29, "BARNES & NOBLE #2831", KIDS, 6000],
	[27, "THE HOME DEPOT #6612", HOUSEHOLD, 6125],
	[28, "AMAZON.COM*RT4K2", HOUSEHOLD, 3375],
];

// Suggested names for a few of the unnamed merchants below, waiting for a person (spec §7, §8.6). They show
// dashed in the list until a person chooses, so suggestions show right after a reset. Most are names Tally
// "guessed", as Workers AI would suggest them; CVS's is the bank's own, Plaid's merchant name above.
const SUGGESTED_NAMES: Record<string, string[]> = {
	"TST* CORNER DELI": ["Corner Deli Cafe"],
	"SP * CRAFTSUPPLY": ["Craft Supply Co", "Craft Supply"],
	"CHECKCARD 0921 CVS": ["CVS Pharmacy"],
	"POS 4417 CITY PARKING": ["City Parking Garage", "City Parking Lot"],
};

// Twelve seed rows start without categories ($121.52); bill matching categorizes two of them. They are there every day,
// dated their day or today if that is earlier, so the ten left for a person ($104.54) are always this month's.
// [targetDay, rawName, cents, displayName].
const UNCATEGORIZED: [number, string, number, string | null][] = [
	[22, "SQ *LOCAL BAKERY 4432", 1200, "Local Bakery"],
	[3, "PAYPAL *XYZSHOP", 899, null],
	[5, "SQ *FARMERS MKT", 700, null],
	[6, "VENMO *J RIVERA", 1500, null],
	[8, "TST* CORNER DELI", 825, null],
	[10, "AMZN MKTP US*2K4", 999, null],
	[11, "SP * CRAFTSUPPLY", 680, null],
	[13, "POS 4417 CITY PARKING", 500, null],
	[14, "CHECKCARD 0921 CVS", 1643, null],
	[16, "APPLE.COM/BILL", 299, null],
	[18, "GOOGLE *YOUTUBE", 1399, null],
	[20, "DD *DOORDASH TACO", 1508, null],
];

// Previous months' category totals in cents, oldest first (5 months ago → 1 month ago).
const HISTORY: Record<number, number[]> = {
	[GROCERIES]: [64000, 65500, 61000, 69000, 67200],
	[EATING_OUT]: [17000, 19500, 21500, 24000, 26200],
	[GAS]: [17000, 18200, 16500, 19000, 17600],
	[KIDS]: [24000, 31000, 20500, 28000, 26000],
	[HOUSEHOLD]: [12000, 21000, 14000, 9500, 18000],
};

/** The day of an earlier month the soccer league is paid, which the yearly Soccer bill is linked to (reset.ts). */
export const SOCCER_DAY = 26;

/**
 * Each category's three purchases in an earlier month: [day of the month (its last day at most), percent of the
 * month's total], in the order of its merchants above. They are spread through the month differently from this month's,
 * and test/trends-seed.test.ts checks that Trends' same-days comparison stays under $400 on its dates (spec §8.3).
 * Kids' second is the soccer league.
 */
const HISTORY_PARTS: Record<number, [number, number][]> = {
	[GROCERIES]: [
		[31, 17],
		[1, 53],
		[18, 30],
	],
	[EATING_OUT]: [
		[28, 15],
		[29, 25],
		[10, 60],
	],
	[GAS]: [
		[6, 11],
		[13, 62],
		[20, 27],
	],
	[KIDS]: [
		[20, 34],
		[SOCCER_DAY, 47],
		[27, 19],
	],
	[HOUSEHOLD]: [
		[24, 53],
		[22, 27],
		[5, 20],
	],
};

export function monthOffset(today: string, monthsAgo: number): string {
	const [y, m] = today.split("-").map(Number) as [number, number];
	const index = y * 12 + (m - 1) - monthsAgo;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function day(month: string, d: number): string {
	return `${month}-${String(d).padStart(2, "0")}`;
}

/** Daycare's Fridays: every Friday of last month, then this month's up to and including today. */
function daycareFridays(today: string): string[] {
	const dates: string[] = [];
	const cursor = new Date(`${monthOffset(today, 1)}-01T00:00:00Z`);
	while (cursor.toISOString().slice(0, 10) <= today) {
		if (cursor.getUTCDay() === 5) dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
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
 * the same rows. Checking creeps up $20 a day with a $450 swell each month; each monthly transfer
 * moves its $500 out of Checking into Savings on its date, so it never changes net worth; the Credit
 * card builds $15 a day and is paid down every 30.
 */
function balanceHistory(
	today: string,
	transactions: SeedTransaction[],
): SeedBalance[] {
	const balanceToday = (id: number) =>
		ACCOUNTS.find((a) => a.id === id)?.balanceCents ?? 0;
	const transfers = transactions.filter((t) => t.flagTransfer);
	// What the transfers after `date` moved, still in Checking on `date` and not yet in Savings.
	const movedAfter = (date: string) =>
		transfers
			.filter((t) => t.date > date)
			.reduce((sum, t) => sum + t.amountCents, 0);
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
					2000 * k +
					checkingSwell(k) -
					checkingSwell(0) +
					movedAfter(date),
			},
			{
				accountId: SAVINGS,
				date,
				balanceCents: balanceToday(SAVINGS) - movedAfter(date),
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
	// A day of `month`, the month's last day at most.
	const onDay = (month: string, target: number) =>
		day(month, Math.min(target, daysInMonth(month)));
	const transactions: SeedTransaction[] = [];

	// Previous 5 months: three transactions per category (HISTORY_PARTS), plus paychecks and the savings transfer.
	for (let monthsAgo = 5; monthsAgo >= 1; monthsAgo--) {
		const month = monthOffset(today, monthsAgo);
		// Childcare has no history of its own: its Fridays are only Daycare charges, added below.
		for (const category of CATEGORIES.filter((c) => HISTORY[c.id])) {
			const total = HISTORY[category.id]?.[5 - monthsAgo] ?? 0;
			const merchants = MERCHANTS[category.id] ?? [];
			const parts = HISTORY_PARTS[category.id] ?? [];
			let left = total;
			parts.forEach(([target, percent], i) => {
				// The last part takes what is left, so the month's total is exact.
				const cents =
					i === parts.length - 1 ? left : Math.floor((total * percent) / 100);
				left -= cents;
				// Two and four months ago each part goes to the next merchant, so a store's charges a month apart
				// differ and the bill finder never takes one for a bill.
				const [rawName] = merchants[
					(i + (monthsAgo % 2 === 0 ? 1 : 0)) % merchants.length
				] as [string, string];
				transactions.push(
					spend(
						i === 2 ? CARD : CHECKING,
						onDay(month, target),
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

	// This month. A categorized row dated after today is dropped once ids are given (below), so ids never move.
	for (const [target, rawName, categoryId, cents] of THIS_MONTH) {
		transactions.push(
			spend(CHECKING, onDay(thisMonth, target), rawName, categoryId, cents),
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
		// The person split this purchase and picked each part's category, so neither is Jev's pick.
		transactions.push(
			{
				...spend(
					costco.accountId,
					costco.date,
					costco.rawName,
					GROCERIES,
					15000,
				),
				categorySource: "user",
				categoryConfidence: null,
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
				categorySource: "user",
				categoryConfidence: null,
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
	// Daycare: $240 on each Friday of last month and of this month so far, from Checking and categorized
	// as Childcare. Added before Netflix, so Netflix stays last.
	for (const friday of daycareFridays(today))
		transactions.push(
			spend(CHECKING, friday, "LITTLE SPROUTS DAYCARE", CHILDCARE, 24000),
		);
	// Rent is paid in parts (#205, decision 101): $700 and $500 last month make it Paid, and $600 this month so far
	// leaves it part paid. The $500 came late: it dates this month's 1st but reset links it to last month, so it counts
	// in last month and not in this month's days, and Trends' same-days comparison keeps Rent $100 in the household's
	// favour on every day. Reset links each one to the rent bill by hand. Its category is the bill's (Rent, its own
	// $1,200 budget), as a payment linked to a bill takes its category (spec §7). Added before Netflix, so Netflix stays last.
	const rentPayment = (date: string, cents: number): SeedTransaction => ({
		...spend(CHECKING, date, RENT_PAYEE, RENT_CATEGORY, cents),
		categorySource: "bill",
		categoryConfidence: null,
	});
	const lastMonth = monthOffset(today, 1);
	transactions.push(
		rentPayment(day(lastMonth, 1), 70000),
		rentPayment(day(thisMonth, 1), 50000),
		rentPayment(day(thisMonth, 1), 60000),
	);
	// P36 B (decision 72): a subscription whose price went up, so the demo shows "Price changed?" on
	// one bill. Netflix charged $17.99 yesterday (today, on the 1st, to stay in this month). Its bill,
	// $15.49, is due the day before the charge (see demoBills): the charge is inside the matcher's date
	// window but 16% over, so it is offered, not matched, and the bill's occurrence is overdue on every
	// day of the month, since the next one is always a month away. Appended last, so the ids above
	// don't move.
	transactions.push(
		spend(
			CARD,
			day(thisMonth, Math.max(1, todayDay - 1)),
			NETFLIX.rawName,
			HOUSEHOLD,
			NETFLIX.chargedCents,
		),
	);
	transactions.forEach((transaction, index) => {
		transaction.id = index + 1;
	});
	// This month's purchases still to come aren't there yet (a split's parts go with their parent).
	const upToToday = transactions.filter(
		(transaction) => transaction.date <= today,
	);

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
		// Rent's budget starts this month, so earlier months have no budget to be under (Trends' story is unchanged).
		{
			categoryId: RENT_CATEGORY,
			effectiveMonth: thisMonth,
			amountCents: RENT_CENTS,
		},
		{ categoryId: KIDS, effectiveMonth: startMonth, amountCents: 30000 },
		{ categoryId: HOUSEHOLD, effectiveMonth: startMonth, amountCents: 25000 },
		// $1,200 is five Fridays of Daycare at $240, so the month with five Fridays stays within it (#631).
		{
			categoryId: CHILDCARE,
			effectiveMonth: monthOffset(today, 0),
			amountCents: 120000,
		},
		// From this month on, Groceries' budget is $950, not $700, so the last week's bills and Childcare's fifth Friday
		// leave Safe to spend at $0 or more (#631). Earlier months keep $700, as they were.
		{
			categoryId: GROCERIES,
			effectiveMonth: monthOffset(today, 0),
			amountCents: 95000,
		},
	];

	const merchantRows: SeedMerchant[] = [
		...Object.values(MERCHANTS)
			.flat()
			.map(([rawName, displayName]) => ({
				key: seedMerchantKey(rawName),
				displayName,
				defaultCategoryId: null,
				// A store, not a bill: its charges are about monthly, so the finder would suggest it.
				notABill: rawName === "THE HOME DEPOT #6612",
			})),
		...UNCATEGORIZED.map(([, rawName, , displayName]) => ({
			key: seedMerchantKey(rawName),
			displayName,
			defaultCategoryId: null,
			suggestedNames: SUGGESTED_NAMES[rawName],
		})),
		{
			key: "Farmers market",
			displayName: "Farmers market",
			defaultCategoryId: null,
		},
		{
			key: seedMerchantKey(NETFLIX.rawName),
			displayName: NETFLIX.displayName,
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
		{
			key: seedMerchantKey("LITTLE SPROUTS DAYCARE"),
			displayName: "Little Sprouts Daycare",
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
		// Rent's payee, last so the rows before it keep their ids (#205).
		{
			key: seedMerchantKey(RENT_PAYEE),
			displayName: "Harbor Property",
			defaultCategoryId: null,
		},
	];
	// One row per merchant key. Raw names that share a key (the two Amazons) share its row, the first one's name winning.
	const merchants = merchantRows.filter(
		(m, i) => merchantRows.findIndex((o) => o.key === m.key) === i,
	);

	return {
		categories: CATEGORIES,
		banks: BANKS,
		accounts: ACCOUNTS,
		balanceHistory: balanceHistory(today, upToToday),
		merchants,
		budgetAmounts,
		transactions: upToToday,
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
