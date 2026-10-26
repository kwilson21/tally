import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { isSetUp, readFirstTally } from "../src/db/first-tally";
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

	it("counts a household with a budget as set up, with its five strokes as 0057 wrote them and no days (#582)", async () => {
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
		// 0057 is history: it still writes the count stroke, which migration 0061 takes out.
		const record = await readFirstTally(db);
		expect(record).toEqual({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
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

// Decision 148: setup is done at the budgets stroke, so the count stroke and the night's counts go (0061). Its one UPDATE
// is replayed as written, after 0057's INSERT, on the records 0057 and a household past its budgets step leave behind.
const fourStrokes = env.TEST_MIGRATIONS.find((item) =>
	item.name.startsWith("0061_first_tally_four_strokes"),
);

describe("migration 0061 first_tally four strokes", () => {
	const replay = async () => {
		if (!fourStrokes) throw new Error("Migration 0061 is missing");
		for (const query of fourStrokes.queries) await db.prepare(query).run();
	};
	const writeRecord = (value: unknown) =>
		db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
			)
			.bind(JSON.stringify(value))
			.run();

	it("is in the migrations, as one UPDATE of the first_tally row", () => {
		expect(fourStrokes).toBeDefined();
		expect(fourStrokes?.queries).toHaveLength(1);
		expect(fourStrokes?.queries[0]).toContain("json_remove");
		expect(fourStrokes?.queries[0]).toContain("'$.strokes.count'");
	});

	it("takes the count stroke, the night and its sync out of a set-up household, and keeps the rest", async () => {
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
		await db
			.prepare(
				`UPDATE household_settings SET value = ? WHERE key = 'first_tally'`,
			)
			.bind(
				JSON.stringify({
					strokes: {
						bank: "2026-10-01",
						pay: "2026-10-02",
						bills: "2026-10-03",
						budgets: "2026-10-04",
						count: "2026-10-05",
					},
					budgets: { "3": { kind: "suggested", cents: 65000 } },
					pay: { "ACME CORP": { yes: {}, at: 0 } },
					bills: { kept: 2, cents: 124000 },
					savings: 15000,
					night: { brought: 3, needYou: 1 },
					nightSync: { brought: 3, on: "2026-10-05", ok: true },
				}),
			)
			.run();
		await replay();
		expect(await readFirstTally(db)).toEqual({
			strokes: {
				bank: "2026-10-01",
				pay: "2026-10-02",
				bills: "2026-10-03",
				budgets: "2026-10-04",
			},
			budgets: { "3": { kind: "suggested", cents: 65000 } },
			pay: { "ACME CORP": { yes: {}, at: 0 } },
			bills: { kept: 2, cents: 124000 },
			savings: 15000,
		});
	});

	it("takes 0057's count stroke out of a household it set up, which stays set up", async () => {
		await writeRecord({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
			budgets: {},
		});
		await replay();
		const record = await readFirstTally(db);
		expect(record).toEqual({
			strokes: { bank: null, pay: null, bills: null, budgets: null },
			budgets: {},
		});
		expect(isSetUp(record)).toBe(true);
	});

	it("leaves a record mid-setup unchanged, its answers and days kept", async () => {
		const record = {
			strokes: { bank: "2026-10-01", pay: "2026-10-02" },
			budgets: { "3": { kind: "skipped", cents: null } },
			pay: { "ACME CORP": { yes: { "7": { amount: 245000 } }, at: 0 } },
			reAsk: { bank: "Wells Fargo" },
		};
		await writeRecord(record);
		await replay();
		expect(await readFirstTally(db)).toEqual(record);
	});
});
