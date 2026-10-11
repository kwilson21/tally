import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0035_bill_cadence"),
);

// The tests' database already has every migration, so 0035 runs here against scratch copies named with
// this prefix. The bill tables are built by replaying the real statements from the migrations before 0035
// (their CREATE, DROP, copy and index statements, with the real ON DELETE CASCADE), so the cascades are the
// real ones. `transactions` is not rebuilt by 0035, so a small table with the columns the payment triggers
// write stands in for it.
const P = "cr_";
const scratch = (sql: string) =>
	sql
		.replaceAll(/\b(bills|bill_payments|transactions)(_\w+)?\b/g, `${P}$1$2`)
		.replaceAll(
			/\bbill_payment_category(_on_repoint)?\b/g,
			`${P}bill_payment_category$1`,
		);

/** A statement with its leading comment lines removed. */
const withoutComments = (query: string) =>
	query
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.trim();

const BILL_SCHEMA =
	/^(CREATE TABLE (bills|bill_payments|bill_payments_keep)\b|DROP TABLE bill_payments(_keep)?\b|INSERT INTO bill_payments\b|CREATE (UNIQUE )?INDEX bill_payments_|CREATE TRIGGER bill_payment_category(_on_repoint)?\b|ALTER TABLE bills\b|UPDATE bills\b)/;
const before0035 = env.TEST_MIGRATIONS.filter((item) => item.name < "0035")
	.flatMap((item) => item.queries)
	.map(withoutComments)
	.filter((query) => BILL_SCHEMA.test(query))
	.map(scratch);
const migrationStatements = (migration?.queries ?? [])
	.map(withoutComments)
	.map(scratch);

const preSchema = [
	`CREATE TABLE ${P}transactions (id INTEGER PRIMARY KEY, category_id INTEGER, category_source TEXT, category_confidence REAL, jev_category_id INTEGER, jev_none_fit INTEGER, category_suggestion_id INTEGER)`,
	...before0035,
];

async function cleanup() {
	await db.batch([
		db.prepare(`DROP TRIGGER IF EXISTS ${P}bill_payment_category`),
		db.prepare(`DROP TRIGGER IF EXISTS ${P}bill_payment_category_on_repoint`),
		db.prepare(`DROP TABLE IF EXISTS ${P}bill_payments`),
		db.prepare(`DROP TABLE IF EXISTS ${P}bill_payments_keep`),
		db.prepare(`DROP TABLE IF EXISTS ${P}bill_payments_new`),
		db.prepare(`DROP TABLE IF EXISTS ${P}bills`),
		db.prepare(`DROP TABLE IF EXISTS ${P}bills_new`),
		db.prepare(`DROP TABLE IF EXISTS ${P}transactions`),
	]);
}
afterEach(cleanup);

type Row = Record<string, unknown>;
const rows = async (sql: string) =>
	((await db.prepare(sql).all<Row>()).results ?? []) as Row[];

async function seedBeforeMigration() {
	await db.batch(preSchema.map((sql) => db.prepare(sql)));
	await db.batch([
		db.prepare(
			`INSERT INTO ${P}transactions (id) VALUES (9101), (9102), (9103), (9104), (9105), (9106)`,
		),
		db.prepare(
			`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, merchant_raw_text, active) VALUES
				(9001, 'Pre-cadence rent', 120000, 1, 'monthly', NULL, NULL, 'LANDLORD', 0, 1),
				(9002, 'Pre-cadence insurance', 40000, 15, 'yearly', 3, NULL, 'STATE FARM', 1, 0)`,
		),
		db.prepare(
			`INSERT INTO ${P}bill_payments (id, bill_id, period, transaction_id, matched_by, status, created_at) VALUES
				(9201, 9001, '2026-10', 9101, 'auto', 'linked', '2026-10-02 00:00:00'),
				(9202, 9002, '2026', 9102, 'user', 'linked', '2026-03-15 00:00:00'),
				(9203, 9001, '2026-09', 9103, 'user', 'dismissed', '2026-09-03 00:00:00')`,
		),
	]);
}

async function snapshot() {
	return {
		bills: await rows(`SELECT * FROM ${P}bills ORDER BY id`),
		payments: await rows(`SELECT * FROM ${P}bill_payments ORDER BY id`),
	};
}

