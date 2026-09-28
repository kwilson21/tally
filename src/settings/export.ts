import { tidyName } from "../transactions/tidy-name";

const COMPLETE_TABLES = [
	"categories",
	"budget_amounts",
	"merchants",
	"accounts",
	"balance_history",
	"transactions",
	"bills",
	"bill_payments",
] as const;

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

type CsvRow = {
	date: string;
	raw_name: string;
	merchant_name: string | null;
	amount_cents: number;
	category: string | null;
	excluded: number;
	note: string | null;
	account: string;
};

export async function transactionsCsv(db: D1Database): Promise<string> {
	const { results } = await db
		.prepare(
			`SELECT t.date, t.raw_name, m.display_name AS merchant_name, t.amount_cents,
				c.name AS category, t.excluded, t.note, a.name AS account
			FROM transactions t
			JOIN accounts a ON a.id = t.account_id
			LEFT JOIN merchants m ON m.raw_name = t.raw_name
			LEFT JOIN categories c ON c.id = t.category_id
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
			row.raw_name,
			row.merchant_name ?? tidyName(row.raw_name),
			exportDollars(row.amount_cents),
			row.category,
			row.excluded === 1,
			row.note,
			row.account,
		]),
	];
	return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Build an allowlisted export: sensitive bank and document columns are never selected. */
export async function tallyExport(db: D1Database) {
	const tableRows = await Promise.all(
		COMPLETE_TABLES.map(async (table) => [
			table,
			(await db.prepare(`SELECT * FROM ${table}`).all()).results,
		]),
	);
	const [plaidItems, documents] = await Promise.all([
		db
			.prepare(
				"SELECT id, institution_name, status FROM plaid_items ORDER BY id",
			)
			.all(),
		db.prepare("SELECT filename, uploaded_at FROM documents ORDER BY id").all(),
	]);
	return {
		schema_version: 1,
		exported_at: new Date().toISOString(),
		...Object.fromEntries(tableRows),
		plaid_items: plaidItems.results,
		documents: documents.results,
	};
}
