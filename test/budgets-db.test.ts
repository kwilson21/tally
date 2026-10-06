import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BUDGET_CENTS } from "../src/budgets/amount";
import { nudgeCents } from "../src/budgets/nudge";
import {
	budgetCategory,
	lastMonthSpentCents,
	nudgeBudget,
	setBudget,
	THREE_MONTH_AVERAGE_SQL,
	threeMonthAverageSpentCents,
} from "../src/db/budgets";
import { settingsCategories } from "../src/db/categories";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const MONTH = "2026-09";

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("threeMonthAverageSpentCents", () => {
	async function history(firstDate: string) {
		await db.batch([
			db.prepare("DELETE FROM bill_payments"),
			db.prepare("DELETE FROM transactions"),
			db
				.prepare(`INSERT INTO transactions
				(id, account_id, date, amount_cents, raw_name, category_id, category_source, credit_reviewed, refund_of_id) VALUES
				(800, 1, ?, 60000, 'FIRST', 1, 'user', NULL, NULL),
				(801, 1, ?, 65000, 'SECOND', 1, 'user', NULL, NULL),
				(802, 1, ?, 70000, 'THIRD', 1, 'user', NULL, NULL),
				(803, 1, '2026-10-01', 75000, 'FOURTH', 1, 'user', NULL, NULL)`)
				.bind(firstDate, "2026-08-01", "2026-09-01"),
		]);
	}

	it("requires three whole months and then includes a part first month only after it leaves the window", async () => {
		await history("2026-07-12");
		expect(await threeMonthAverageSpentCents(db, 1, "2026-10")).toBeNull();
		expect(await threeMonthAverageSpentCents(db, 1, "2026-11")).toBe(70000);
	});

	it("counts a refund in its purchase month", async () => {
		await history("2026-07-01");
		await db
			.prepare(`INSERT INTO transactions
			(id, account_id, date, amount_cents, raw_name, category_id, category_source, credit_reviewed, refund_of_id)
			VALUES (804, 1, '2026-10-04', -10000, 'REFUND', 1, 'user', 1, 802)`)
			.run();
		expect(await threeMonthAverageSpentCents(db, 1, "2026-11")).toBe(66667);
	});

	it("counts a linked bill payment in its occurrence month when dated later", async () => {
		await history("2026-07-01");
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(95,'Moved',1234,30,'monthly','MOVED')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 805,id,'2026-09-02',1234,'MOVED',1,'user' FROM accounts LIMIT 1",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(95,'2026-08',805,'user','linked')",
			),
		]);
		expect(await threeMonthAverageSpentCents(db, 1, "2026-11")).toBe(70411);
	});

	it("does not let years of older spending change the three-month result", async () => {
		await history("2020-01-01");
		const before = await threeMonthAverageSpentCents(db, 1, "2026-11");
		await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id,category_source) SELECT id,'2010-01-01',999999,'OLD HISTORY',1,'user' FROM accounts LIMIT 1",
			)
			.run();
		expect(await threeMonthAverageSpentCents(db, 1, "2026-11")).toBe(before);
	});

	it("uses the transaction date and refund indexes", async () => {
		const { results } = await db
			.prepare(`EXPLAIN QUERY PLAN ${THREE_MONTH_AVERAGE_SQL}`)
			.bind("2026-08", "2026-09", "2026-10", "2026-07-01", "2026-12-01", 1)
			.all<{ detail: string }>();
		const plan = results.map((row) => row.detail).join("\n");
		expect(plan).toMatch(
			/SEARCH transactions USING (COVERING )?INDEX transactions_date/,
		);
		expect(plan).toMatch(
			/SEARCH transactions USING (COVERING )?INDEX transactions_refund_of_id_idx/,
		);
	});
});

