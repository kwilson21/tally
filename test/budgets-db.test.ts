import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BUDGET_CENTS } from "../src/budgets/amount";
import { nudgeCents } from "../src/budgets/nudge";
import {
	budgetCategory,
	lastMonthSpentCents,
	nudgeBudget,
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
