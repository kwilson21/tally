import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import migration from "../migrations/0010_disconnected_status.sql?raw";

const db = env.DB;

// The tests' database already has every migration, so migration 0010 runs here against scratch copies of
// plaid_items and accounts as they were before it, filled with rows.
afterEach(async () => {
	await db.batch([
		db.prepare("DROP TABLE IF EXISTS pre0010_accounts"),
		db.prepare("DROP TABLE IF EXISTS pre0010_plaid_items"),
	]);
});

it("migration 0010 keeps every bank, account, link and status in a populated database", async () => {
	await db.batch([
		db.prepare(
			`CREATE TABLE pre0010_plaid_items (
				id INTEGER PRIMARY KEY,
				access_token_encrypted BLOB NOT NULL,
				institution_name TEXT NOT NULL,
				sync_cursor TEXT,
				status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'needs_attention')),
				linked_by TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				plaid_item_id TEXT,
				sync_locked_until TEXT,
				sync_lock_id TEXT
			)`,
		),
		db.prepare(
			`CREATE TABLE pre0010_accounts (
				id INTEGER PRIMARY KEY,
				plaid_item_id INTEGER REFERENCES pre0010_plaid_items(id),
				name TEXT NOT NULL
			)`,
		),
		db.prepare(
			"INSERT INTO pre0010_plaid_items (id, access_token_encrypted, institution_name, status, linked_by) VALUES (1, X'01', 'Fine Bank', 'ok', 'a'), (2, X'02', 'Broken Bank', 'needs_attention', 'b')",
		),
		db.prepare(
			"INSERT INTO pre0010_accounts (id, plaid_item_id, name) VALUES (10, 1, 'Checking'), (11, 2, 'Card')",
		),
	]);

	const sql = migration
		.split("\n")
		.filter((line) => !line.startsWith("--"))
		.join("\n")
		.replaceAll(/\bplaid_items\b/g, "pre0010_plaid_items");
	for (const statement of sql
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean))
		await db.prepare(statement).run();

	const { results: items } = await db
		.prepare(
			"SELECT id, institution_name, status, hex(access_token_encrypted) token, disconnected_at FROM pre0010_plaid_items ORDER BY id",
		)
		.all();
	expect(items).toEqual([
		{
			id: 1,
			institution_name: "Fine Bank",
			status: "ok",
			token: "01",
			disconnected_at: null,
		},
		{
			id: 2,
			institution_name: "Broken Bank",
			status: "needs_attention",
			token: "02",
			disconnected_at: null,
		},
	]);
	const { results: accounts } = await db
		.prepare(
			"SELECT a.id, p.institution_name FROM pre0010_accounts a JOIN pre0010_plaid_items p ON p.id = a.plaid_item_id ORDER BY a.id",
		)
		.all();
	expect(accounts).toEqual([
		{ id: 10, institution_name: "Fine Bank" },
		{ id: 11, institution_name: "Broken Bank" },
	]);
	const { results: fks } = await db
		.prepare(
			"SELECT \"table\" FROM pragma_foreign_key_list('pre0010_accounts')",
		)
		.all();
	expect(fks).toEqual([{ table: "pre0010_plaid_items" }]);
	expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
		[],
	);
});
