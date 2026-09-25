import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0005_default_categories.sql?raw";
import { resetDemo } from "../src/demo/reset";
import { ICON_NAMES } from "../src/views/icons";

const db = env.DB;

/** The migration's statements, without comments. */
const statements = migration
	.split("\n")
	.filter((line) => !line.startsWith("--"))
	.join("\n")
	.split(";")
	.map((s) => s.trim())
	.filter(Boolean);

const categories = async () =>
	(
		await db
			.prepare(
				"SELECT name, icon, color, sort_order AS sortOrder, archived FROM categories ORDER BY sort_order",
			)
			.all<{
				name: string;
				icon: string;
				color: string;
				sortOrder: number;
				archived: number;
			}>()
	).results;

describe("migration 0005: default categories (spec §7, decision 32)", () => {
	it("gives a new, empty database the 14 default categories, in order, with no budgets", async () => {
		// The tests' database gets every migration before any data, like production.
		const rows = await categories();
		expect(rows.map((c) => c.name)).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Car & Transport",
			"Rent",
			"Utilities",
			"Subscriptions",
			"Shopping",
			"Personal Care",
			"Health",
			"Entertainment",
			"Kids",
			"Date Night",
			"Donations & Charity",
		]);
		expect(rows.map((c) => c.sortOrder)).toEqual(rows.map((_, i) => i + 1));
		expect(rows.every((c) => c.archived === 0)).toBe(true);
		for (const c of rows) {
			expect(ICON_NAMES).toContain(c.icon);
			expect(c.color).toMatch(/^cat-(blue|plum|slate|ochre|brown)$/);
		}
		const budgets = await db
			.prepare("SELECT COUNT(*) AS n FROM budget_amounts")
			.first<{ n: number }>();
		expect(budgets?.n).toBe(0);
	});

	it("leaves a database that already has categories alone, like the demo's", async () => {
		await resetDemo(db, "2026-09-22");
		const before = await categories();
		for (const sql of statements) await db.prepare(sql).run();
		expect(await categories()).toEqual(before);
	});

	it("renames a later category whose name differs only in capitals, so the unique index can always be made", async () => {
		await resetDemo(db, "2026-09-22");
		// A database from before this migration could hold both.
		await db.prepare("DROP INDEX categories_name_nocase").run();
		await db
			.prepare(
				"INSERT INTO categories (id, name, icon, color) VALUES (6, 'gas', 'tag', 'cat-blue')",
			)
			.run();
		for (const sql of statements) await db.prepare(sql).run();
		const names = (await categories()).map((c) => c.name);
		expect(names).toContain("Gas");
		expect(names).toContain("gas (6)");
		await expect(
			db
				.prepare(
					"INSERT INTO categories (name, icon, color) VALUES ('GAS', 'tag', 'cat-blue')",
				)
				.run(),
		).rejects.toThrow(/UNIQUE/);
	});
});
