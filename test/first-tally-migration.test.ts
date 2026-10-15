import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { isSetUp, readFirstTally, STROKES } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

const setupMigration = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0057_first_tally_setup"),
);
// The ALTER-free data migration: its one INSERT replays as written, which is safe to run again (ON CONFLICT).
const SETUP = (setupMigration?.queries ?? []).find((query) =>
	query.includes("INSERT INTO household_settings"),
);

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	await db.batch([
		db.prepare("DELETE FROM budget_amounts"),
		db.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
	]);
});

describe("migration 0056 plaid_items.history_complete_at", () => {
	it("adds the nullable column", async () => {
		const { results } = await db
			.prepare("PRAGMA table_info(plaid_items)")
			.all<{ name: string; notnull: number }>();
		const column = results.find((row) => row.name === "history_complete_at");
		expect(column).toBeDefined();
		expect(column?.notnull).toBe(0);
	});
});

describe("migration 0057 first_tally setup", () => {
	it("is in the migrations, with its one data statement", () => {
		expect(setupMigration).toBeDefined();
		expect(SETUP).toBeDefined();
	});

	it("leaves a household with no budget not set up", async () => {
		if (!SETUP) throw new Error("Migration 0057 insert is missing");
		await db.prepare(SETUP).run();
		expect(await readFirstTally(db)).toBeNull();
	});

	it("counts a household with a budget as set up, with all five strokes and no days (#582)", async () => {
		if (!SETUP) throw new Error("Migration 0057 insert is missing");
		const category = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, '2026-09', 50000)",
			)
			.bind(category)
			.run();
		await db.prepare(SETUP).run();
		const record = await readFirstTally(db);
		expect(record).toEqual({
			strokes: Object.fromEntries(STROKES.map((stroke) => [stroke, null])),
			budgets: {},
		});
		expect(isSetUp(record)).toBe(true);
	});

	it("leaves a first_tally record that already exists alone", async () => {
		if (!SETUP) throw new Error("Migration 0057 insert is missing");
		const category = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		await db
			.prepare(
				"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (?, '2026-09', 50000)",
			)
			.bind(category)
			.run();
		await db
			.prepare(
				'INSERT INTO household_settings (key, value) VALUES (\'first_tally\', \'{"strokes":{"bank":"2026-10-01"},"budgets":{}}\')',
			)
			.run();
		await db.prepare(SETUP).run();
		expect(await readFirstTally(db)).toEqual({
			strokes: { bank: "2026-10-01" },
			budgets: {},
		});
	});
});
