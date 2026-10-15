import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	isSetUp,
	keepBudgetAnswer,
	keepNightCounts,
	markStroke,
	readFirstTally,
	STROKES,
	writeFirstTally,
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

	it("writes the whole record as one JSON value under first_tally", async () => {
		await writeFirstTally(db, {
			strokes: { bank: "2026-10-10" },
			budgets: {},
		});
		expect(await stored()).toEqual({
			value: JSON.stringify({ strokes: { bank: "2026-10-10" }, budgets: {} }),
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
