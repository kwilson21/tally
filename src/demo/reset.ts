import { matchBillPayments } from "../bills/match";
import { DEFAULT_TIME_ZONE } from "../dates";
import { buildSeed, monthOffset, seedMerchantKey } from "./seed";

// Deletes in child-to-parent order, then inserts the seed, all in one atomic batch.
const TABLES_CHILD_FIRST = [
	"bill_payments",
	"documents",
	"balance_history",
	"transactions",
	"bills",
	"budget_amounts",
	"merchants",
	"categories",
	"accounts",
	"plaid_items",
	"household_settings",
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

/** Wipes the database and reloads the Rivera household. Only ever called when canResetDemo(env) is true. */
export async function resetDemo(db: D1Database, today: string): Promise<void> {
	const seed = buildSeed(today);
	const todayDay = Number(today.slice(8, 10));
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
		// The demo's time zone goes back to the default, like everything else a visitor can change.
		db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('time_zone', ?)",
			)
			.bind(DEFAULT_TIME_ZONE),
		...seed.categories.map((c) =>
			db
				.prepare(
					"INSERT INTO categories (id, name, icon, color, sort_order) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(c.id, c.name, c.icon, c.color, c.sortOrder),
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
		...seed.merchants.map((m) =>
			db
				.prepare(
					"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES (?, ?, ?)",
				)
				.bind(m.key, m.displayName, m.defaultCategoryId),
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
		...demoBills(today, seed.transactions).map((bill) =>
			db
				.prepare(
					"INSERT INTO bills (id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name,active) VALUES (?,?,?,?,?,?,?,?,?)",
				)
				.bind(...bill),
		),
	]);
	await matchBillPayments(db, today);
}

function demoBills(
	today: string,
	transactions: { date: string; rawName: string; amountCents: number }[],
): (string | number | null)[][] {
	const day = Number(today.slice(8, 10));
	// The soccer payment the yearly bill is linked to, so its amount matches.
	const paidSoccer = {
		cents:
			transactions.find(
				(t) =>
					t.rawName === "YOUTH SOCCER LEAGUE" &&
					t.date === `${monthOffset(today, 3)}-14`,
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
			seedMerchantKey("THE HOME DEPOT #6612"),
			1,
		],
		[
			5,
			"Internet",
			6500,
			dueSoon,
			"monthly",
			null,
			5,
			seedMerchantKey("AMAZON.COM*RT4K2"),
			1,
		],
		// Yearly, paid three months ago, so its next one is upcoming (decision 62).
		[
			6,
			"Soccer league",
			paidSoccer.cents,
			14,
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
	];
}
