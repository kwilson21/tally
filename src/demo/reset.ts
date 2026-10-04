import { buildSeed } from "./seed";

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
	const b = (v: boolean) => (v ? 1 : 0);

	await db.batch([
		...TABLES_CHILD_FIRST.map((t) => db.prepare(`DELETE FROM ${t}`)),
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
				.bind(m.rawName, m.displayName, m.defaultCategoryId),
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
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, category_confidence,
					 jev_category_id, flag_transfer, flag_reimbursement, flag_income, excluded, is_split, updated_by)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
				)
				.bind(
					t.accountId,
					t.date,
					t.amountCents,
					t.rawName,
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
				),
		),
		...demoBills(today).map((bill) =>
			db
				.prepare(
					"INSERT INTO bills (id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name,active) VALUES (?,?,?,?,?,?,?,?,?)",
				)
				.bind(...bill),
		),
		db
			.prepare(`INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status)
			SELECT 1, ?, id, 'user', 'linked' FROM transactions WHERE raw_name='APPLE.COM/BILL' AND date LIKE ? ORDER BY id DESC LIMIT 1`)
			.bind(today.slice(0, 7), `${today.slice(0, 7)}%`),
		db
			.prepare(`INSERT INTO bill_payments (bill_id,period,transaction_id,matched_by,status)
			SELECT 2, ?, id, 'user', 'linked' FROM transactions WHERE raw_name='GOOGLE *YOUTUBE' AND date LIKE ? ORDER BY id DESC LIMIT 1`)
			.bind(today.slice(0, 7), `${today.slice(0, 7)}%`),
	]);
}

function demoBills(today: string): (string | number | null)[][] {
	const day = Number(today.slice(8, 10));
	const month = Number(today.slice(5, 7));
	const dueSoon = Math.min(31, day + 3);
	return [
		[1, "Streaming", 299, day, "monthly", null, 5, "APPLE.COM/BILL", 1],
		[
			2,
			"Water",
			1399,
			Math.max(1, day - 3),
			"monthly",
			null,
			5,
			"GOOGLE *YOUTUBE",
			1,
		],
		[
			3,
			"Electric",
			14200,
			Math.max(1, day - 1),
			"monthly",
			null,
			5,
			"THE HOME DEPOT #6612",
			1,
		],
		[
			4,
			"Rent",
			185000,
			day,
			"monthly",
			null,
			5,
			"ONLINE TRANSFER TO SAV ...5678",
			1,
		],
		[5, "Internet", 6500, dueSoon, "monthly", null, 5, "AMAZON.COM*RT4K2", 1],
		[
			6,
			"Car insurance",
			11840,
			15,
			"yearly",
			month === 12 ? 12 : month + 1,
			3,
			"CHEVRON 0098812",
			1,
		],
		[7, "Old phone plan", 4500, 15, "monthly", null, 5, "GOOGLE *YOUTUBE", 0],
	];
}
