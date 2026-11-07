import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import migration from "../migrations/0071_merchant_suggested_names.sql?raw";

const db = env.DB;

// The tests' database already has every migration, so migration 0071 runs here against scratch copies of merchants
// (as it was before, with suggested_name packed one name per line) and of the names table, renamed so they don't
// collide with the real one. Each case below is a row the old code could have left: the backfill keeps what a person
// was shown and what Workers AI was asked, and drops names only where no status needs them (invariants I1 to I3).
afterEach(async () => {
	await db.prepare("DROP TABLE IF EXISTS pre0071_merchants").run();
	await db
		.prepare("DROP TABLE IF EXISTS pre0071_merchant_suggested_names")
		.run();
});

async function runMigrationOnScratch(): Promise<void> {
	const sql = migration
		.split("\n")
		.filter((line) => !line.startsWith("--"))
		.join("\n")
		.replaceAll(/\bmerchants\b/g, "pre0071_merchants")
		.replaceAll(
			/\bmerchant_suggested_names\b/g,
			"pre0071_merchant_suggested_names",
		);
	for (const statement of sql
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean))
		await db.prepare(statement).run();
}

it("migration 0071 moves every packed suggestion into one row per name, and keeps each status a person saw", async () => {
	await db.batch([
		db.prepare(
			`CREATE TABLE pre0071_merchants (
				raw_name TEXT PRIMARY KEY,
				suggested_name TEXT,
				display_name TEXT,
				default_category_id INTEGER,
				suggestion_status TEXT NOT NULL DEFAULT 'none'
					CHECK (suggestion_status IN ('none', 'pending', 'accepted', 'rejected'))
			)`,
		),
		db.prepare(
			`INSERT INTO pre0071_merchants (raw_name, suggested_name, suggestion_status) VALUES
				('none null', NULL, 'none'),
				('asked empty', '', 'none'),
				('asked blanks', ' ', 'none'),
				('none with a stale value', 'Stale', 'none'),
				('pending four lines', 'A
B
C
D', 'pending'),
				('pending blank lines between', '
  Foo

Bar', 'pending'),
				('pending empty value', '', 'pending'),
				('pending null value', NULL, 'pending'),
				('pending blank lines only', '

', 'pending'),
				('pending tab and CR', '	Tabbed
Carriage' || char(13), 'pending'),
				('accepted with a name', 'Zed Cafe', 'accepted'),
				('accepted with nothing', NULL, 'accepted'),
				('rejected with blanks', ' ', 'rejected')`,
		),
	]);

	await runMigrationOnScratch();

	const { results: merchants } = await db
		.prepare(
			"SELECT raw_name, suggestion_status, names_asked FROM pre0071_merchants ORDER BY raw_name",
		)
		.all();
	expect(merchants).toEqual([
		{
			raw_name: "accepted with a name",
			suggestion_status: "accepted",
			names_asked: 0,
		},
		{
			raw_name: "accepted with nothing",
			suggestion_status: "accepted",
			names_asked: 0,
		},
		{ raw_name: "asked blanks", suggestion_status: "none", names_asked: 1 },
		{ raw_name: "asked empty", suggestion_status: "none", names_asked: 1 },
		{ raw_name: "none null", suggestion_status: "none", names_asked: 0 },
		{
			raw_name: "none with a stale value",
			suggestion_status: "none",
			names_asked: 1,
		},
		{
			raw_name: "pending blank lines between",
			suggestion_status: "pending",
			names_asked: 0,
		},
		{
			raw_name: "pending blank lines only",
			suggestion_status: "none",
			names_asked: 1,
		},
		{
			raw_name: "pending empty value",
			suggestion_status: "none",
			names_asked: 1,
		},
		{
			raw_name: "pending four lines",
			suggestion_status: "pending",
			names_asked: 0,
		},
		{
			raw_name: "pending null value",
			suggestion_status: "none",
			names_asked: 0,
		},
		{
			raw_name: "pending tab and CR",
			suggestion_status: "pending",
			names_asked: 0,
		},
		{
			raw_name: "rejected with blanks",
			suggestion_status: "rejected",
			names_asked: 0,
		},
	]);

	const { results: names } = await db
		.prepare(
			"SELECT merchant_key, position, name FROM pre0071_merchant_suggested_names ORDER BY merchant_key, position",
		)
		.all();
	expect(names).toEqual([
		{ merchant_key: "accepted with a name", position: 0, name: "Zed Cafe" },
		{ merchant_key: "pending blank lines between", position: 0, name: "Foo" },
		{ merchant_key: "pending blank lines between", position: 1, name: "Bar" },
		{ merchant_key: "pending four lines", position: 0, name: "A" },
		{ merchant_key: "pending four lines", position: 1, name: "B" },
		{ merchant_key: "pending four lines", position: 2, name: "C" },
		{ merchant_key: "pending tab and CR", position: 0, name: "Tabbed" },
		{ merchant_key: "pending tab and CR", position: 1, name: "Carriage" },
	]);
});

it("migration 0071 drops suggested_name and adds names_asked, defaulting to 0", async () => {
	await db
		.prepare(
			`CREATE TABLE pre0071_merchants (
				raw_name TEXT PRIMARY KEY,
				suggested_name TEXT,
				suggestion_status TEXT NOT NULL DEFAULT 'none'
			)`,
		)
		.run();
	await runMigrationOnScratch();
	const { results } = await db
		.prepare("SELECT name FROM pragma_table_info('pre0071_merchants')")
		.all<{ name: string }>();
	expect(results.map((column) => column.name)).toEqual([
		"raw_name",
		"suggestion_status",
		"names_asked",
	]);
});
