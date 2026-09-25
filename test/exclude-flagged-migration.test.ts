import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0004_exclude_flagged.sql?raw";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

/** The migration's backfill statements, without comments (the tests' database already has its column). */
const statements = migration
	.split("\n")
	.filter((line) => !line.startsWith("--"))
	.join("\n")
	.split(";")
	.map((s) => s.trim())
	.filter((s) => s.startsWith("UPDATE"));

const excludedOf = async (rawName: string) =>
	(
		await db
			.prepare(
				"SELECT excluded FROM transactions WHERE raw_name = ? ORDER BY date DESC LIMIT 1",
			)
			.bind(rawName)
			.first<{ excluded: number }>()
	)?.excluded;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("migration 0004: exclude what Jev already flagged (#27)", () => {
	it("excludes transfers and reimbursements Jev flagged before exclusions shipped, and nothing else", async () => {
		await db.batch([
			db.prepare(
				"UPDATE transactions SET flag_transfer = 1 WHERE raw_name = 'VENMO *J RIVERA'",
			),
			db.prepare(
				"UPDATE transactions SET flag_reimbursement = 1 WHERE raw_name = 'TST* CORNER DELI'",
			),
		]);
		const before = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE excluded = 1")
			.first<{ n: number }>();

		for (const sql of statements) await db.prepare(sql).run();

		expect(await excludedOf("VENMO *J RIVERA")).toBe(1);
		const source = await db
			.prepare(
				"SELECT excluded_source FROM transactions WHERE raw_name = 'VENMO *J RIVERA' LIMIT 1",
			)
			.first<{ excluded_source: string | null }>();
		expect(source?.excluded_source).toBe("jev");
		expect(await excludedOf("TST* CORNER DELI")).toBe(1);
		expect(await excludedOf("SQ *LOCAL BAKERY 4432")).toBe(0);
		const venmoAndDeli = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name IN ('VENMO *J RIVERA', 'TST* CORNER DELI') AND excluded = 0",
			)
			.first<{ n: number }>();
		expect(venmoAndDeli?.n).toBe(0);
		const after = await db
			.prepare("SELECT COUNT(*) AS n FROM transactions WHERE excluded = 1")
			.first<{ n: number }>();
		const flagged = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name IN ('VENMO *J RIVERA', 'TST* CORNER DELI')",
			)
			.first<{ n: number }>();
		expect(after?.n).toBe((before?.n ?? 0) + (flagged?.n ?? 0));
	});
});
