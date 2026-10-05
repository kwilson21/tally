import { merchantKeySql } from "../db/merchant-key";
import { tidyName } from "../transactions/tidy-name";

const EXPORT_COLUMNS = {
	categories: "id, name, icon, color, sort_order, archived",
	budget_amounts: "category_id, effective_month, amount_cents",
	merchants:
		"raw_name, suggested_name, display_name, default_category_id, suggestion_status, not_a_bill",
	// Each account names its bank and says whether it's disconnected, since bank rows carry no id.
	accounts: `id, plaid_item_id, plaid_account_id, name, mask, type, subtype, is_liability, balance_cents, updated_at,
		(SELECT institution_name FROM plaid_items p WHERE p.id = accounts.plaid_item_id) AS bank,
		(SELECT CASE WHEN p.disconnected_at IS NOT NULL THEN 1 ELSE 0 END FROM plaid_items p WHERE p.id = accounts.plaid_item_id) AS bank_disconnected`,
	balance_history: "account_id, date, balance_cents",
	transactions:
		"id, plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, flag_transfer, flag_reimbursement, flag_income, income_source, credit_reviewed, credit_reviewed_by, excluded, parent_id, is_split, refund_of_id, note, updated_by, updated_at, excluded_source, jev_category_id, jev_failed_at, plaid_category, split_removed_from_cents, merchant_name, pending",
	bills:
		"id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active",
	bill_payments:
		"id, bill_id, period, transaction_id, matched_by, status, created_at",
} as const;

/** A dollar value for a spreadsheet, calculated without turning stored money into a float. */
export function exportDollars(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const absolute = Math.abs(cents);
	return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/** RFC 4180 permits bare fields, but commas, quotes and line breaks must be quoted. */
export function csvField(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Prevent spreadsheet programs from interpreting an exported text cell as a formula. */
function csvText(value: string | null): string {
	if (value === null) return "";
	return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

type CsvRow = {
	date: string;
	raw_name: string;
	display_name: string | null;
	amount_cents: number;
	category: string | null;
	excluded: number;
	note: string | null;
	account: string;
};

export async function transactionsCsv(db: D1Database): Promise<string> {
	const { results } = await db
		.prepare(
			`SELECT t.date, t.raw_name, m.display_name, t.amount_cents,
				c.name AS category, t.excluded, t.note, a.name AS account
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
			LEFT JOIN categories c ON c.id = t.category_id
			WHERE t.is_split = 0
			ORDER BY t.date DESC, t.id DESC`,
		)
		.all<CsvRow>();
	const rows: unknown[][] = [
		[
			"date",
			"bank name",
			"merchant",
			"amount (USD; positive = money out)",
			"category",
			"excluded",
			"note",
			"account",
		],
		...results.map((row) => [
			row.date,
			csvText(row.raw_name),
			csvText(row.display_name ?? tidyName(row.raw_name)),
			exportDollars(row.amount_cents),
			csvText(row.category),
			row.excluded === 1,
			csvText(row.note),
			csvText(row.account),
		]),
	];
	return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Build an allowlisted export in one batch, so every table comes from the same moment. Bank logins and document contents are never selected. */
export async function tallyExport(db: D1Database) {
	const tables = Object.entries(EXPORT_COLUMNS);
	const results = await db.batch([
		...tables.map(([table, columns]) =>
			db.prepare(`SELECT ${columns} FROM ${table}`),
		),
		// A disconnected bank keeps its old status column; its exported status says "disconnected".
		db.prepare(
			"SELECT institution_name, CASE WHEN disconnected_at IS NOT NULL THEN 'disconnected' ELSE status END AS status FROM plaid_items ORDER BY id",
		),
		db.prepare("SELECT filename, uploaded_at FROM documents ORDER BY id"),
	]);
	const [plaidItems, documents] = results.slice(tables.length);
	return {
		schema_version: 1,
		exported_at: new Date().toISOString(),
		...Object.fromEntries(
			tables.map(([table], index) => [table, results[index]?.results]),
		),
		plaid_items: plaidItems?.results,
		documents: documents?.results,
	};
}
