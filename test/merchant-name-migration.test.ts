import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const db = env.DB;

// The tests' database already has every migration, so migration 0017 runs here against scratch copies of
// `transactions`, `bill_payments` and `bills` as they were after 0016 (built from the real
// migration files, so no column is missed), filled with rows. Every table and index name the migration
// touches gets this prefix.
const P = "pre0017_";
const scratch = (sql: string) =>
	sql.replaceAll(/\b(transactions|bill_payments|bills)(_\w+)?\b/g, `${P}$1$2`);

/** A migration with a single statement keeps its leading comment lines; the others have none. */
const withoutComments = (query: string) =>
	query
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.trim();

const REBUILT_BY_0017 =
	/^(CREATE TABLE (transactions|bill_payments|bills)\b|ALTER TABLE (transactions|bills)\b|CREATE (UNIQUE )?INDEX \w+ ON (transactions|bill_payments)\b)/;
const upTo0016 = env.TEST_MIGRATIONS.filter((m) => m.name < "0017")
	.flatMap((m) => m.queries)
	.map(withoutComments)
	.filter((query) => REBUILT_BY_0017.test(query));
const migration0017 = env.TEST_MIGRATIONS.find((m) =>
	m.name.startsWith("0017_merchant_name_pending"),
);

const TX = `${P}transactions`;
const BP = `${P}bill_payments`;
const BILLS = `${P}bills`;

async function dropScratch() {
	await db.batch([
		db.prepare(`DROP TABLE IF EXISTS ${P}bill_payments_keep`),
		db.prepare(`DROP TABLE IF EXISTS ${BP}`),
		db.prepare(`DROP TABLE IF EXISTS ${BILLS}`),
		db.prepare(`DROP TABLE IF EXISTS ${P}transactions_new`),
		db.prepare(`DROP TABLE IF EXISTS ${TX}`),
		db.prepare("DELETE FROM categories WHERE id IN (9001, 9002)"),
		db.prepare("DELETE FROM accounts WHERE id = 9001"),
	]);
}

type Row = Record<string, unknown>;
const rows = async (sql: string) =>
	((await db.prepare(sql).all<Row>()).results ?? []) as Row[];

