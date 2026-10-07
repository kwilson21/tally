import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0035_bill_cadence"),
);
const prefix = "cadence_rebuild_";
const noComments = (query: string) =>
	query
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.trim();
const prefixMigration = (query: string) =>
	query
		.replaceAll(
			/\b(bills|bill_payments|categories|transactions)(?=_new|\b)/g,
			(name) => `${prefix}${name}`,
		)
		.replaceAll(/\bbills_new\b/g, `${prefix}bills_new`)
		.replaceAll(/\bbill_payments_new\b/g, `${prefix}bill_payments_new`)
		.replaceAll(
			/bill_payments_one_per_period/g,
			`${prefix}bill_payments_one_per_period`,
		)
		.replaceAll(
			/bill_payments_one_bill_per_transaction/g,
			`${prefix}bill_payments_one_bill_per_transaction`,
		);

async function cleanup() {
	await db.batch([
		db.prepare(`DROP TRIGGER IF EXISTS ${prefix}bill_payment_category`),
		db.prepare(
			`DROP TRIGGER IF EXISTS ${prefix}bill_payment_category_on_repoint`,
		),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}bill_payments_new`),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}bills_new`),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}bill_payments`),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}bills`),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}transactions`),
		db.prepare(`DROP TABLE IF EXISTS ${prefix}categories`),
	]);
}
afterEach(cleanup);

describe("migration 0035: bill cadence", () => {
	it("preserves every pre-migration bill column, row value, and payment indexes", async () => {
		const oldBills = `CREATE TABLE ${prefix}bills (
			id INTEGER PRIMARY KEY, name TEXT NOT NULL,
			amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
			due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
			frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
			anchor_month INTEGER CHECK (anchor_month BETWEEN 1 AND 12),
			category_id INTEGER REFERENCES ${prefix}categories(id) ON DELETE SET NULL,
			merchant_raw_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
			CHECK (frequency = 'monthly' OR anchor_month IS NOT NULL)
		)`;
		await db.batch([
			db.prepare(
				`CREATE TABLE ${prefix}categories(id INTEGER PRIMARY KEY, category_id INTEGER)`,
			),
			db.prepare(
				`CREATE TABLE ${prefix}transactions(id INTEGER PRIMARY KEY, category_id INTEGER, category_source TEXT, category_confidence REAL, jev_category_id INTEGER, jev_none_fit INTEGER, category_suggestion_id INTEGER)`,
			),
			db.prepare(oldBills),
			db.prepare(
				`ALTER TABLE ${prefix}bills ADD COLUMN merchant_raw_text INTEGER NOT NULL DEFAULT 0 CHECK (merchant_raw_text IN (0, 1))`,
			),
			db.prepare(`UPDATE ${prefix}bills SET merchant_raw_text=1`),
			db.prepare(
				`CREATE TABLE ${prefix}bill_payments(id INTEGER PRIMARY KEY, bill_id INTEGER REFERENCES ${prefix}bills(id), period TEXT, transaction_id INTEGER REFERENCES ${prefix}transactions(id), matched_by TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')))`,
			),
			db.prepare(
				`CREATE UNIQUE INDEX ${prefix}bill_payments_one_per_period ON ${prefix}bill_payments(bill_id,period) WHERE status='linked'`,
			),
			db.prepare(
				`CREATE UNIQUE INDEX ${prefix}bill_payments_one_bill_per_transaction ON ${prefix}bill_payments(transaction_id) WHERE status='linked'`,
			),
			db.prepare(
				`CREATE TRIGGER ${prefix}bill_payment_category AFTER INSERT ON ${prefix}bill_payments BEGIN SELECT 1; END`,
			),
			db.prepare(
				`CREATE TRIGGER ${prefix}bill_payment_category_on_repoint AFTER UPDATE OF transaction_id ON ${prefix}bill_payments BEGIN SELECT 1; END`,
			),
			db.prepare(
				`INSERT INTO ${prefix}bills(id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name,active,merchant_raw_text) VALUES(991,'Migration bill',12345,21,'monthly',NULL,NULL,'MIGRATION MERCHANT',0,1)`,
			),
		]);
		expect(migration).toBeDefined();
		await db.batch(
			(migration?.queries ?? []).map((query) =>
				db.prepare(prefixMigration(noComments(query))),
			),
		);
		const result = await db
			.prepare(`SELECT * FROM ${prefix}bills WHERE id=991`)
			.first<Record<string, unknown>>();
		expect(result).toMatchObject({
			id: 991,
			name: "Migration bill",
			amount_cents: 12345,
			due_day: 21,
			frequency: "monthly",
			anchor_month: null,
			anchor_date: null,
			category_id: null,
			merchant_raw_name: "MIGRATION MERCHANT",
			merchant_raw_text: 1,
			active: 0,
		});
		const columns = await db
			.prepare(`PRAGMA table_info(${prefix}bills)`)
			.all<{ name: string }>();
		expect(columns.results.map((column) => column.name)).toEqual([
			"id",
			"name",
			"amount_cents",
			"due_day",
			"frequency",
			"anchor_month",
			"anchor_date",
			"category_id",
			"merchant_raw_name",
			"merchant_raw_text",
			"active",
		]);
		const indexes = await db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${prefix}bill_payments' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(indexes.results.map((index) => index.name)).toEqual([
			`${prefix}bill_payments_one_bill_per_transaction`,
			`${prefix}bill_payments_one_per_period`,
		]);
	});
});
