import { matchBillPayments } from "../bills/match";
import { DEFAULT_TIME_ZONE, daysBefore } from "../dates";
import { nameKey } from "../settings/category-form";
import { storeSuggestedNames } from "../transactions/name-suggestions";
import {
	buildSeed,
	monthOffset,
	NETFLIX,
	RENT_CATEGORY,
	RENT_CENTS,
	RENT_PAYEE,
	type SeedBalance,
	seedMerchantKey,
} from "./seed";

// Electric and Internet are unpaid on purpose (they are what Safe to spend sets aside), so their
// merchants have no charges at all: a bill whose merchant has other charges nearby would be offered
// one as "Price changed?" (spec §8.5). Netflix is the demo's one deliberate offer.
const ELECTRIC_MERCHANT = "METRO ELECTRIC CO";
const INTERNET_MERCHANT = "RIVERSIDE FIBER INTERNET";

// Deletes in child-to-parent order, then inserts the seed, all in one atomic batch.
const TABLES_CHILD_FIRST = [
	"ai_log",
	"cash_delete_holds",
	"bill_payments",
	"never_suggest_rules",
	"bill_amounts",
	"documents",
	"balance_history",
	"transactions",
	"household_people",
	"category_suggestions",
	"bills",
	"budget_amounts",
	"category_archive_periods",
	"savings_goal_amounts",
	"merchant_name_failures",
	"merchants",
	"categories",
	"accounts",
	"plaid_items",
	"household_members",
];

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