describe("setBudget", () => {
	it("sets a budget from this month on, and changes it in place when set again", async () => {
		await setBudget(db, 1, 65000, MONTH);
		await setBudget(db, 1, 66050, MONTH);
		const rows = await db
			.prepare(
				"SELECT amount_cents AS cents FROM budget_amounts WHERE category_id = 1 AND effective_month = ?",
			)
			.bind(MONTH)
			.all<{ cents: number }>();
		expect(rows.results).toEqual([{ cents: 66050 }]);
		const groceries = (await settingsCategories(db, MONTH)).active.find(
			(c) => c.id === 1,
		);
		expect(groceries?.budgetCents).toBe(66050);
	});

	it("leaves earlier months as they were", async () => {
		await setBudget(db, 1, 65000, MONTH);
		expect((await budgetCategory(db, 1, "2026-08"))?.budgetCents).toBe(70000);
		expect((await budgetCategory(db, 1, MONTH))?.budgetCents).toBe(65000);
	});
});

describe("budgetCategory", () => {
	it("gives the category with this month's budget, or null for an unknown id", async () => {
		expect(await budgetCategory(db, 1, MONTH)).toMatchObject({
			id: 1,
			name: "Groceries",
			archived: false,
			budgetCents: 70000,
		});
		expect(await budgetCategory(db, 999, MONTH)).toBeNull();
	});
});

describe("lastMonthSpentCents", () => {
	it("uses the linked occurrence month for a late payment", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(94,'Moved',1234,30,'monthly','BUDGET MOVED')",
			),
			db.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id) SELECT 904,id,'2026-09-02',1234,'BUDGET MOVED',1 FROM accounts LIMIT 1",
			),
			db.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(94,'2026-08',904,'user','linked')",
			),
		]);
		const augustBankTotal = await db
			.prepare(
				"SELECT COALESCE(SUM(amount_cents),0) AS n FROM transactions WHERE category_id=1 AND substr(date,1,7)='2026-08' AND excluded=0 AND is_split=0 AND flag_income=0",
			)
			.first<{ n: number }>();
		expect(await lastMonthSpentCents(db, 1, "2026-09")).toBe(
			(augustBankTotal?.n ?? 0) + 1234,
		);
	});
	it("adds up last month's counted spending in the category, leaving out income and excluded rows", async () => {
		const expected = await db
			.prepare(
				`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM transactions
				 WHERE category_id = 1 AND substr(date, 1, 7) = '2026-08'
				 AND excluded = 0 AND is_split = 0 AND flag_income = 0`,
			)
			.first<{ n: number }>();
		expect(await lastMonthSpentCents(db, 1, MONTH)).toBe(expected?.n);
		expect(expected?.n).toBeGreaterThan(0);
	});

	it("looks back across a new year", async () => {
		await db
			.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) SELECT id, '2025-12-15', 4200, 'DEC TEST', 1, 'user' FROM accounts LIMIT 1",
			)
			.run();
		expect(await lastMonthSpentCents(db, 1, "2026-01")).toBe(4200);
	});
});

describe("nudgeBudget", () => {
	it("follows nudgeCents' rule exactly, in both directions", async () => {
		const amounts = [
			0,
			1,
			500,
			999,
			1000,
			1001,
			70000,
			71240,
			71999,
			MAX_BUDGET_CENTS - 1,
			MAX_BUDGET_CENTS,
		];
		for (const cents of amounts)
			for (const direction of ["up", "down"] as const) {
				await setBudget(db, 1, cents, MONTH);
				const expected = nudgeCents(cents, direction);
				expect(await nudgeBudget(db, 1, direction, MONTH)).toBe(
					expected === cents ? null : expected,
				);
				expect((await budgetCategory(db, 1, MONTH))?.budgetCents).toBe(
					expected,
				);
			}
	});

	it("nudges an earlier month's budget from this month on, leaving the earlier month alone", async () => {
		await db.prepare("DELETE FROM budget_amounts WHERE category_id = 1").run();
		await setBudget(db, 1, 70000, "2026-07");
		expect(await nudgeBudget(db, 1, "up", MONTH)).toBe(71000);
		expect((await budgetCategory(db, 1, "2026-08"))?.budgetCents).toBe(70000);
		expect((await budgetCategory(db, 1, MONTH))?.budgetCents).toBe(71000);
	});

	it("does nothing for a category with no budget", async () => {
		await db.prepare("DELETE FROM budget_amounts WHERE category_id = 1").run();
		expect(await nudgeBudget(db, 1, "up", MONTH)).toBeNull();
		expect((await budgetCategory(db, 1, MONTH))?.budgetCents).toBeNull();
	});
});
