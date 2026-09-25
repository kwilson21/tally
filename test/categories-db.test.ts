import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
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
	it("adds a category at the end, with the tag icon, the next color and its budget", async () => {
		await addCategory(db, { name: "Travel", budgetCents: 40000 }, MONTH);
		const { active } = await settingsCategories(db, MONTH);
		expect(active.at(-1)).toMatchObject({
			name: "Travel",
			icon: "tag",
			color: "cat-blue",
			budgetCents: 40000,
		});
	});

	it("adds one with no budget when none is given", async () => {
		await addCategory(db, { name: "Travel", budgetCents: null }, MONTH);
		expect(
			(await settingsCategories(db, MONTH)).active.at(-1)?.budgetCents,
		).toBeNull();
	});
});

describe("saveCategory", () => {
	it("renames, and sets the budget from this month on, leaving earlier months as they were", async () => {
		await saveCategory(
			db,
			1,
			{ name: "Food at home", budgetCents: 65000 },
			MONTH,
		);
		expect(await names()).toContain("Food at home");
		const sept = summarizeMonth({
			month: MONTH,
			...(await loadMonth(db, MONTH)),
			unpaidDueBillsCents: 0,
		});
		expect(sept.categories.find((c) => c.id === 1)?.budgetCents).toBe(65000);
		const aug = summarizeMonth({
			month: "2026-08",
			...(await loadMonth(db, "2026-08")),
			unpaidDueBillsCents: 0,
		});
		expect(aug.categories.find((c) => c.id === 1)?.budgetCents).toBe(70000);
	});

	it("changes this month's amount again rather than adding a second one", async () => {
		await saveCategory(db, 1, { name: "Groceries", budgetCents: 65000 }, MONTH);
		await saveCategory(db, 1, { name: "Groceries", budgetCents: 66000 }, MONTH);
		const rows = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM budget_amounts WHERE category_id = 1 AND effective_month = ?",
			)
			.bind(MONTH)
			.first<{ n: number }>();
		expect(rows?.n).toBe(1);
		expect((await settingsCategories(db, MONTH)).active[0]?.budgetCents).toBe(
			66000,
		);
	});

	it("keeps the budget when none is given", async () => {
		await saveCategory(db, 1, { name: "Groceries", budgetCents: null }, MONTH);
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
