import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";

const db = env.DB;
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0038_category_archive_periods"),
);

describe("migration 0038 category archive periods", () => {
	afterAll(async () => {
		await db
			.prepare("DELETE FROM categories WHERE id IN (9201, 9202, 9203)")
			.run();
	});

	it("opens one period for each category archived on a known date, and no others", async () => {
		if (!migration) throw new Error("Migration 0038 is missing");
		await db
			.prepare(
				"INSERT INTO categories (id, name, icon, color, sort_order, archived, archived_on) VALUES (9201, 'Dated archive', 'tag', 'cat-blue', 9201, 1, '2026-08-20'), (9202, 'Undated archive', 'tag', 'cat-blue', 9202, 1, NULL), (9203, 'Active', 'tag', 'cat-blue', 9203, 0, NULL)",
			)
			.run();
		for (const query of migration.queries) {
			if (query.includes("INSERT INTO category_archive_periods")) {
				await db.prepare(query).run();
			}
		}
		const { results } = await db
			.prepare(
				"SELECT category_id, archived_on, restored_on FROM category_archive_periods WHERE category_id IN (9201, 9202, 9203) ORDER BY category_id",
			)
			.all<{
				category_id: number;
				archived_on: string;
				restored_on: string | null;
			}>();
		expect(results).toEqual([
			{ category_id: 9201, archived_on: "2026-08-20", restored_on: null },
		]);
	});
});