/** Every column filled with something other than its default, so a dropped or reordered column shows. */
async function seedBeforeMigration() {
	await db.batch([
		db.prepare(
			"INSERT INTO accounts (id, name, type) VALUES (9001, 'Pre0017 Checking', 'depository')",
		),
		db.prepare(
			"INSERT INTO categories (id, name, icon, color) VALUES (9001, 'Pre0017 Groceries', 'groceries', 'cat-blue'), (9002, 'Pre0017 Gas', 'gas', 'cat-slate')",
		),
	]);
	await db.batch(upTo0016.map((query) => db.prepare(scratch(query))));
	await db.batch([
		db.prepare(
			`INSERT INTO ${BILLS} (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9001, 'Pre0017 Internet', 8000, 5, 'monthly', 'COMCAST'), (9002, 'Pre0017 Water', 3000, 12, 'monthly', 'CITY WATER')`,
		),
	]);
	const tx = (row: Record<string, string | number | null>) => {
		const values = {
			account_id: 9001,
			date: "2026-09-01",
			amount_cents: 100,
			raw_name: "PLAIN",
			updated_at: "2026-09-01 00:00:00",
			...row,
		};
		const names = Object.keys(values);
		return db
			.prepare(
				`INSERT INTO ${TX} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
			)
			.bind(...Object.values(values));
	};
	await db.batch([
		// A transaction with every column filled in.
		tx({
			id: 9101,
			plaid_transaction_id: "plaid-1",
			date: "2026-09-01",
			amount_cents: 4321,
			raw_name: "TARGET 1234",
			category_id: 9001,
			category_source: "jev",
			category_confidence: 0.91,
			flag_transfer: 1,
			flag_reimbursement: 1,
			flag_income: 1,
			excluded: 1,
			parent_id: null,
			is_split: 0,
			note: "a note",
			updated_by: "me@example.com",
			updated_at: "2026-09-02 03:04:05",
			jev_category_id: 9002,
			jev_failed_at: "2026-09-01 10:00:00",
			excluded_source: "jev",
			plaid_category: "GENERAL_MERCHANDISE",
			split_removed_from_cents: 7777,
			income_source: "jev",
			credit_reviewed: 0,
			credit_reviewed_by: "user",
		}),
		// A split purchase and its two parts; one part has a bill payment, another a refund (below).
		tx({
			id: 9102,
			plaid_transaction_id: "plaid-2",
			date: "2026-09-03",
			amount_cents: 10000,
			raw_name: "COSTCO WHSE #0431",
			is_split: 1,
		}),
		tx({
			id: 9103,
			date: "2026-09-03",
			amount_cents: 6000,
			raw_name: "COSTCO WHSE #0431",
			category_id: 9001,
			category_source: "user",
			parent_id: 9102,
		}),
		tx({
			id: 9104,
			date: "2026-09-03",
			amount_cents: 4000,
			raw_name: "COSTCO WHSE #0431",
			category_id: 9002,
			category_source: "user",
			parent_id: 9102,
		}),
		// A purchase, and refunds of it and of a split part.
		tx({
			id: 9105,
			plaid_transaction_id: "plaid-3",
			date: "2026-09-05",
			amount_cents: 5000,
			raw_name: "AMZN MKTP US",
			category_id: 9001,
			category_source: "user",
		}),
		tx({
			id: 9106,
			plaid_transaction_id: "plaid-4",
			date: "2026-09-09",
			amount_cents: -2000,
			raw_name: "AMZN MKTP US",
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		}),
		tx({
			id: 9107,
			plaid_transaction_id: "plaid-5",
			date: "2026-09-10",
			amount_cents: -1500,
			raw_name: "COSTCO WHSE #0431",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		}),
		// Three payments to one bill: two linked, one a person removed.
		tx({
			id: 9108,
			plaid_transaction_id: "plaid-6",
			date: "2026-09-05",
			amount_cents: 8000,
			raw_name: "COMCAST",
			category_id: 9001,
			category_source: "merchant_rule",
		}),
		tx({
			id: 9109,
			plaid_transaction_id: "plaid-7",
			date: "2026-10-06",
			amount_cents: 8000,
			raw_name: "COMCAST",
		}),
		tx({
			id: 9110,
			plaid_transaction_id: "plaid-8",
			date: "2026-09-20",
			amount_cents: 8000,
			raw_name: "COMCAST",
		}),
		// A refund with a lower id than its purchase, so the copy meets the link before its target.
		tx({
			id: 9100,
			plaid_transaction_id: "plaid-9",
			date: "2026-09-12",
			amount_cents: -999,
			raw_name: "TARGET 1234",
		}),
		tx({
			id: 9111,
			plaid_transaction_id: "plaid-10",
			date: "2026-09-11",
			amount_cents: 999,
			raw_name: "TARGET 1234",
		}),
		// A transaction with every optional column empty, like one a person types in.
		tx({ id: 9112, date: "2026-09-13", amount_cents: 1, raw_name: "CASH" }),
	]);
	await db.batch([
		db.prepare(`UPDATE ${TX} SET refund_of_id = 9105 WHERE id = 9106`),
		db.prepare(`UPDATE ${TX} SET refund_of_id = 9103 WHERE id = 9107`),
		db.prepare(`UPDATE ${TX} SET refund_of_id = 9111 WHERE id = 9100`),
		db.prepare(
			`INSERT INTO ${BP} (id, bill_id, period, transaction_id, matched_by, status, created_at) VALUES
				(9201, 9001, '2026-09', 9108, 'auto', 'linked', '2026-09-06 00:00:00'),
				(9202, 9001, '2026-10', 9109, 'user', 'linked', '2026-10-07 00:00:00'),
				(9203, 9001, '2026-09', 9110, 'user', 'dismissed', '2026-09-21 00:00:00'),
				(9204, 9001, '2026-11', 9104, 'user', 'linked', '2026-11-01 00:00:00')`,
		),
	]);
}

const runMigration = async () => {
	expect(migration0017).toBeDefined();
	// One batch, as `wrangler d1 migrations apply` and applyD1Migrations run it: all or nothing.
	await db.batch(
		(migration0017?.queries ?? []).map((query) =>
			db.prepare(scratch(withoutComments(query))),
		),
	);
};

const snapshot = async () => ({
	transactions: await rows(`SELECT * FROM ${TX} ORDER BY id`),
	billPayments: await rows(`SELECT * FROM ${BP} ORDER BY id`),
});

const columns = async (table: string) =>
	await rows(
		`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`,
	);
const foreignKeys = async (table: string) =>
	await rows(
		`SELECT "from", "table", "to", on_update, on_delete FROM pragma_foreign_key_list('${table}') ORDER BY "from"`,
	);
const indexes = async (table: string) => {
	const list = await rows(
		`SELECT name, "unique", origin, partial FROM pragma_index_list('${table}') ORDER BY name`,
	);
	const out: Row[] = [];
	for (const index of list) {
		const cols = await rows(
			`SELECT name FROM pragma_index_info('${index.name}') ORDER BY seqno`,
		);
		out.push({ ...index, columns: cols.map((c) => c.name) });
	}
	return out;
};

describe("migration 0017: merchant_name, pending and the 'plaid' exclusion source", () => {
	beforeEach(async () => {
		await dropScratch();
		await seedBeforeMigration();
	});
	afterEach(dropScratch);

	it("keeps every transaction and bill payment exactly as it was, with the two new columns empty", async () => {
		const before = await snapshot();
		expect(before.transactions).toHaveLength(13);
		expect(before.billPayments).toHaveLength(4);

		await runMigration();

		const after = await snapshot();
		expect(after.transactions).toEqual(
			before.transactions.map((row) => ({
				...row,
				merchant_name: null,
				pending: 0,
			})),
		);
		expect(after.billPayments).toEqual(before.billPayments);
	});

	it("keeps parts, refund links and bill payments pointing at the same transactions", async () => {
		await runMigration();

		expect(
			await rows(
				`SELECT id, parent_id FROM ${TX} WHERE parent_id IS NOT NULL ORDER BY id`,
			),
		).toEqual([
			{ id: 9103, parent_id: 9102 },
			{ id: 9104, parent_id: 9102 },
		]);
		expect(
			await rows(
				`SELECT id, refund_of_id FROM ${TX} WHERE refund_of_id IS NOT NULL ORDER BY id`,
			),
		).toEqual([
			{ id: 9100, refund_of_id: 9111 },
			{ id: 9106, refund_of_id: 9105 },
			{ id: 9107, refund_of_id: 9103 },
		]);
		expect(
			await rows(
				`SELECT bp.id, bp.bill_id, bp.period, bp.status, t.raw_name FROM ${BP} bp JOIN ${TX} t ON t.id = bp.transaction_id ORDER BY bp.id`,
			),
		).toEqual([
			{
				id: 9201,
				bill_id: 9001,
				period: "2026-09",
				status: "linked",
				raw_name: "COMCAST",
			},
			{
				id: 9202,
				bill_id: 9001,
				period: "2026-10",
				status: "linked",
				raw_name: "COMCAST",
			},
			{
				id: 9203,
				bill_id: 9001,
				period: "2026-09",
				status: "dismissed",
				raw_name: "COMCAST",
			},
			{
				id: 9204,
				bill_id: 9001,
				period: "2026-11",
				status: "linked",
				raw_name: "COSTCO WHSE #0431",
			},
		]);
		expect(await rows(`PRAGMA foreign_key_check(${TX})`)).toEqual([]);
		expect(await rows(`PRAGMA foreign_key_check(${BP})`)).toEqual([]);
	});

	it("leaves no helper table behind and keeps the table names", async () => {
		await runMigration();

		const names = (
			await rows(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '${P}%' ORDER BY name`,
			)
		).map((r) => r.name);
		expect(names).toEqual([BP, BILLS, TX]);
	});

	it("adds the two columns and changes nothing else about the columns", async () => {
		const before = await columns(TX);
		await runMigration();
		const after = await columns(TX);

		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.slice(before.length)).toEqual([
			{
				name: "merchant_name",
				type: "TEXT",
				notnull: 0,
				dflt_value: null,
				pk: 0,
			},
			{ name: "pending", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
		]);
	});

	it("marks every bill saved before it as saved under the bank's raw text, and nothing else changes", async () => {
		const billsBefore = await rows(`SELECT * FROM ${BILLS} ORDER BY id`);
		expect(billsBefore).toHaveLength(2);
		expect(billsBefore[0]).not.toHaveProperty("merchant_raw_text");

		await runMigration();

		expect(await rows(`SELECT * FROM ${BILLS} ORDER BY id`)).toEqual(
			billsBefore.map((row) => ({ ...row, merchant_raw_text: 1 })),
		);
		expect(
			await rows(
				`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${BILLS}') WHERE name = 'merchant_raw_text'`,
			),
		).toEqual([
			{
				name: "merchant_raw_text",
				type: "INTEGER",
				notnull: 1,
				dflt_value: "0",
			},
		]);

		// A bill saved after the migration holds a key, not bank text.
		await db
			.prepare(
				`INSERT INTO ${BILLS} (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9003, 'Target', 100, 1, 'monthly', 'Target')`,
			)
			.run();
		expect(
			await rows(`SELECT merchant_raw_text FROM ${BILLS} WHERE id = 9003`),
		).toEqual([{ merchant_raw_text: 0 }]);
		await expect(
			db.prepare(`UPDATE ${BILLS} SET merchant_raw_text = 2`).run(),
		).rejects.toThrow();
	});

	it("leaves the merchants table alone: unique on raw_name, which holds a key", async () => {
		await runMigration();

		expect(
			await rows(
				"SELECT name, pk FROM pragma_table_info('merchants') WHERE pk > 0 ORDER BY pk",
			),
		).toEqual([{ name: "raw_name", pk: 1 }]);
		expect(
			(await rows("SELECT name FROM pragma_table_info('merchants')")).map(
				(r) => r.name,
			),
		).not.toContain("raw_text");
	});

	it("keeps every index, unique constraint and foreign key, still pointing at the renamed table", async () => {
		const indexesBefore = await indexes(TX);
		const billIndexesBefore = await indexes(BP);
		const foreignKeysBefore = await foreignKeys(TX);
		const billKeysBefore = await foreignKeys(BP);
		expect(indexesBefore.length).toBeGreaterThanOrEqual(6);

		await runMigration();

		const strip = (list: Row[]) =>
			list.map(({ name, ...rest }) => ({
				...rest,
				name: String(name).replace(/^sqlite_autoindex_.*$/, "sqlite_autoindex"),
			}));
		expect(strip(await indexes(TX))).toEqual(strip(indexesBefore));
		expect(strip(await indexes(BP))).toEqual(strip(billIndexesBefore));
		expect(await foreignKeys(TX)).toEqual(foreignKeysBefore);
		expect(await foreignKeys(BP)).toEqual(billKeysBefore);
		expect(await foreignKeys(TX)).toContainEqual({
			from: "parent_id",
			table: TX,
			to: "id",
			on_update: "NO ACTION",
			on_delete: "CASCADE",
		});
		expect(await foreignKeys(BP)).toContainEqual({
			from: "transaction_id",
			table: TX,
			to: "id",
			on_update: "NO ACTION",
			on_delete: "CASCADE",
		});
	});

	it("keeps deleting a split purchase removing its parts and their payments, and a purchase unlinking its refunds", async () => {
		await runMigration();

		await db.prepare(`DELETE FROM ${TX} WHERE id = 9102`).run();
		expect(
			await rows(`SELECT id FROM ${TX} WHERE id IN (9102, 9103, 9104)`),
		).toEqual([]);
		expect(await rows(`SELECT id FROM ${BP} WHERE id = 9204`)).toEqual([]);
		// The refund of a removed part is unlinked, not removed.
		expect(
			await rows(`SELECT id, refund_of_id FROM ${TX} WHERE id = 9107`),
		).toEqual([{ id: 9107, refund_of_id: null }]);

		await db.prepare(`DELETE FROM ${TX} WHERE id = 9108`).run();
		expect(await rows(`SELECT id FROM ${BP} WHERE id = 9201`)).toEqual([]);
		expect(await rows(`SELECT id FROM ${BP} WHERE id = 9202`)).toHaveLength(1);
	});

	it("keeps the rules that a bill gets one payment per period and a payment pays one bill", async () => {
		await runMigration();

		await expect(
			db
				.prepare(
					`INSERT INTO ${BP} (bill_id, period, transaction_id, matched_by, status) VALUES (9001, '2026-09', 9112, 'user', 'linked')`,
				)
				.run(),
		).rejects.toThrow();
		await db.prepare(`DELETE FROM ${BP} WHERE id = 9201`).run();
		await expect(
			db
				.prepare(
					`INSERT INTO ${BP} (bill_id, period, transaction_id, matched_by, status) VALUES (9001, '2026-12', 9109, 'user', 'linked')`,
				)
				.run(),
		).rejects.toThrow();
		await db
			.prepare(
				`INSERT INTO ${BP} (bill_id, period, transaction_id, matched_by, status) VALUES (9001, '2026-09', 9112, 'user', 'linked')`,
			)
			.run();
	});

	it("rejects exactly what it rejected before, and now accepts 'plaid' as the exclusion source", async () => {
		const probes: [string, string, string | number | null][] = [
			["date", "date", "2026-9-1"],
			["amount", "amount_cents", 1.5],
			["amount null", "amount_cents", null],
			["raw name null", "raw_name", null],
			["account null", "account_id", null],
			["category source", "category_source", "bill"],
			["transfer flag", "flag_transfer", 2],
			["reimbursement flag", "flag_reimbursement", 2],
			["income flag", "flag_income", 2],
			["excluded", "excluded", 2],
			["is split", "is_split", 2],
			["income source", "income_source", "plaid"],
			["credit reviewed", "credit_reviewed", 2],
			["credit reviewed by", "credit_reviewed_by", "jev"],
			["excluded source", "excluded_source", "bogus"],
			["parent that doesn't exist", "parent_id", 424242],
			["refund of that doesn't exist", "refund_of_id", 424242],
			["category that doesn't exist", "category_id", 424242],
			["duplicate Plaid id", "plaid_transaction_id", "plaid-1"],
			["updated at null", "updated_at", null],
			["jev pick that doesn't exist", "jev_category_id", 424242],
		];
		const outcome = async (table: string, column: string, value: unknown) => {
			const row: Record<string, unknown> = {
				account_id: 9001,
				date: "2026-09-30",
				amount_cents: 100,
				raw_name: "PROBE",
				[column]: value,
			};
			const names = Object.keys(row);
			try {
				await db
					.prepare(
						`INSERT INTO ${table} (id, ${names.join(", ")}) VALUES (9999, ${names.map(() => "?").join(", ")})`,
					)
					.bind(...Object.values(row))
					.run();
				await db.prepare(`DELETE FROM ${table} WHERE id = 9999`).run();
				return "accepted";
			} catch {
				return "rejected";
			}
		};
		const run = async (table: string) => {
			const out: Record<string, string> = {};
			for (const [label, column, value] of probes)
				out[label] = await outcome(table, column, value);
			out["excluded source plaid"] = await outcome(
				table,
				"excluded_source",
				"plaid",
			);
			return out;
		};

		const before = await run(TX);
		await runMigration();
		const after = await run(TX);

		expect(before["excluded source plaid"]).toBe("rejected");
		expect(after["excluded source plaid"]).toBe("accepted");
		expect({ ...after, "excluded source plaid": "rejected" }).toEqual(before);
		// Every probe above must have been a rejection, or it tests nothing.
		expect(Object.values(before).filter((v) => v === "accepted")).toEqual([]);

		await expect(outcome(TX, "pending", 2)).resolves.toBe("rejected");
		await expect(outcome(TX, "pending", null)).resolves.toBe("rejected");
		await expect(outcome(TX, "pending", 1)).resolves.toBe("accepted");
		await expect(outcome(TX, "merchant_name", "Target")).resolves.toBe(
			"accepted",
		);
	});
});

