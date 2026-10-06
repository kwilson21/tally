import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0026_bill_category.sql?raw";
import { resetDemo } from "../src/demo/reset";

beforeEach(async () => resetDemo(env.DB, "2026-09-22"));

describe("migration 0026: bill categories", () => {
	it("copies transaction and payment rows before rebuilding their foreign keys", () => {
		expect(migration.indexOf("CREATE TABLE bill_payments_keep")).toBeLessThan(
			migration.indexOf("DROP TABLE transactions"),
		);
		expect(migration).toContain("FROM transactions;");
		expect(migration).toContain("FROM bill_payments_keep;");
	});

	it("allows bill as a category source and keeps existing rows readable", async () => {
		const schema = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'",
		).first<{ sql: string }>();
		expect(schema?.sql).toContain("'bill'");
		await expect(
			env.DB.prepare(
				"SELECT id,category_id,category_source FROM transactions ORDER BY id LIMIT 1",
			).first(),
		).resolves.toBeDefined();
		expect(
			(await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
	});

	it("copies transactions, self references, and bill links through the rebuild", async () => {
		const table = migration.match(
			/CREATE TABLE transactions_new \([\s\S]*?\n\);/,
		)?.[0];
		const transactionCopy = migration.match(
			/INSERT INTO transactions_new \([\s\S]*?FROM transactions;/,
		)?.[0];
		const paymentCopy = migration.match(
			/INSERT INTO bill_payments \(id, bill_id, period, transaction_id, matched_by, status, created_at\)[\s\S]*?FROM bill_payments_keep;/,
		)?.[0];
		expect(table).toBeDefined();
		expect(transactionCopy).toBeDefined();
		expect(paymentCopy).toBeDefined();

		const sourceName = "bill_category_migration_source";
		const targetName = "bill_category_migration_target";
		const sourcePayments = "bill_category_migration_source_payments";
		const targetPayments = "bill_category_migration_target_payments";
		const oldTable = (table as string)
			.replaceAll("transactions_new", sourceName)
			.replace("'jev', 'bill'", "'jev'");
		const newTable = (table as string).replaceAll(
			"transactions_new",
			targetName,
		);
		const newPayments = (name: string, txTable: string) =>
			`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE, period TEXT NOT NULL, transaction_id INTEGER NOT NULL REFERENCES ${txTable}(id) ON DELETE CASCADE, matched_by TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)`;

		try {
			await env.DB.batch([
				env.DB.prepare(oldTable),
				env.DB.prepare(newTable),
				env.DB.prepare(newPayments(sourcePayments, sourceName)),
				env.DB.prepare(newPayments(targetPayments, targetName)),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9910,'Migration test',1000,10,'monthly',5,'MIGRATION TEST')",
				),
				env.DB.prepare(
					`INSERT INTO ${sourceName}(id,account_id,date,amount_cents,raw_name,is_split) SELECT 9910,id,'2026-09-10',1000,'MIGRATION TEST',1 FROM accounts LIMIT 1`,
				),
				env.DB.prepare(
					`INSERT INTO ${sourceName}(id,account_id,date,amount_cents,raw_name,parent_id) SELECT 9911,id,'2026-09-10',600,'MIGRATION TEST',9910 FROM accounts LIMIT 1`,
				),
				env.DB.prepare(
					`INSERT INTO ${sourceName}(id,account_id,date,amount_cents,raw_name,refund_of_id) SELECT 9912,id,'2026-09-11',-100,'MIGRATION REFUND',9910 FROM accounts LIMIT 1`,
				),
				env.DB.prepare(
					`INSERT INTO ${sourcePayments}(id,bill_id,period,transaction_id,matched_by,status,created_at) VALUES(9910,9910,'2026-09',9910,'user','linked','2026-09-10 00:00:00')`,
				),
			]);
			await env.DB.batch([
				env.DB.prepare(
					(transactionCopy as string)
						.replaceAll("transactions_new", targetName)
						.replaceAll("transactions", sourceName),
				),
				env.DB.prepare(
					(paymentCopy as string)
						.replaceAll("bill_payments_keep", sourcePayments)
						.replaceAll("bill_payments", targetPayments),
				),
			]);
			await env.DB.prepare(
				`UPDATE ${targetName} SET category_id=5, category_source='bill' WHERE id=9911`,
			).run();
			expect(
				(
					await env.DB.prepare(
						`SELECT id,parent_id,refund_of_id FROM ${targetName} ORDER BY id`,
					).all()
				).results,
			).toEqual([
				{ id: 9910, parent_id: null, refund_of_id: null },
				{ id: 9911, parent_id: 9910, refund_of_id: null },
				{ id: 9912, parent_id: null, refund_of_id: 9910 },
			]);
			expect(
				await env.DB.prepare(
					`SELECT bill_id,transaction_id FROM ${targetPayments}`,
				).first(),
			).toEqual({ bill_id: 9910, transaction_id: 9910 });
		} finally {
			await env.DB.batch([
				env.DB.prepare(`DROP TABLE IF EXISTS ${sourcePayments}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${targetPayments}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${sourceName}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${targetName}`),
				env.DB.prepare("DELETE FROM bills WHERE id=9910"),
			]);
		}
	});
});
