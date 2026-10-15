import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	isSetUp,
	keepBillsStep,
	keepBudgetAnswer,
	keepNightCounts,
	markStroke,
	payAnswerStatement,
	readFirstTally,
	STROKES,
} from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";

const db = env.DB;

const stored = async () =>
	await db
		.prepare("SELECT value FROM household_settings WHERE key = 'first_tally'")
		.first<{ value: string }>();

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
		.run();
});

describe("first_tally record", () => {
	it("has no record until something is written, and is not set up", async () => {
		expect(await readFirstTally(db)).toBeNull();
		expect(isSetUp(null)).toBe(false);
	});

	it("keeps the day each stroke was drawn, and a stroke drawn once keeps its first day", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await markStroke(db, "bank", "2026-10-12");
		await markStroke(db, "pay", "2026-10-11");
		expect(await readFirstTally(db)).toEqual({
			strokes: { bank: "2026-10-10", pay: "2026-10-11" },
			budgets: {},
		});
		expect(isSetUp(await readFirstTally(db))).toBe(false);
	});

	it("draws a stroke with no day, which still counts as drawn", async () => {
		await markStroke(db, "bank", null);
		expect((await readFirstTally(db))?.strokes).toEqual({ bank: null });
	});

	it("is set up once all five strokes are drawn, days or not", async () => {
		expect(STROKES).toEqual(["bank", "pay", "bills", "budgets", "count"]);
		for (const stroke of STROKES) await markStroke(db, stroke, null);
		expect(isSetUp(await readFirstTally(db))).toBe(true);
	});

	it("keeps each budgets answer as it was given, a skip included, and the newest answer for a category", async () => {
		await keepBudgetAnswer(db, 3, { kind: "suggested", cents: 65000 });
		await keepBudgetAnswer(db, 4, { kind: "skipped", cents: null });
		await keepBudgetAnswer(db, 4, { kind: "another", cents: 12000 });
		expect((await readFirstTally(db))?.budgets).toEqual({
			"3": { kind: "suggested", cents: 65000 },
			"4": { kind: "another", cents: 12000 },
		});
	});

	it("keeps the first night's counts beside the strokes and answers", async () => {
		await markStroke(db, "count", "2026-10-13");
		await keepNightCounts(db, { brought: 3, needYou: 1 });
		expect(await readFirstTally(db)).toEqual({
			strokes: { count: "2026-10-13" },
			budgets: {},
			night: { brought: 3, needYou: 1 },
		});
	});

	it("stores the record as one JSON value under first_tally", async () => {
		await markStroke(db, "bank", "2026-10-10");
		expect(await stored()).toEqual({
			value: JSON.stringify({ strokes: { bank: "2026-10-10" }, budgets: {} }),
		});
	});

	it("keeps every field when the writes overlap, since each one changes only its own part", async () => {
		await Promise.all([
			keepBudgetAnswer(db, 3, { kind: "suggested", cents: 65000 }),
			keepBudgetAnswer(db, 4, { kind: "skipped", cents: null }),
			markStroke(db, "bank", "2026-10-13"),
			keepNightCounts(db, { brought: 3, needYou: 1 }),
		]);
		expect(await readFirstTally(db)).toEqual({
			strokes: { bank: "2026-10-13" },
			budgets: {
				"3": { kind: "suggested", cents: 65000 },
				"4": { kind: "skipped", cents: null },
			},
			night: { brought: 3, needYou: 1 },
		});
	});

	it("is gone after the demo's nightly reset, so the demo never shows setup", async () => {
		for (const stroke of STROKES) await markStroke(db, stroke, "2026-10-01");
		await keepNightCounts(db, { brought: 1, needYou: 0 });
		expect(await readFirstTally(db)).not.toBeNull();
		await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
		expect(await readFirstTally(db)).toBeNull();
		expect(await stored()).toBeNull();
	});
});

describe("the pay answers and the bills step's record (P125 E)", () => {
	it("keeps each merchant's answer by its key, a key with a quote in it included, and the newest answer for a merchant", async () => {
		await db
			.prepare(
				`INSERT INTO household_settings (key, value) VALUES ('first_tally', '{"strokes":{"bank":"2026-10-10"}}')`,
			)
			.run();
		await payAnswerStatement(db, 'ACME "CORP"', "yes").run();
		await payAnswerStatement(db, "SIDE GIG", "no").run();
		await payAnswerStatement(db, "SIDE GIG", "yes").run();
		const record = await readFirstTally(db);
		expect(record?.strokes).toEqual({ bank: "2026-10-10" });
		expect(record?.pay).toEqual({ 'ACME "CORP"': "yes", "SIDE GIG": "yes" });
	});

	it("starts the pay answers on a record that has none yet", async () => {
		await payAnswerStatement(db, "ACME CORP", "no").run();
		expect((await readFirstTally(db))?.pay).toEqual({ "ACME CORP": "no" });
	});

	it("draws the bills stroke and records what the step kept in one write, adding each Keep to the count and the total", async () => {
		await keepBillsStep(db, { kept: 2, cents: 3000 }, "2026-10-10");
		await keepBillsStep(db, { kept: 1, cents: 1500 }, "2026-10-12");
		const record = await readFirstTally(db);
		expect(record?.strokes.bills).toBe("2026-10-10");
		expect(record?.bills).toEqual({ kept: 3, cents: 4500 });
	});

	it("records a Keep without drawing the stroke when no day is given", async () => {
		await keepBillsStep(db, { kept: 1, cents: 1000 });
		const record = await readFirstTally(db);
		expect(record?.strokes.bills).toBeUndefined();
		expect(record?.bills).toEqual({ kept: 1, cents: 1000 });
	});

	it("draws an empty bills step with nothing kept", async () => {
		await keepBillsStep(db, { kept: 0, cents: 0 }, "2026-10-10");
		const record = await readFirstTally(db);
		expect(record?.strokes.bills).toBe("2026-10-10");
		expect(record?.bills).toEqual({ kept: 0, cents: 0 });
	});
});
