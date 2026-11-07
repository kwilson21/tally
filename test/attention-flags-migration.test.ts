import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import migration from "../migrations/0069_attention_flags.sql?raw";

const db = env.DB;

// The tests' database already has every migration, so migration 0069 runs here against a scratch copy of plaid_items
// as it was before it, filled with rows. A flag set before the flags has an unknown cause: it becomes the held flag,
// so only a relink clears it (decision 173). Ok banks get no flags.
afterEach(async () => {
	await db.prepare("DROP TABLE IF EXISTS pre0069_plaid_items").run();
});

it("migration 0069 backfills every existing flagged bank as held and leaves ok banks with no flags", async () => {
	await db.batch([
		db.prepare(
			`CREATE TABLE pre0069_plaid_items (
				id INTEGER PRIMARY KEY,
				institution_name TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_attention')),
				disconnected_at TEXT
			)`,
		),
		db.prepare(
			"INSERT INTO pre0069_plaid_items (id, institution_name, status) VALUES (1, 'Fine Bank', 'ok'), (2, 'Expiring Bank', 'needs_attention'), (3, 'Broken Bank', 'needs_attention')",
		),
	]);

	const sql = migration
		.split("\n")
		.filter((line) => !line.startsWith("--"))
		.join("\n")
		.replaceAll(/\bplaid_items\b/g, "pre0069_plaid_items");
	for (const statement of sql
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean))
		await db.prepare(statement).run();

	const { results } = await db
		.prepare(
			"SELECT id, status, attention_login, attention_held FROM pre0069_plaid_items ORDER BY id",
		)
		.all();
	expect(results).toEqual([
		{ id: 1, status: "ok", attention_login: 0, attention_held: 0 },
		{ id: 2, status: "needs_attention", attention_login: 0, attention_held: 1 },
		{ id: 3, status: "needs_attention", attention_login: 0, attention_held: 1 },
	]);
});
