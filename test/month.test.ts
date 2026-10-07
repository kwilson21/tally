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
		expect(
			plan.results.some(({ detail }) =>
				/SEARCH t USING INDEX transactions_date \(date>\? AND date<\?\)/.test(
					detail,
				),
			),
		).toBe(true);
	});

	async function clearHistory() {
		await db.batch([
			db.prepare("DELETE FROM bill_payments"),
			db.prepare("DELETE FROM bills"),
			db.prepare("DELETE FROM transactions"),
		]);
	}

	it("starts at the earliest month with a counted transaction, skipping excluded history", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded) VALUES (301, 1, '2026-08-12', 1000, 'TRANSFER', 1)",
			),
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (302, 1, '2026-09-02', 1000, 'GROCERIES')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-09");
	});

	it("starts at income before spending, while still skipping an excluded earlier month", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded, flag_income) VALUES (313, 1, '2026-07-12', 1000, 'EXCLUDED', 1, 0)",
			),
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, flag_income) VALUES (314, 1, '2026-08-12', -100000, 'PAYCHECK', 1)",
			),
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name) VALUES (315, 1, '2026-09-02', 1000, 'GROCERIES')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-08");
	});

	it("uses an earlier linked bill occurrence month", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(93,'First rent',4000,1,'monthly',1,'RENT')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES(93,1,'2026-08-31',4000,'RENT',1)",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(93,'2026-07',93,'user','linked')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-07");
	});

	it("finds an earlier occurrence even when a later bank date follows the first spending date", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(94,'July rent',4000,1,'monthly',1,'RENT')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES (307,1,'2026-08-02',1000,'GROCERIES',1), (308,1,'2026-09-02',4000,'RENT',1)",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(94,'2026-07',308,'user','linked')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-07");
	});

	it("covers a bill occurrence two calendar months before its payment date", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(95,'January rent',4000,31,'monthly',1,'RENT')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES (309,1,'2026-02-01',1000,'GROCERIES',1), (310,1,'2026-03-02',4000,'RENT',1)",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(95,'2026-01',310,'user','linked')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-01");
	});

	it("does not let a payment outside the link date window extend the bound", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(96,'July rent',4000,1,'monthly',1,'RENT')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) VALUES (311,1,'2026-08-02',1000,'GROCERIES',1), (312,1,'2026-11-02',4000,'RENT',1)",
			),
			// The link route rejects this: the bank date is over 30 days from July 1.
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(96,'2026-07',312,'user','linked')",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-08");
	});

	it("uses the purchase month for a linked refund dated earlier", async () => {
		await clearHistory();
		await db.batch([
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id) VALUES (304, 1, '2026-09-12', 1000, 'PURCHASE', 1)",
			),
			db.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, category_id, credit_reviewed, refund_of_id) VALUES (305, 1, '2026-08-12', -500, 'REFUND', 1, 1, 304)",
			),
		]);
		expect(await firstCountedMonth(db)).toBe("2026-09");
	});

	it("returns no month when history has no counted transaction", async () => {
		await clearHistory();
		await db
			.prepare(
				"INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, excluded) VALUES (306, 1, '2026-08-12', 1000, 'TRANSFER', 1)",
			)
			.run();
		expect(await firstCountedMonth(db)).toBeNull();
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
