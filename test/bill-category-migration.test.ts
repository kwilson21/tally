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

	it("preserves the full transactions schema and rows through the rebuild", async () => {
		const tx = "bc_guard_transactions";
		const txNew = `${tx}_new`;
		const payments = "bc_guard_bill_payments";
		const bills = "bc_guard_bills";
		const paymentsKeep = `${payments}_keep`;
		const suggestions = "bc_guard_category_suggestions";
		const pre26 = env.TEST_MIGRATIONS;
		const clean = (sql: string) =>
			sql
				.split("\n")
				.filter((line) => !line.trim().startsWith("--"))
				.join("\n")
				.trim();
		const pre17Rebuild =
			/^(CREATE TABLE (transactions|bill_payments|bills)\b|ALTER TABLE (transactions|bills)\b|CREATE (UNIQUE )?INDEX \w+ ON (transactions|bill_payments)\b)/;
		const prefixPre17 = (sql: string) =>
			sql.replaceAll(
				/\b(transactions|bill_payments|bills)(_\w+)?\b/g,
				"bc_guard_$1$2",
			);
		const before17 = pre26
			.filter((item) => item.name < "0017")
			.flatMap((item) => item.queries)
			.map(clean)
			.filter((sql) => pre17Rebuild.test(sql))
			.map(prefixPre17);
		const through25 = pre26
			.filter((item) =>
				["0017", "0019", "0020", "0021", "0024", "0025"].some((version) =>
					item.name.startsWith(version),
				),
			)
			.flatMap((item) => item.queries)
			.map(clean)
			.map((sql) =>
				prefixPre17(sql).replaceAll("category_suggestions", suggestions),
			);
		const transform = (sql: string) =>
			sql
				.replaceAll(/\btransactions_([a-z_]+)\b/g, `${tx}_$1`)
				.replaceAll(/\bbill_payments_([a-z_]+)\b/g, `bc_guard_bill_payments_$1`)
				.replaceAll(
					/\bbill_payment_category(_on_repoint)?\b/g,
					"bc_guard_bill_payment_category$1",
				)
				.replaceAll(/\btransactions_new\b/g, txNew)
				.replaceAll(/\btransactions\b/g, tx)
				.replaceAll(/\bbill_payments_keep\b/g, paymentsKeep)
				.replaceAll(/\bbill_payments\b/g, payments)
				.replaceAll(/\bbills\b/g, bills)
				.replaceAll("category_suggestions", suggestions);
		const statement = (sql: string) => sql.replace(/;\s*$/, "");
		const masterSql = async (type: string, name: string) =>
			(
				await env.DB.prepare(
					"SELECT sql FROM sqlite_master WHERE type=? AND name=?",
				)
					.bind(type, name)
					.first<{ sql: string }>()
			)?.sql;
		const accountId = (
			await env.DB.prepare("SELECT id FROM accounts LIMIT 1").first<{
				id: number;
			}>()
		)?.id;
		expect(accountId).toBeDefined();
		let sourceIndexes: { name: string; sql: string }[] = [];
		const snapshot = async () => {
			const tableSql = await masterSql("table", tx);
			const indexes = (
				await env.DB.prepare(
					"SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name",
				)
					.bind(tx)
					.all<{ name: string; sql: string | null }>()
			).results.map(({ name, sql }) => ({
				name,
				sql: sql?.replaceAll('"', ""),
			}));
			const triggers = (
				await env.DB.prepare(
					"SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?) ORDER BY name",
				)
					.bind(tx, payments)
					.all()
			).results;
			const columns = (await env.DB.prepare(`PRAGMA table_info('${tx}')`).all())
				.results;
			const foreignKeys = (
				await env.DB.prepare(`PRAGMA foreign_key_list('${tx}')`).all()
			).results;
			return {
				tableSql: tableSql?.replaceAll('"', ""),
				indexes,
				triggers,
				columns,
				foreignKeys,
			};
		};
		const seed = [
			env.DB.prepare(
				`INSERT INTO ${bills}(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9950,'Guard bill',1000,10,'monthly',5,'GUARD BILL')`,
			),
			...[
				{ id: 9950, raw: "Split parent", values: "is_split" },
				{ id: 9951, raw: "Split part", values: "parent_id" },
				{ id: 9952, raw: "Cash entry", values: "entry_key" },
				{ id: 9953, raw: "Pending entry", values: "pending" },
				{ id: 9954, raw: "Refund purchase", values: "plain" },
				{ id: 9955, raw: "Refund row", values: "refund_of_id" },
				{ id: 9956, raw: "Bill payment", values: "user_category" },
			].map(({ id, raw, values }) => {
				const extra = {
					is_split: "is_split",
					parent_id: "parent_id",
					entry_key: "entry_key",
					pending: "pending",
					refund_of_id: "refund_of_id",
					user_category: "user_category",
					plain: "plain",
				}[values];
				const fields =
					extra === "is_split"
						? ",is_split"
						: extra === "parent_id"
							? ",parent_id"
							: extra === "entry_key"
								? ",entry_key"
								: extra === "pending"
									? ",pending"
									: extra === "refund_of_id"
										? ",refund_of_id"
										: extra === "user_category"
											? ",category_id,category_source"
											: "";
				const valueSql =
					values === "is_split"
						? ",1"
						: values === "parent_id"
							? ",9950"
							: values === "entry_key"
								? ", 'cash:bc-guard'"
								: values === "pending"
									? ",1"
									: values === "refund_of_id"
										? ",9954"
										: values === "user_category"
											? ",5,'user'"
											: "";
				return env.DB.prepare(
					`INSERT INTO ${tx}(id,account_id,date,amount_cents,raw_name${fields}) VALUES(${id},${accountId},'2026-09-10',1000,'${raw}'${valueSql})`,
				);
			}),
			env.DB.prepare(
				`INSERT INTO ${payments}(bill_id,period,transaction_id,matched_by,status) VALUES(9950,'2026-09',9956,'user','linked')`,
			),
		];
		try {
			await env.DB.batch(
				[...before17, ...through25].map((sql) =>
					env.DB.prepare(statement(sql)),
				),
			);
			sourceIndexes = (
				await env.DB.prepare(
					"SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
				)
					.bind(tx)
					.all<{ name: string; sql: string }>()
			).results;
			await env.DB.batch(seed);
			const before = await snapshot();
			const rowsBefore = (
				await env.DB.prepare(`SELECT * FROM ${tx} ORDER BY id`).all()
			).results;
			const migrationStatements = env.TEST_MIGRATIONS.find((item) =>
				item.name.startsWith("0026_bill_category"),
			)?.queries;
			expect(migrationStatements).toBeDefined();
			const statements = (migrationStatements ?? []).map(transform);
			await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
			const after = await snapshot();
			const rowsAfter = (
				await env.DB.prepare(`SELECT * FROM ${tx} ORDER BY id`).all()
			).results;
			const normalizedTable = (sql: string) =>
				sql.replaceAll(/\s+/g, "").replaceAll('"', "");
			expect(normalizedTable(after.tableSql as string)).toBe(
				normalizedTable(before.tableSql as string).replace(
					"'user','merchant_rule','jev'",
					"'user','merchant_rule','jev','bill'",
				),
			);
			expect(after.indexes).toEqual(before.indexes);
			expect(after.indexes.map(({ name }) => name)).toContain(
				`${tx}_entry_key`,
			);
			expect(after.columns).toEqual(before.columns);
			expect(after.foreignKeys).toEqual(before.foreignKeys);
			expect(after.triggers).toEqual([
				{
					name: "bc_guard_bill_payment_category",
					tbl_name: payments,
					sql: expect.stringContaining(
						"AFTER INSERT ON bc_guard_bill_payments",
					),
				},
				{
					name: "bc_guard_bill_payment_category_on_repoint",
					tbl_name: payments,
					sql: expect.stringContaining(
						"AFTER UPDATE OF transaction_id ON bc_guard_bill_payments",
					),
				},
			]);
			expect(rowsAfter).toEqual(rowsBefore);
		} finally {
			await env.DB.batch([
				env.DB.prepare(`DROP TABLE IF EXISTS ${paymentsKeep}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${payments}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${tx}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${bills}`),
				env.DB.prepare(`DROP TABLE IF EXISTS ${suggestions}`),
				...sourceIndexes.map(({ name }) =>
					env.DB.prepare(`DROP INDEX IF EXISTS bc_guard_${name}`),
				),
				env.DB.prepare("DROP TRIGGER IF EXISTS bc_guard_bill_payment_category"),
				env.DB.prepare(
					"DROP TRIGGER IF EXISTS bc_guard_bill_payment_category_on_repoint",
				),
			]);
		}
	});

	it("allows bill as a category source and keeps existing rows readable", async () => {
		const schema = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'",
		).first<{ sql: string }>();
		expect(schema?.sql).toContain("'bill'");
		expect(schema?.sql).toContain("jev_none_fit");
		expect(schema?.sql).toContain("category_suggestion_id");
		expect(
			await env.DB.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='transactions_category_suggestion_id'",
			).first(),
		).toEqual({ name: "transactions_category_suggestion_id" });
		await expect(
			env.DB.prepare(
				"SELECT id,category_id,category_source FROM transactions ORDER BY id LIMIT 1",
			).first(),
		).resolves.toBeDefined();
		expect(
			(await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
	});

	it("backfills linked uncategorized and Jev payments, preserving other choices and links without a bill category", async () => {
		const backfill = migration.match(
			/UPDATE transactions\s+SET category_id = \(SELECT b\.category_id[\s\S]*?;\n/,
		)?.[0];
		const triggers = [
			migration.match(
				/CREATE TRIGGER bill_payment_category\n[\s\S]*?END;/,
			)?.[0],
			migration.match(
				/CREATE TRIGGER bill_payment_category_on_repoint\n[\s\S]*?END;/,
			)?.[0],
		];
		expect(backfill).toBeDefined();
		expect(triggers.every(Boolean)).toBe(true);
		await env.DB.batch([
			env.DB.prepare("DROP TRIGGER bill_payment_category"),
			env.DB.prepare("DROP TRIGGER bill_payment_category_on_repoint"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9920,'Backfill test',1000,10,'monthly',5,'BACKFILL TEST'),(9921,'No category test',1000,10,'monthly',NULL,'NO CATEGORY TEST')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9920,id,'2026-09-10',1000,'BACKFILL TEST',NULL,NULL FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9921,id,'2026-09-10',1000,'JEV TEST',3,'jev' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9922,id,'2026-09-10',1000,'USER TEST',4,'user' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9923,id,'2026-09-10',1000,'MERCHANT RULE TEST',4,'merchant_rule' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9924,id,'2026-09-10',1000,'UNLINKED TEST' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9925,id,'2026-09-10',1000,'JEV NO BILL CATEGORY TEST',3,'jev' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(id,bill_id,period,transaction_id,matched_by,status) VALUES(9920,9920,'2026-09',9920,'user','linked'),(9921,9920,'2026-10',9921,'user','linked'),(9922,9920,'2026-11',9922,'user','linked'),(9923,9920,'2026-12',9923,'user','linked'),(9924,9920,'2027-01',9924,'user','dismissed'),(9925,9921,'2026-09',9925,'user','linked')",
			),
		]);
		try {
			await env.DB.prepare(backfill as string).run();
			expect(
				(
					await env.DB.prepare(
						"SELECT id,category_id AS categoryId,category_source AS categorySource FROM transactions WHERE id BETWEEN 9920 AND 9925 ORDER BY id",
					).all()
				).results,
			).toEqual([
				{ id: 9920, categoryId: 5, categorySource: "bill" },
				{ id: 9921, categoryId: 5, categorySource: "bill" },
				{ id: 9922, categoryId: 4, categorySource: "user" },
				{ id: 9923, categoryId: 4, categorySource: "merchant_rule" },
				{ id: 9924, categoryId: null, categorySource: null },
				{ id: 9925, categoryId: 3, categorySource: "jev" },
			]);
		} finally {
			await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM bill_payments WHERE id BETWEEN 9920 AND 9925",
				),
				env.DB.prepare(
					"DELETE FROM transactions WHERE id BETWEEN 9920 AND 9925",
				),
				env.DB.prepare("DELETE FROM bills WHERE id IN (9920,9921)"),
				env.DB.prepare(triggers[0] as string),
				env.DB.prepare(triggers[1] as string),
			]);
		}
	});

	it("backfills every category-source, link, and bill-category combination", async () => {
		const backfill = migration.match(
			/UPDATE transactions\s+SET category_id = \(SELECT b\.category_id[\s\S]*?;\n/,
		)?.[0];
		expect(backfill).toBeDefined();
		const categoryTriggers = [
			migration.match(
				/CREATE TRIGGER bill_payment_category\n[\s\S]*?END;/,
			)?.[0],
			migration.match(
				/CREATE TRIGGER bill_payment_category_on_repoint\n[\s\S]*?END;/,
			)?.[0],
		];
		expect(categoryTriggers.every(Boolean)).toBe(true);
		const sources = [null, "jev", "user", "merchant_rule"] as const;
		const cells = sources.flatMap((source, sourceIndex) =>
			[false, true].flatMap((linked) =>
				[false, true].map((billHasCategory) => ({
					id:
						9930 +
						sourceIndex * 4 +
						Number(linked) * 2 +
						Number(billHasCategory),
					source,
					linked,
					billHasCategory,
				})),
			),
		);
		const inserts = cells.map(({ id, source }) =>
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source,category_confidence,jev_category_id,jev_none_fit,category_suggestion_id) SELECT ?,id,'2026-09-10',1000,?,?,?,0.75,3,1,9930 FROM accounts LIMIT 1",
			).bind(
				id,
				`MATRIX ${id}`,
				source === null ? null : source === "jev" ? 3 : 4,
				source,
			),
		);
		const linkedCells = cells.filter((cell) => cell.linked);
		try {
			await env.DB.batch([
				env.DB.prepare("DROP TRIGGER bill_payment_category"),
				env.DB.prepare("DROP TRIGGER bill_payment_category_on_repoint"),
				env.DB.prepare(
					"INSERT INTO category_suggestions(id,name,status) VALUES(9930,'Matrix suggestion','pending')",
				),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9930,'Matrix categorized',1000,10,'monthly',5,'MATRIX YES'),(9931,'Matrix uncategorized',1000,10,'monthly',NULL,'MATRIX NO')",
				),
				...inserts,
				...linkedCells.map((cell) =>
					env.DB.prepare(
						"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,?, 'linked')",
					).bind(
						cell.billHasCategory ? 9930 : 9931,
						`2026-${String(cell.id).slice(-2)}`,
						cell.id,
						"user",
					),
				),
			]);
			await env.DB.prepare(backfill as string).run();
			const actual = (
				await env.DB.prepare(
					"SELECT id,category_id AS categoryId,category_source AS categorySource,category_confidence AS categoryConfidence,jev_category_id AS jevCategoryId,jev_none_fit AS jevNoneFit,category_suggestion_id AS categorySuggestionId FROM transactions WHERE id BETWEEN 9930 AND 9945 ORDER BY id",
				).all()
			).results;
			expect(actual).toEqual(
				cells.map(({ id, source, linked, billHasCategory }) => {
					const changed =
						linked && billHasCategory && (source === null || source === "jev");
					return {
						id,
						categoryId: changed
							? 5
							: source === null
								? null
								: source === "jev"
									? 3
									: 4,
						categorySource: changed ? "bill" : source,
						categoryConfidence: changed ? null : 0.75,
						jevCategoryId: changed ? null : 3,
						jevNoneFit: changed ? 0 : 1,
						categorySuggestionId: changed ? null : 9930,
					};
				}),
			);
		} finally {
			await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM bill_payments WHERE transaction_id BETWEEN 9930 AND 9945",
				),
				env.DB.prepare(
					"DELETE FROM transactions WHERE id BETWEEN 9930 AND 9945",
				),
				env.DB.prepare("DELETE FROM bills WHERE id IN (9930,9931)"),
				env.DB.prepare("DELETE FROM category_suggestions WHERE id=9930"),
				env.DB.prepare(categoryTriggers[0] as string),
				env.DB.prepare(categoryTriggers[1] as string),
			]);
		}
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
					"INSERT INTO category_suggestions(id,name,status) VALUES(9910,'Migration test suggestion','pending')",
				),
				env.DB.prepare(
					`INSERT INTO ${sourceName}(id,account_id,date,amount_cents,raw_name,is_split) SELECT 9910,id,'2026-09-10',1000,'MIGRATION TEST',1 FROM accounts LIMIT 1`,
				),
				env.DB.prepare(
					`INSERT INTO ${sourceName}(id,account_id,date,amount_cents,raw_name,parent_id,jev_none_fit,category_suggestion_id) SELECT 9911,id,'2026-09-10',600,'MIGRATION TEST',9910,1,9910 FROM accounts LIMIT 1`,
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
						`SELECT id,parent_id,refund_of_id,jev_none_fit,category_suggestion_id FROM ${targetName} ORDER BY id`,
					).all()
				).results,
			).toEqual([
				{
					id: 9910,
					parent_id: null,
					refund_of_id: null,
					jev_none_fit: 0,
					category_suggestion_id: null,
				},
				{
					id: 9911,
					parent_id: 9910,
					refund_of_id: null,
					jev_none_fit: 1,
					category_suggestion_id: 9910,
				},
				{
					id: 9912,
					parent_id: null,
					refund_of_id: 9910,
					jev_none_fit: 0,
					category_suggestion_id: null,
				},
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
				env.DB.prepare("DELETE FROM category_suggestions WHERE id=9910"),
			]);
		}
	});
});
