import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	budgetCategory,
	lastMonthSpentCents,
	setBudget,
} from "../src/db/budgets";
import { settingsCategories } from "../src/db/categories";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const MONTH = "2026-09";

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
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
