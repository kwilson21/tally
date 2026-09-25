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
		...seed.accounts.map((a) =>
			db
				.prepare(
					"INSERT INTO accounts (id, name, mask, type, subtype, is_liability, balance_cents) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					a.id,
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
	]);
}