function balanceHistoryStatements(
	db: D1Database,
	balances: SeedBalance[],
): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [];
	for (let i = 0; i < balances.length; i += BALANCES_PER_STATEMENT) {
		const chunk = balances.slice(i, i + BALANCES_PER_STATEMENT);
		statements.push(
			db
				.prepare(
					`INSERT INTO balance_history (account_id, date, balance_cents) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
				)
				.bind(...chunk.flatMap((b) => [b.accountId, b.date, b.balanceCents])),
		);
	}
	return statements;
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
	if (todayDay < 4) {
		const waterPayment = seed.transactions.find(
			(transaction) =>
				transaction.rawName === "GOOGLE *YOUTUBE" &&
				transaction.date.startsWith(today.slice(0, 7)),
		);
		if (waterPayment) waterPayment.date = today;
	}
	const b = (v: boolean) => (v ? 1 : 0);

	await db.batch([
		...TABLES_CHILD_FIRST.map((t) => db.prepare(`DELETE FROM ${t}`)),
		// The household's choices go back to the start (the AI switches are all on, and a missing
		// row means on), except how many calls Jev has had today: that is the day's, not a choice, so a
		// second run on the same household day can't spend the demo's cap over again (spec §8.6).
		db.prepare(
			"DELETE FROM household_settings WHERE key NOT GLOB 'jev_calls_*'",
		),
		db.prepare(
			"INSERT INTO household_people (id, name) VALUES (1, 'Everyone')",
		),
		// The demo's time zone goes back to the default, like everything else a visitor can change.
		db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('time_zone', ?)",
			)
			.bind(DEFAULT_TIME_ZONE),
		...seed.categories.map((c) =>
			db
				.prepare(
					"INSERT INTO categories (id, name, name_key, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(c.id, c.name, nameKey(c.name), c.icon, c.color, c.sortOrder),
		),
		// An empty token: the demo has no Plaid credentials, so nothing ever tries to use it.
		...seed.banks.map((bank) =>
			db
				.prepare(
					"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by, last_synced_at, last_sync_attempt_at) VALUES (?, X'', ?, 'demo', datetime('now'), datetime('now'))",
				)
				.bind(bank.id, bank.name),
		),
		...seed.accounts.map((a) =>
			db
				.prepare(
					"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					a.id,
					a.bankId,
					a.name,
					a.mask,
					a.type,
					a.subtype,
					b(a.isLiability),
					a.balanceCents,
				),
		),
		// The net-worth chart's six months, a few dozen rows per statement: D1 allows 100 bound values in one.
		...balanceHistoryStatements(db, seed.balanceHistory),
		...seed.merchants.map((m) =>
			db
				.prepare(
					"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill, suggested_name, suggestion_status) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(
					m.key,
					m.displayName,
					m.defaultCategoryId,
					m.notABill ? 1 : 0,
					m.suggestedNames ? storeSuggestedNames(m.suggestedNames) : null,
					m.suggestedNames ? "pending" : "none",
				),
		),
		...seed.budgetAmounts.map((a) =>
			db
				.prepare(
					"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, ?, ?)",
				)
				.bind(a.categoryId, a.effectiveMonth, a.amountCents),
		),
		...seed.transactions.map((t) =>
			db
				.prepare(
					`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, category_confidence,
					 jev_category_id, flag_transfer, flag_reimbursement, flag_income, excluded, is_split, parent_id, refund_of_id, income_source, credit_reviewed, credit_reviewed_by, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 'demo')`,
				)
				.bind(
					t.id,
					t.accountId,
					t.date,
					t.amountCents,
					t.rawName,
					t.merchantName ?? null,
					t.categoryId,
					t.categorySource,
					t.categoryConfidence,
					// The seed's Jev-categorized rows are Jev's picks, so they carry a matching pick.
					t.categorySource === "jev" ? t.categoryId : null,
					b(t.flagTransfer),
					b(t.flagReimbursement),
					b(t.flagIncome),
					b(t.excluded),
					b(t.isSplit),
					t.parentId ?? null,
					t.refundOfId ?? null,
					t.flagIncome ? "jev" : null,
				),
		),
		// The seed's own Tally work (spec §8.6), read from the rows just inserted above: each transaction Jev
		// gave a category or marked as income, dated by the transaction, so the demo's tally shows the family's work.
		db.prepare(
			"INSERT INTO ai_log (kind, transaction_id, household_day) SELECT 'category', id, date FROM transactions WHERE category_source = 'jev'",
		),
		db.prepare(
			"INSERT INTO ai_log (kind, transaction_id, household_day) SELECT 'income', id, date FROM transactions WHERE income_source = 'jev'",
		),
		...demoBills(today, seed.transactions).map((bill) =>
			db
				.prepare(
					"INSERT INTO bills (id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name,active,added_on) VALUES (?,?,?,?,?,?,?,?,?,?)",
				)
				.bind(...bill, addedOn),
		),
		// Each bill's first amount row (decision 101), as migration 0044 gives one: this month, so a bill has
		// no earlier price. Netflix's is from the seed's first month instead, so its earlier price is there
		// and its history appears once a visitor accepts the price offer.
		db
			.prepare(
				"INSERT INTO bill_amounts (bill_id, effective_month, amount_cents) SELECT id, ?, amount_cents FROM bills WHERE merchant_raw_name <> ?",
			)
			.bind(today.slice(0, 7), seedMerchantKey(NETFLIX.rawName)),
		db
			.prepare(
				"INSERT INTO bill_amounts (bill_id, effective_month, amount_cents) SELECT id, ?, amount_cents FROM bills WHERE merchant_raw_name = ?",
			)
			.bind(monthOffset(today, 5), seedMerchantKey(NETFLIX.rawName)),
		// Rent's payments are linked by hand (#205, decision 101): two last month make it Paid, and this month's one
		// leaves it part paid. The late one dates this month's 1st but pays last month, so two payments share that date
		// and each is matched on its bank text, date and amount, which the seed's own transactions carry.
		...[
			[monthOffset(today, 1), `${monthOffset(today, 1)}-01`, 70000],
			[monthOffset(today, 1), `${today.slice(0, 7)}-01`, 50000],
			[today.slice(0, 7), `${today.slice(0, 7)}-01`, 60000],
		].map(([period, date, cents]) =>
			db
				.prepare(
					"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT b.id, ?, t.id, 'user', 'linked' FROM bills b, transactions t WHERE b.merchant_raw_name = ? AND t.raw_name = ? AND t.date = ? AND t.amount_cents = ?",
				)
				.bind(period, seedMerchantKey(RENT_PAYEE), RENT_PAYEE, date, cents),
		),
	]);
	if (options.categoryExample) {
		const petMonthNumber = Number(today.slice(5, 7)) - 2;
		const petYearNumber =
			Number(today.slice(0, 4)) + Math.floor((petMonthNumber - 1) / 12);
		const petMonthNumberNormalized = ((petMonthNumber - 1 + 12) % 12) + 1;
		const petYear = String(petYearNumber).padStart(4, "0");
		const petMonth = `${petYear}-${String(petMonthNumberNormalized).padStart(2, "0")}`;
		await db.batch([
			...[
				["Chewy", "Chewy"],
				["Petsmart", "Petsmart"],
				["Banfield Pet Hospital", "Banfield Pet Hospital"],
			].map(([raw, display]) =>
				db
					.prepare(
						"INSERT INTO merchants (raw_name, display_name, not_a_bill) VALUES (?, ?, 1)",
					)
					.bind(raw, display),
			),
		]);
		const petSuggestion = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
			)
			.first<{ id: number }>();
		await db.batch([
			...[
				["CHEWY.COM", "Chewy", 6412, 8],
				["PETSMART 0412", "Petsmart", 2399, 14],
				["BANFIELD PET HOSPITAL", "Banfield Pet Hospital", 18900, 21],
			].map(([raw, merchant, cents, day]) =>
				db
					.prepare(`INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, plaid_category, category_confidence, jev_none_fit, category_suggestion_id, updated_by)
			VALUES (1, ?, ?, ?, ?, 'GENERAL_MERCHANDISE', 0.95, 1, ?, 'demo')`)
					.bind(
						`${petMonth}-${String(day).padStart(2, "0")}`,
						cents,
						raw,
						merchant,
						petSuggestion?.id ?? null,
					),
			),
		]);
	}
	await matchBillPayments(db, today);
}

function demoBills(
	today: string,
	transactions: { date: string; rawName: string; amountCents: number }[],
): (string | number | null)[][] {
	const day = Number(today.slice(8, 10));
	// The soccer payment the yearly bill is linked to, so its amount matches. History is dated the
	// 14th, or today's day-of-month when that is earlier (src/demo/seed.ts).
	const soccerDay = Math.min(14, day);
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
		[
			1,
			"Streaming",
			299,
			paymentDay("APPLE.COM/BILL"),
			"monthly",
			null,
			5,
			seedMerchantKey("APPLE.COM/BILL"),
			1,
		],
		[
			2,
			"Water",
			1399,
			threeDaysBeforePayment("GOOGLE *YOUTUBE"),
			"monthly",
			null,
			5,
			seedMerchantKey("GOOGLE *YOUTUBE"),
			1,
		],
		[
			3,
			"Electric",
			14200,
			day === 1 ? 28 : day - 1,
			"monthly",
			null,
			5,
			ELECTRIC_MERCHANT,
			1,
		],
		// Due the day before its $17.99 charge, which is 16% over $15.49: overdue, with the charge on offer.
		[
			4,
			"Netflix",
			NETFLIX.billCents,
			Number(netflixDue.slice(8)),
			"monthly",
			null,
			5,
			seedMerchantKey(NETFLIX.rawName),
			1,
		],
		[5, "Internet", 6500, dueSoon, "monthly", null, 5, INTERNET_MERCHANT, 1],
		// Yearly, paid three months ago, so its next one is upcoming (decision 62).
		[
			6,
			"Soccer league",
			paidSoccer.cents,
			soccerDay,
			"yearly",
			Number(monthOffset(today, 3).slice(5)),
			4,
			seedMerchantKey("YOUTH SOCCER LEAGUE"),
			1,
		],
		[
			7,
			"Old phone plan",
			4500,
			15,
			"monthly",
			null,
			5,
			seedMerchantKey("GOOGLE *YOUTUBE"),
			0,
		],
		[
			8,
			"Daycare",
			24000,
			5,
			"weekly",
			null,
			6,
			seedMerchantKey("LITTLE SPROUTS DAYCARE"),
			1,
		],
		[
			9,
			"Rent",
			RENT_CENTS,
			1,
			"monthly",
			null,
			RENT_CATEGORY,
			seedMerchantKey(RENT_PAYEE),
			1,
		],
	];
}