describe("migration 0035: bill cadence", () => {
	it("keeps every bill, payment and link through the rebuild", async () => {
		expect(migration).toBeDefined();
		await seedBeforeMigration();
		const before = await snapshot();
		expect(before.payments).toHaveLength(3);

		await db.batch(migrationStatements.map((sql) => db.prepare(sql)));

		const after = await snapshot();
		expect(after.payments).toEqual(before.payments);
		expect(after.bills).toEqual(
			before.bills.map((bill) => ({ ...bill, anchor_date: null })),
		);
	});

	it("leaves no temporary table behind and rebuilds each index and trigger on bill_payments", async () => {
		await seedBeforeMigration();
		await db.batch(migrationStatements.map((sql) => db.prepare(sql)));

		expect(
			(
				await rows(
					`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${P}%' ORDER BY name`,
				)
			).map((row) => row.name),
		).toEqual([`${P}bill_payments`, `${P}bills`, `${P}transactions`]);

		expect(
			(
				await rows(
					`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${P}bill_payments' ORDER BY name`,
				)
			).map((row) => row.name),
		).toEqual([
			`${P}bill_payments_one_bill_per_transaction`,
			`${P}bill_payments_one_per_period`,
		]);
		expect(
			await rows(
				`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE '${P}%' ORDER BY name`,
			),
		).toEqual([
			{ name: `${P}bill_payment_category`, tbl_name: `${P}bill_payments` },
			{
				name: `${P}bill_payment_category_on_repoint`,
				tbl_name: `${P}bill_payments`,
			},
		]);
		expect(
			await rows(
				`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${P}bills'`,
			),
		).toEqual([]);
	});

	it("keeps the cascades: payments point at their bill and transaction, and go with them", async () => {
		await seedBeforeMigration();
		await db.batch(migrationStatements.map((sql) => db.prepare(sql)));

		expect(
			await rows(
				`SELECT "from", "table", "to", on_delete FROM pragma_foreign_key_list('${P}bill_payments') ORDER BY "from"`,
			),
		).toEqual([
			{ from: "bill_id", table: `${P}bills`, to: "id", on_delete: "CASCADE" },
			{
				from: "transaction_id",
				table: `${P}transactions`,
				to: "id",
				on_delete: "CASCADE",
			},
		]);
		await expect(
			db
				.prepare(
					`INSERT INTO ${P}bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (99999, '2026-10', 9104, 'auto', 'linked')`,
				)
				.run(),
		).rejects.toThrow();

		await db.prepare(`DELETE FROM ${P}bills WHERE id = 9002`).run();
		expect(
			(
				await rows(
					`SELECT id FROM ${P}bill_payments WHERE bill_id IN (9001, 9002) ORDER BY id`,
				)
			).map((row) => row.id),
		).toEqual([9201, 9203]);
	});

	it("accepts the new cadences and their periods", async () => {
		await seedBeforeMigration();
		await db.batch(migrationStatements.map((sql) => db.prepare(sql)));

		await db.batch([
			db.prepare(
				`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9003, 'Daycare', 24000, 5, 'weekly', 'LITTLE SPROUTS')`,
			),
			db.prepare(
				`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, anchor_date, merchant_raw_name) VALUES (9004, 'Biweekly', 100, 5, 'biweekly', '2026-10-02', 'BIWEEKLY')`,
			),
			db.prepare(
				`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, anchor_month, merchant_raw_name) VALUES (9005, 'Quarterly', 100, 15, 'quarterly', 11, 'QUARTERLY')`,
			),
			db.prepare(
				`INSERT INTO ${P}bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9003, '2026-10-16', 9104, 'auto', 'linked'), (9005, '2026-Q4', 9105, 'auto', 'linked')`,
			),
		]);
		await expect(
			db
				.prepare(
					`INSERT INTO ${P}bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9005, '2026-Q5', 9106, 'auto', 'linked')`,
				)
				.run(),
		).rejects.toThrow();
		await expect(
			db
				.prepare(
					`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9006, 'No anchor', 100, 5, 'biweekly', 'NO ANCHOR')`,
				)
				.run(),
		).rejects.toThrow();
		await expect(
			db
				.prepare(
					`INSERT INTO ${P}bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9007, 'No month', 100, 15, 'quarterly', 'NO MONTH')`,
				)
				.run(),
		).rejects.toThrow();
	});
});
