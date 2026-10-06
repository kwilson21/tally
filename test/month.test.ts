import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { firstCountedMonth, loadMonth } from "../src/db/month";

const db = env.DB;

beforeAll(async () => {
	// Child tables first, in case another test file left rows behind (foreign keys are enforced).
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM bills"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM categories"),
		db.prepare("DELETE FROM accounts"),
	]);
	await db.batch([
		db.prepare(
			"INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'depository')",
		),
		db.prepare(
			"INSERT INTO categories (id, name, icon, color, sort_order) VALUES (1, 'Groceries', 'groceries', 'cat-blue', 1), (2, 'Eating Out', 'eating-out', 'cat-plum', 2), (3, 'Old', 'kids', 'cat-ochre', 3)",
		),
		db.prepare("UPDATE categories SET archived = 1 WHERE id = 3"),
		db.prepare(
			"INSERT INTO budget_amounts VALUES (1, '2026-01', 60000), (2, '2026-01', 25000)",
		),
		db.prepare(`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, excluded, is_split, parent_id, flag_income) VALUES
			(1, 1, '2026-09-02', 4000, 'TJ', 1, 0, 0, NULL, 0),
			(2, 1, '2026-09-30', 1000, 'CAFE', 2, 0, 0, NULL, 0),
			(3, 1, '2026-08-31', 9999, 'LAST MONTH', 1, 0, 0, NULL, 0),
			(4, 1, '2026-10-01', 9999, 'NEXT MONTH', 1, 0, 0, NULL, 0),
			(5, 1, '2026-09-10', 50000, 'TRANSFER', NULL, 1, 0, NULL, 0),
			(6, 1, '2026-09-12', 3000, 'COSTCO', NULL, 0, 1, NULL, 0),
			(7, 1, '2026-09-12', 2000, 'COSTCO', 1, 0, 0, 6, 0),
			(8, 1, '2026-09-12', 1000, 'COSTCO', 2, 0, 0, 6, 0),
			(9, 1, '2026-09-15', -245000, 'PAYCHECK', NULL, 0, 0, NULL, 1),
			(10, 1, '2026-09-16', 1200, 'SQ *BAKERY', NULL, 0, 0, NULL, 0)`),
	]);
});

describe("loadMonth", () => {
	it("returns only counted transactions for the month", async () => {
		const data = await loadMonth(db, "2026-09");
		const amounts = data.transactions
			.map((t) => t.amountCents)
			.sort((a, b) => a - b);
		// Excludes last/next month, the excluded transfer, and the split parent; keeps its children.
		expect(amounts).toEqual([-245000, 1000, 1000, 1200, 2000, 4000]);
		expect(
			data.transactions.find((t) => t.amountCents === -245000)?.income,
		).toBe(true);
	});

	it("returns active categories in sort order and all budget amounts", async () => {
		const data = await loadMonth(db, "2026-09");
		expect(data.categories).toEqual([
			{
				id: 1,
				name: "Groceries",
				icon: "groceries",
				color: "cat-blue",
				archived: false,
			},
			{
				id: 2,
				name: "Eating Out",
				icon: "eating-out",
				color: "cat-plum",
				archived: false,
			},
		]);
		expect(data.amounts).toHaveLength(2);
	});

	it("counts a late bill payment in its occurrence month, never twice", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(90,'Rent',4000,30,'monthly',1,'RENT')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES(90,1,'2026-10-02',4000,'RENT',1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(90,'2026-09',90,'user','linked')",
			)
			.run();
		expect(
			(await loadMonth(db, "2026-09")).transactions.some(
				(t) => t.amountCents === 4000,
			),
		).toBe(true);
		expect(
			(await loadMonth(db, "2026-10")).transactions.some(
				(t) => t.amountCents === 4000,
			),
		).toBe(false);
	});
});

describe("firstCountedMonth query count", () => {
	it("uses one indexed date lookup", async () => {
		let statements = 0;
		let lookup = "";
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						lookup = sql;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		expect(await firstCountedMonth(counted as D1Database)).toBe("2026-08");
		expect(statements).toBe(1);
		const plan = await db
			.prepare(`EXPLAIN QUERY PLAN ${lookup}`)
			.all<{ detail: string }>();
		expect(plan.results.map((row) => row.detail).join(" ")).toContain(
			"transactions_date",
		);
	});

	it("moves the first month back for a first-month bill payment counted in its prior occurrence month", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(91,'First rent',4000,1,'monthly',1,'RENT')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES(91,1,'2026-08-31',4000,'RENT',1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(91,'2026-07',91,'user','linked')",
			)
			.run();
		expect(await firstCountedMonth(db)).toBe("2026-07");
		await db.batch([
			db.prepare("DELETE FROM bill_payments WHERE bill_id=91"),
			db.prepare("DELETE FROM transactions WHERE id=91"),
			db.prepare("DELETE FROM bills WHERE id=91"),
		]);
	});

	it("keeps the bank month when a bill payment occurrence is later than its date month", async () => {
		await db
			.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(92,'Later rent',4000,1,'monthly',1,'RENT')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES(92,1,'2026-08-30',4000,'RENT',1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(92,'2026-09',92,'user','linked')",
			)
			.run();
		expect(await firstCountedMonth(db)).toBe("2026-08");
	});
});
