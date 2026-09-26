import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addCategory,
	categoryNames,
	moveCategory,
	saveCategory,
	setArchived,
	settingsCategories,
} from "../src/db/categories";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;
const MONTH = "2026-09";

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

const names = async () =>
	(await settingsCategories(db, MONTH)).active.map((c) => c.name);

describe("settingsCategories", () => {
	it("lists active categories in order with this month's budget, and archived ones apart", async () => {
		await setArchived(db, 5, true);
		const { active, archived } = await settingsCategories(db, MONTH);
		expect(active.map((c) => [c.name, c.budgetCents])).toEqual([
			["Groceries", 70000],
			["Eating Out", 25000],
			["Gas", 20000],
			["Kids", 30000],
		]);
		expect(archived.map((c) => c.name)).toEqual(["Household"]);
	});
});

describe("addCategory", () => {
	it("adds a category at the end, with the tag icon, the next color and no budget", async () => {
		expect(await addCategory(db, { name: "Travel" })).not.toBeNull();
		expect((await settingsCategories(db, MONTH)).active.at(-1)).toMatchObject({
			name: "Travel",
			icon: "tag",
			color: "cat-blue",
			budgetCents: null,
		});
	});
});

describe("saveCategory", () => {
	it("renames, leaving the budget as it was", async () => {
		await saveCategory(db, 1, { name: "Food at home" });
		expect(await names()).toContain("Food at home");
		expect((await settingsCategories(db, MONTH)).active[0]?.budgetCents).toBe(
			70000,
		);
	});
});

describe("setArchived", () => {
	it("archives and restores without deleting anything (spec §7)", async () => {
		const before = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id = 2")
			.first<{ n: number }>();
		await setArchived(db, 2, true);
		expect(await names()).not.toContain("Eating Out");
		await setArchived(db, 2, false);
		expect(await names()).toContain("Eating Out");
		const after = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE category_id = 2")
			.first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
	});
});

describe("moveCategory", () => {
	it("moves a category up or down one place, and does nothing past either end", async () => {
		await moveCategory(db, 3, "up");
		expect(await names()).toEqual([
			"Groceries",
			"Gas",
			"Eating Out",
			"Kids",
			"Household",
		]);
		await moveCategory(db, 3, "down");
		expect(await names()).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Kids",
			"Household",
		]);
		await moveCategory(db, 1, "up");
		await moveCategory(db, 5, "down");
		expect(await names()).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Kids",
			"Household",
		]);
	});
});

describe("restoring after a move", () => {
	it("puts a restored category at the end, never sharing a place with another", async () => {
		await setArchived(db, 2, true);
		await moveCategory(db, 5, "up");
		await setArchived(db, 2, false);
		expect(await names()).toEqual([
			"Groceries",
			"Gas",
			"Household",
			"Kids",
			"Eating Out",
		]);
		const orders = await db
			.prepare("SELECT sort_order FROM categories WHERE archived = 0")
			.all<{ sort_order: number }>();
		const values = orders.results.map((r) => r.sort_order);
		expect(new Set(values).size).toBe(values.length);
	});
});

describe("names that differ only in capitals", () => {
	it("are refused by the database itself, so two saves at once can't both win", async () => {
		await addCategory(db, { name: "Travel" });
		await expect(addCategory(db, { name: "travel" })).rejects.toThrow(/UNIQUE/);
		await expect(saveCategory(db, 1, { name: "GAS" })).rejects.toThrow(
			/UNIQUE/,
		);
	});
});

describe("categoryNames", () => {
	it("lists every category, archived too, for the form's checks", async () => {
		await setArchived(db, 5, true);
		expect(await categoryNames(db)).toContainEqual({
			id: 5,
			name: "Household",
			archived: true,
		});
	});
});

describe("an archived category on Home", () => {
	const onHome = async (month: string) =>
		(await loadMonth(db, month)).categories.map((c) => c.name);

	it("stays for a month it has spending in, so the month still adds up, and leaves after", async () => {
		await setArchived(db, 2, true);
		expect(await onHome(MONTH)).toContain("Eating Out");
		expect(await onHome("2026-10")).not.toContain("Eating Out");
	});

	it("doesn't come back for a month whose only rows in it are income", async () => {
		await db
			.prepare(
				"UPDATE transactions SET flag_income = 1 WHERE category_id = 2 AND substr(date, 1, 7) = ?",
			)
			.bind(MONTH)
			.run();
		await setArchived(db, 2, true);
		expect(await onHome(MONTH)).not.toContain("Eating Out");
	});
});

describe("the 50-category limit, checked in the same write", () => {
	// The demo has 5 active; fill up to 50, as if other saves landed first.
	const fill = () =>
		db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 45)
				 INSERT INTO categories (name, icon, color) SELECT 'Extra ' || i, 'tag', 'cat-blue' FROM n`,
			)
			.run();
	const count = async (sql: string) =>
		(await db.prepare(sql).first<{ n: number }>())?.n;

	it("adds nothing once 50 are active", async () => {
		await fill();
		expect(await addCategory(db, { name: "Travel" })).toBeNull();
		expect(
			await count("SELECT COUNT(*) AS n FROM categories WHERE archived = 0"),
		).toBe(50);
	});

	it("doesn't restore a category that's already active, so it keeps its place", async () => {
		expect(await setArchived(db, 2, false)).toBe(false);
		expect((await names())[1]).toBe("Eating Out");
	});

	it("restores nothing once 50 are active", async () => {
		await setArchived(db, 2, true);
		await fill();
		await db
			.prepare(
				"INSERT INTO categories (name, icon, color) VALUES ('Extra 46', 'tag', 'cat-blue')",
			)
			.run();
		expect(await setArchived(db, 2, false)).toBe(false);
		expect(
			await count("SELECT COUNT(*) AS n FROM categories WHERE archived = 0"),
		).toBe(50);
	});
});
