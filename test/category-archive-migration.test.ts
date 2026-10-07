import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";

const db = env.DB;
const scratch = "archive_migration_categories";
const migration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0032_category_archived_on"),
);

describe("migration 0032 category archive date", () => {
	afterAll(async () => {
		await db.prepare(`DROP TABLE IF EXISTS ${scratch}`).run();
	});

	it("adds a nullable date without guessing when existing categories were archived", async () => {
		if (!migration) throw new Error("Migration 0032 is missing");
		await db.batch([
			db.prepare(`DROP TABLE IF EXISTS ${scratch}`),
			db.prepare(
				`CREATE TABLE ${scratch} (id INTEGER PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)))`,
			),
			db.prepare(`INSERT INTO ${scratch} (id, archived) VALUES (1, 1), (2, 0)`),
		]);
		for (const query of migration.queries) {
			await db.prepare(query.replaceAll("categories", scratch)).run();
		}
		const { results } = await db
			.prepare(`SELECT id, archived_on FROM ${scratch} ORDER BY id`)
			.all<{ id: number; archived_on: string | null }>();
		expect(results).toEqual([
			{ id: 1, archived_on: null },
			{ id: 2, archived_on: null },
		]);
	});
});
