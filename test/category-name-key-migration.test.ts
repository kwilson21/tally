import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";

const db = env.DB;
const scratch = "name_key_migration_categories";
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0052_category_name_key"),
);

describe("migration 0052 category name key", () => {
	afterAll(async () => {
		await db.prepare(`DROP TABLE IF EXISTS ${scratch}`).run();
	});

	it("keys each category name with SQL's lower(), keeps accented capitals as they were, and refuses a second key", async () => {
		if (!migration) throw new Error("Migration 0052 is missing");
		await db.batch([
			db.prepare(`DROP TABLE IF EXISTS ${scratch}`),
			db.prepare(
				`CREATE TABLE ${scratch} (id INTEGER PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'tag', color TEXT NOT NULL DEFAULT 'cat-blue', sort_order INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0)`,
			),
			// "École" and "école" were both saved before the form checked accented capitals.
			db.prepare(
				`INSERT INTO ${scratch} (id, name) VALUES (1, 'Gas'), (2, 'École'), (3, 'école')`,
			),
		]);
		for (const query of migration.queries) {
			await db.prepare(query.replaceAll("categories", scratch)).run();
		}
		const { results } = await db
			.prepare(`SELECT id, name, name_key FROM ${scratch} ORDER BY id`)
			.all<{ id: number; name: string; name_key: string }>();
		expect(results).toEqual([
			{ id: 1, name: "Gas", name_key: "gas" },
			{ id: 2, name: "École", name_key: "École" },
			{ id: 3, name: "école", name_key: "école" },
		]);
		await expect(
			db
				.prepare(
					`INSERT INTO ${scratch} (name, name_key) VALUES ('GAS two', 'gas')`,
				)
				.run(),
		).rejects.toThrow(/UNIQUE/);
	});
});