describe("the real bills table, after every migration", () => {
	it("says with a flag whether a bill was saved under the bank's raw text, which new bills are not", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, merchant_raw_name) VALUES (9401, 'Zz Real Bill', 100, 1, 'monthly', 'Zz Real Merchant')",
			),
		]);
		try {
			expect(
				await rows("SELECT merchant_raw_text FROM bills WHERE id = 9401"),
			).toEqual([{ merchant_raw_text: 0 }]);
			await expect(
				db
					.prepare("UPDATE bills SET merchant_raw_text = 2 WHERE id = 9401")
					.run(),
			).rejects.toThrow();
		} finally {
			await db.prepare("DELETE FROM bills WHERE id = 9401").run();
		}
	});
});

describe("the real transactions table, after every migration", () => {
	it("stores a merchant name and a pending flag, and takes 'plaid' as an exclusion source", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO accounts (id, name, type) VALUES (9001, 'Real check', 'depository')",
			),
		]);
		try {
			await db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, merchant_name, pending, excluded_source) VALUES (9301, 9001, '2026-09-30', 100, 'TARGET 1234', 'Target', 1, 'plaid')",
				)
				.run();
			await db
				.prepare(
					"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (9302, 9001, '2026-09-30', 100, 'CASH')",
				)
				.run();
			expect(
				await rows(
					"SELECT id, merchant_name, pending, excluded_source FROM transactions WHERE id IN (9301, 9302) ORDER BY id",
				),
			).toEqual([
				{
					id: 9301,
					merchant_name: "Target",
					pending: 1,
					excluded_source: "plaid",
				},
				{ id: 9302, merchant_name: null, pending: 0, excluded_source: null },
			]);
			await expect(
				db
					.prepare(
						"UPDATE transactions SET excluded_source = 'bogus' WHERE id = 9301",
					)
					.run(),
			).rejects.toThrow();
			await expect(
				db.prepare("UPDATE transactions SET pending = 2 WHERE id = 9301").run(),
			).rejects.toThrow();
		} finally {
			await db.batch([
				db.prepare("DELETE FROM transactions WHERE id IN (9301, 9302)"),
				db.prepare("DELETE FROM accounts WHERE id = 9001"),
			]);
		}
	});
});
