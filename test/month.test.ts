import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { loadMonth } from "../src/db/month";

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
			{ id: 1, name: "Groceries", icon: "groceries", color: "cat-blue" },
			{ id: 2, name: "Eating Out", icon: "eating-out", color: "cat-plum" },
		]);
		expect(data.amounts).toHaveLength(2);
	});
});
