import { and, eq, getTableName, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { matchBillPayments } from "../bills/match";
import { DEFAULT_TIME_ZONE, daysBefore } from "../dates";
import {
	accounts,
	aiLog,
	balanceHistory,
	bankTextRules,
	billAmounts,
	billPayments,
	bills,
	budgetAmounts,
	cashDeleteHolds,
	categories,
	categoryArchivePeriods,
	categorySuggestions,
	documents,
	feedback,
	forgottenTexts,
	householdMembers,
	householdPeople,
	householdSettings,
	lookupAnswers,
	lookupCleared,
	maybeAnswers,
	maybeNames,
	merchantLookups,
	merchantLookupTexts,
	merchantNameFailures,
	merchantSuggestedNames,
	merchants,
	neverSuggestRules,
	plaidItems,
	plannedDeleteHolds,
	plannedExpenses,
	pushSubscriptions,
	savingsGoalAmounts,
	transactions,
} from "../db/schema";
import { nameKey } from "../settings/category-form";
import {
	buildSeed,
	monthOffset,
	NETFLIX,
	RENT_CATEGORY,
	RENT_CENTS,
	RENT_PAYEE,
	type SeedBalance,
	SOCCER_DAY,
	seedMerchantKey,
} from "./seed";

// Electric and Internet are unpaid on purpose (they are what Safe to spend sets aside), so their
// merchants have no charges at all: a bill whose merchant has other charges nearby would be offered
// one as "Price changed?" (spec §8.5). Netflix is the demo's one deliberate offer.
const ELECTRIC_MERCHANT = "METRO ELECTRIC CO";
const INTERNET_MERCHANT = "RIVERSIDE FIBER INTERNET";

// The tables the reset empties, child to parent (a table's rows go before the rows it references). The
// names come from the table objects, so a table is named once, where its schema is.
const TABLE_OBJECTS_CHILD_FIRST = [
	feedback,
	forgottenTexts,
	bankTextRules,
	aiLog,
	maybeAnswers,
	maybeNames,
	cashDeleteHolds,
	plannedDeleteHolds,
	billPayments,
	plannedExpenses,
	neverSuggestRules,
	billAmounts,
	documents,
	balanceHistory,
	lookupAnswers,
	lookupCleared,
	transactions,
	householdPeople,
	categorySuggestions,
	bills,
	budgetAmounts,
	categoryArchivePeriods,
	savingsGoalAmounts,
	merchantNameFailures,
	merchantSuggestedNames,
	merchantLookupTexts,
	merchantLookups,
	merchants,
	categories,
	accounts,
	plaidItems,
	pushSubscriptions,
	householdMembers,
] as const;

export const TABLES_CHILD_FIRST: string[] = TABLE_OBJECTS_CHILD_FIRST.map(
	(table) => getTableName(table),
);

/**
 * The nightly reset runs only in the demo: DEMO is "true" and no Plaid credentials exist.
 * Production always has Plaid credentials and the demo never does (spec §4), so a
 * mistaken DEMO="true" in production still cannot wipe the family's data.
 */
export function canResetDemo(env: {
	DEMO?: string;
	PLAID_SECRET?: string;
	PLAID_CLIENT_ID?: string;
}): boolean {
	return env.DEMO === "true" && !env.PLAID_SECRET && !env.PLAID_CLIENT_ID;
}

const BALANCES_PER_STATEMENT = 33; // 3 bound values each, under D1's limit of 100 per statement

type Orm = ReturnType<typeof drizzle>;

function balanceHistoryStatements(
	orm: Orm,
	balances: SeedBalance[],
): BatchItem<"sqlite">[] {
	const statements: BatchItem<"sqlite">[] = [];

	for (let i = 0; i < balances.length; i += BALANCES_PER_STATEMENT) {
		const chunk = balances.slice(i, i + BALANCES_PER_STATEMENT);
		statements.push(
			orm.insert(balanceHistory).values(
				chunk.map((b) => ({
					accountId: b.accountId,
					date: b.date,
					balanceCents: b.balanceCents,
				})),
			),
		);
	}

	return statements;
}

/**
 * One ai_log row per transaction that `filed` selects, of the given kind, dated by the transaction. A select lists
 * every column in table order, so the id and the created_at are written as their defaults.
 */
function tallyFromJev(orm: Orm, kind: "category" | "income", filed: SQL) {
	return orm.insert(aiLog).select(
		orm
			.select({
				id: sql`NULL`.as("id"),
				kind: sql`${kind}`.as("kind"),
				transactionId: transactions.id,
				merchantRawName: sql`NULL`.as("merchant_raw_name"),
				householdDay: transactions.date,
				createdAt: sql`(datetime('now'))`.as("created_at"),
			})
			.from(transactions)
			.where(filed),
	);
}

/** Wipes the database and reloads the Rivera household. Only ever called when canResetDemo(env) is true. */
export async function resetDemo(
	db: D1Database,
	today: string,
	options: { categoryExample?: boolean } = {},
): Promise<void> {
	const seed = buildSeed(today);
	const todayDay = Number(today.slice(8, 10));
	// The demo's bills count as added long before its history (decision 99, #337), so every seeded occurrence is
	// judged as it was before that rule. No screen shows the day a demo bill was added.
	const addedOn = "2000-01-01";
	const orm = drizzle(db);

	if (todayDay < 4) {
		const waterPayment = seed.transactions.find(
			(transaction) =>
				transaction.rawName === "GOOGLE *YOUTUBE" &&
				transaction.date.startsWith(today.slice(0, 7)),
		);

		if (waterPayment) waterPayment.date = today;
	}

	const b = (v: boolean) => (v ? 1 : 0);

	await orm.batch([
		// The household's choices go back to the start (the AI switches are all on, and a missing
		// row means on), except how many calls Jev has had today: that is the day's, not a choice, so a
		// second run on the same household day can't spend the demo's cap over again (spec §8.6).
		orm
			.delete(householdSettings)
			.where(sql`${householdSettings.key} NOT GLOB ${"jev_calls_*"}`),
		...TABLE_OBJECTS_CHILD_FIRST.map((table) => orm.delete(table)),
		orm.insert(householdPeople).values({ id: 1, name: "Everyone" }),
		// The demo's time zone goes back to the default, like everything else a visitor can change.
		orm
			.insert(householdSettings)
			.values({ key: "time_zone", value: DEFAULT_TIME_ZONE }),
		...seed.categories.map((c) =>
			orm.insert(categories).values({
				id: c.id,
				name: c.name,
				nameKey: nameKey(c.name),
				icon: c.icon,
				color: c.color,
				sortOrder: c.sortOrder,
			}),
		),
		// An empty token: the demo has no Plaid credentials, so nothing ever tries to use it.
		...seed.banks.map((bank) =>
			orm.insert(plaidItems).values({
				id: bank.id,
				accessTokenEncrypted: sql`X''`,
				institutionName: bank.name,
				linkedBy: "demo",
				lastSyncedAt: sql`datetime('now')`,
				lastSyncAttemptAt: sql`datetime('now')`,
			}),
		),
		...seed.accounts.map((a) =>
			orm.insert(accounts).values({
				id: a.id,
				plaidItemId: a.bankId,
				name: a.name,
				mask: a.mask,
				type: a.type,
				subtype: a.subtype,
				isLiability: b(a.isLiability),
				balanceCents: a.balanceCents,
			}),
		),
		// The net-worth chart's six months, a few dozen rows per statement: D1 allows 100 bound values in one.
		...balanceHistoryStatements(orm, seed.balanceHistory),
		...seed.merchants.map((m) =>
			orm.insert(merchants).values({
				rawName: m.key,
				displayName: m.displayName,
				defaultCategoryId: m.defaultCategoryId,
				notABill: m.notABill ? 1 : 0,
				suggestionStatus:
					(m.suggestedNames?.length ?? 0) > 0 ? "pending" : "none",
			}),
		),
		// A seeded suggestion's names, one row per name (at most three), as a person would have them waiting.
		...seed.merchants.flatMap((m) =>
			(m.suggestedNames ?? []).slice(0, 3).map((name, position) =>
				orm.insert(merchantSuggestedNames).values({
					merchantKey: m.key,
					position,
					name,
				}),
			),
		),
		...seed.budgetAmounts.map((a) =>
			orm.insert(budgetAmounts).values({
				categoryId: a.categoryId,
				effectiveMonth: a.effectiveMonth,
				amountCents: a.amountCents,
			}),
		),
		...seed.transactions.map((t) =>
			orm.insert(transactions).values({
				id: t.id,
				accountId: t.accountId,
				date: t.date,
				amountCents: t.amountCents,
				rawName: t.rawName,
				merchantName: t.merchantName ?? null,
				categoryId: t.categoryId,
				categorySource: t.categorySource,
				categoryConfidence: t.categoryConfidence,
				// The seed's Jev-categorized rows are Jev's picks, so they carry a matching pick.
				jevCategoryId: t.categorySource === "jev" ? t.categoryId : null,
				flagTransfer: b(t.flagTransfer),
				flagReimbursement: b(t.flagReimbursement),
				flagIncome: b(t.flagIncome),
				excluded: b(t.excluded),
				isSplit: b(t.isSplit),
				parentId: t.parentId ?? null,
				refundOfId: t.refundOfId ?? null,
				incomeSource: t.flagIncome ? "jev" : null,
				creditReviewed: 1,
				creditReviewedBy: null,
				updatedBy: "demo",
			}),
		),
		// The seed's own Tally work (spec §8.6), read from the rows just inserted above: each transaction Jev
		// gave a category or marked as income, dated by the transaction, so the demo's tally shows the family's work.
		tallyFromJev(orm, "category", eq(transactions.categorySource, "jev")),
		tallyFromJev(orm, "income", eq(transactions.incomeSource, "jev")),
		...demoBills(today, seed.transactions).map((bill) =>
			orm.insert(bills).values({ ...bill, addedOn }),
		),
		// Each bill's first amount row (decision 101), as migration 0044 gives one: this month, so a bill has
		// no earlier price. Netflix's is from the seed's first month instead, so its earlier price is there
		// and its history appears once a visitor accepts the price offer.
		orm.insert(billAmounts).select(
			orm
				.select({
					billId: bills.id,
					effectiveMonth: sql`${today.slice(0, 7)}`.as("effective_month"),
					amountCents: bills.amountCents,
				})
				.from(bills)
				.where(ne(bills.merchantRawName, seedMerchantKey(NETFLIX.rawName))),
		),
		orm.insert(billAmounts).select(
			orm
				.select({
					billId: bills.id,
					effectiveMonth: sql`${monthOffset(today, 5)}`.as("effective_month"),
					amountCents: bills.amountCents,
				})
				.from(bills)
				.where(eq(bills.merchantRawName, seedMerchantKey(NETFLIX.rawName))),
		),
		// Rent's payments are linked by hand (#205, decision 101): two last month make it Paid, and this month's one
		// leaves it part paid. The late one dates this month's 1st but pays last month, so two payments share that date
		// and each is matched on its bank text, date and amount, which the seed's own transactions carry.
		...rentPayments(today).map(([period, date, cents]) =>
			orm.insert(billPayments).select(
				orm
					.select({
						id: sql`NULL`.as("id"),
						billId: bills.id,
						period: sql`${period}`.as("period"),
						transactionId: transactions.id,
						matchedBy: sql`'user'`.as("matched_by"),
						status: sql`'linked'`.as("status"),
						createdAt: sql`(datetime('now'))`.as("created_at"),
						undoToken: sql`NULL`.as("undo_token"),
					})
					.from(bills)
					.crossJoin(transactions)
					.where(
						and(
							eq(bills.merchantRawName, seedMerchantKey(RENT_PAYEE)),
							eq(transactions.rawName, RENT_PAYEE),
							eq(transactions.date, date),
							eq(transactions.amountCents, cents),
						),
					),
			),
		),
		// Planned one-time expenses (#202): one set aside this month, and one from last month still unpaid, so Bills shows
		// its Band ("Car registration wasn't paid") and Safe to spend sets both aside.
		orm.insert(plannedExpenses).values({
			name: "Lawn service",
			amountCents: 9000,
			month: today.slice(0, 7),
			createdBy: "demo",
		}),
		orm.insert(plannedExpenses).values({
			name: "Car registration",
			amountCents: 18000,
			month: monthOffset(today, 1),
			createdBy: "demo",
		}),
	]);

	if (options.categoryExample) {
		const petMonthNumber = Number(today.slice(5, 7)) - 2;

		const petYearNumber =
			Number(today.slice(0, 4)) + Math.floor((petMonthNumber - 1) / 12);

		const petMonthNumberNormalized = ((petMonthNumber - 1 + 12) % 12) + 1;
		const petYear = String(petYearNumber).padStart(4, "0");
		const petMonth = `${petYear}-${String(petMonthNumberNormalized).padStart(2, "0")}`;
		await orm.insert(merchants).values([
			{ rawName: "Chewy", displayName: "Chewy", notABill: 1 },
			{ rawName: "Petsmart", displayName: "Petsmart", notABill: 1 },
			{
				rawName: "Banfield Pet Hospital",
				displayName: "Banfield Pet Hospital",
				notABill: 1,
			},
		]);

		const petSuggestion = await orm
			.insert(categorySuggestions)
			.values({ name: "Pet Care", status: "pending" })
			.returning({ id: categorySuggestions.id })
			.get();

		// One statement per charge, in one batch: a transaction row binds more values than D1 allows for three rows in one statement.
		const petCharge = (
			raw: string,
			merchant: string,
			cents: number,
			day: number,
		) =>
			orm.insert(transactions).values({
				accountId: 1,
				date: `${petMonth}-${String(day).padStart(2, "0")}`,
				amountCents: cents,
				rawName: raw,
				merchantName: merchant,
				plaidCategory: "GENERAL_MERCHANDISE",
				categoryConfidence: 0.95,
				jevNoneFit: 1,
				categorySuggestionId: petSuggestion?.id ?? null,
				updatedBy: "demo",
			});

		await orm.batch([
			petCharge("CHEWY.COM", "Chewy", 6412, 8),
			petCharge("PETSMART 0412", "Petsmart", 2399, 14),
			petCharge("BANFIELD PET HOSPITAL", "Banfield Pet Hospital", 18900, 21),
		]);
	}

	await matchBillPayments(db, today);
}

/** The three rent payments to link: the period each pays, the date it carries and its amount. */
function rentPayments(today: string): [string, string, number][] {
	return [
		[monthOffset(today, 1), `${monthOffset(today, 1)}-01`, 70000],
		[monthOffset(today, 1), `${today.slice(0, 7)}-01`, 50000],
		[today.slice(0, 7), `${today.slice(0, 7)}-01`, 60000],
	];
}

function demoBills(
	today: string,
	transactions: { date: string; rawName: string; amountCents: number }[],
): (typeof bills.$inferInsert)[] {
	const day = Number(today.slice(8, 10));
	// The soccer payment the yearly bill is linked to, so its amount matches (src/demo/seed.ts).
	const soccerDay = SOCCER_DAY;

	const paidSoccer = {
		cents:
			transactions.find(
				(t) =>
					t.rawName === "YOUTH SOCCER LEAGUE" &&
					t.date ===
						`${monthOffset(today, 3)}-${String(soccerDay).padStart(2, "0")}`,
			)?.amountCents ?? 9000,
	};

	const paymentDay = (rawName: string) =>
		Number(
			transactions
				.filter((transaction) => transaction.rawName === rawName)
				.sort((a, b) => b.date.localeCompare(a.date))[0]
				?.date.slice(8) ?? day,
		);

	const threeDaysBeforePayment = (rawName: string) => {
		const payment = transactions
			.slice()
			.reverse()
			.find((transaction) => transaction.rawName === rawName)?.date;

		const due = new Date(`${payment ?? today}T00:00:00Z`);
		due.setUTCDate(due.getUTCDate() - 3);

		return due.getUTCDate();
	};

	// The day before Netflix's charge, wherever the seed put it (the previous month's last day, on the 1st).
	const netflixDue = daysBefore(
		transactions.find((t) => t.rawName === NETFLIX.rawName)?.date ?? today,
		1,
	);

	const plusThree = new Date(`${today}T00:00:00Z`);
	plusThree.setUTCDate(plusThree.getUTCDate() + 3);
	const dueSoon = plusThree.getUTCDate();

	return [
		{
			id: 1,
			name: "Streaming",
			amountCents: 299,
			dueDay: paymentDay("APPLE.COM/BILL"),
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: seedMerchantKey("APPLE.COM/BILL"),
			active: 1,
		},
		{
			id: 2,
			name: "Water",
			amountCents: 1399,
			dueDay: threeDaysBeforePayment("GOOGLE *YOUTUBE"),
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: seedMerchantKey("GOOGLE *YOUTUBE"),
			active: 1,
		},
		{
			id: 3,
			name: "Electric",
			amountCents: 14200,
			dueDay: day === 1 ? 28 : day - 1,
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: ELECTRIC_MERCHANT,
			active: 1,
		},
		// Due the day before its $17.99 charge, which is 16% over $15.49: overdue, with the charge on offer.
		{
			id: 4,
			name: "Netflix",
			amountCents: NETFLIX.billCents,
			dueDay: Number(netflixDue.slice(8)),
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: seedMerchantKey(NETFLIX.rawName),
			active: 1,
		},
		{
			id: 5,
			name: "Internet",
			amountCents: 6500,
			dueDay: dueSoon,
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: INTERNET_MERCHANT,
			active: 1,
		},
		// Yearly, paid three months ago, so its next one is upcoming (decision 62).
		{
			id: 6,
			name: "Soccer league",
			amountCents: paidSoccer.cents,
			dueDay: soccerDay,
			frequency: "yearly",
			anchorMonth: Number(monthOffset(today, 3).slice(5)),
			categoryId: 4,
			merchantRawName: seedMerchantKey("YOUTH SOCCER LEAGUE"),
			active: 1,
		},
		{
			id: 7,
			name: "Old phone plan",
			amountCents: 4500,
			dueDay: 15,
			frequency: "monthly",
			anchorMonth: null,
			categoryId: 5,
			merchantRawName: seedMerchantKey("GOOGLE *YOUTUBE"),
			active: 0,
		},
		{
			id: 8,
			name: "Daycare",
			amountCents: 24000,
			dueDay: 5,
			frequency: "weekly",
			anchorMonth: null,
			categoryId: 6,
			merchantRawName: seedMerchantKey("LITTLE SPROUTS DAYCARE"),
			active: 1,
		},
		{
			id: 9,
			name: "Rent",
			amountCents: RENT_CENTS,
			dueDay: 1,
			frequency: "monthly",
			anchorMonth: null,
			categoryId: RENT_CATEGORY,
			merchantRawName: seedMerchantKey(RENT_PAYEE),
			active: 1,
		},
	];
}
