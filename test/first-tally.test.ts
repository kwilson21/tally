import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BillSuggestion } from "../src/bills/find";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import {
	isSetUp,
	keepBudgetAnswer,
	keepNightCounts,
	markStroke,
	type PayRecord,
	payAnswerStatement,
	readFirstTally,
	STROKES,
} from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { keepBills } from "../src/first-tally/first-page";

const db = env.DB;

const stored = async () =>
	await db
		.prepare("SELECT value FROM household_settings WHERE key = 'first_tally'")
		.first<{ value: string }>();

/**
 * A pay answer's batch as answerPay writes it: the answer's own change, then the record behind it. The stand-in change
 * is an UPDATE of the record's row, which changes one row whenever the record exists (each test writes one first).
 */
const payBatch = (merchant: string, record: PayRecord) =>
	db.batch([
		db.prepare(
			"UPDATE household_settings SET value = value WHERE key = 'first_tally'",
		),
		payAnswerStatement(db, merchant, record),
	]);

/** A found charge as Possible bills lists it, with a category, for keepBills. */
const found = (
	rawName: string,
	displayName: string,
	amountCents: number,
	categoryId: number,
): BillSuggestion => ({
	rawName,
	bankText: rawName,
	displayName,
	amountCents,
	dueDay: 5,
	categoryId,
	chargeCount: 2,
});

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

describe("the pay answers' record (P125 E)", () => {
	it("keeps each merchant's answer by its key, a key with a quote in it included, and the newest answer for a merchant", async () => {
		await markStroke(db, "bank", "2026-10-10");
		await payBatch('ACME "CORP"', {
			answer: "yes",
			deposits: [{ date: "2026-10-01", cents: 245000 }],
		});
		await payBatch("SIDE GIG", { answer: "no", deposits: [] });
		await payBatch("SIDE GIG", {
			answer: "yes",
			deposits: [{ date: "2026-10-01", cents: 245000 }],
		});
		const record = await readFirstTally(db);
		expect(record?.strokes).toEqual({ bank: "2026-10-10" });
		expect(record?.pay).toEqual({
			'ACME "CORP"': {
				answer: "yes",
				deposits: [{ date: "2026-10-01", cents: 245000 }],
			},
			"SIDE GIG": {
				answer: "yes",
				deposits: [{ date: "2026-10-01", cents: 245000 }],
			},
		});
	});

	it("starts the pay answers on a record that has none yet", async () => {
		await markStroke(db, "bank", null);
		await payBatch("ACME CORP", { answer: "no", deposits: [] });
		expect((await readFirstTally(db))?.pay).toEqual({
			"ACME CORP": { answer: "no", deposits: [] },
		});
	});

	it("writes no record for an answer whose own change touched no row", async () => {
		await markStroke(db, "bank", null);
		await db.batch([
			db.prepare("UPDATE transactions SET flag_income = flag_income WHERE 0"),
			payAnswerStatement(db, "ACME CORP", {
				answer: "yes",
				deposits: [],
			}),
		]);
		expect((await readFirstTally(db))?.pay).toBeUndefined();
	});
});

describe("the bills step's record (P125 E)", () => {
	it("adds each kept bill to the count and the total in the bill's own write, and a refused name adds nothing", async () => {
		const categoryId = (
			await db
				.prepare(
					"SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1",
				)
				.first<{ id: number }>()
		)?.id as number;
		const day = "2026-10-10";
		await keepBills(db, day, [found("KEPT ONE", "Kept One", 1549, categoryId)]);
		await keepBills(db, day, [found("KEPT TWO", "Kept Two", 1199, categoryId)]);
		// The same name as an active bill, in other case and spacing: refused, so the record doesn't move.
		await keepBills(db, day, [
			found("KEPT ONE AGAIN", "kept one ", 1549, categoryId),
		]);
		expect((await readFirstTally(db))?.bills).toEqual({
			kept: 2,
			cents: 2748,
		});
	});

	it("keeps no bills record for a step with nothing kept, and draws the bills stroke with its first day", async () => {
		await keepBills(db, "2026-10-10", []);
		expect((await readFirstTally(db))?.bills).toBeUndefined();
		await markStroke(db, "bills", "2026-10-10");
		await markStroke(db, "bills", "2026-10-12");
		expect((await readFirstTally(db))?.strokes.bills).toBe("2026-10-10");
	});
});
