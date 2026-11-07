import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	keepBudgetStatement,
	markStroke,
	parseFirstTally,
	payAnswerStatement,
	readFirstTally,
} from "../src/db/first-tally";

// The first week's record is JSON stored in household_settings. parseFirstTally is the one place it is read from text:
// a good record comes back as it was, a record whose parts are damaged keeps the parts that are fine, and text that is
// not a record at all is a bug to show, not an empty record (which would send a set-up household back through setup).

const GOOD = {
	strokes: {
		bank: "2026-09-22",
		pay: null,
		bills: "2026-09-23",
		budgets: "2026-09-24",
	},
	budgets: {
		"3": { kind: "suggested", cents: 50000 },
		"4": { kind: "another", cents: 12000 },
		"5": { kind: "skipped", cents: null },
	},
	pay: {
		ACME: { yes: { "11": { date: "2026-09-01", cents: 250000 } }, at: 0 },
	},
	bills: { kept: 2, cents: 14200 },
	reAsk: { bank: "Wells Fargo" },
	waitsForRun: true,
	readyEmailedTo: ["a@example.com"],
	readyPushedTo: ["b@example.com"],
	readyPushedAt: { abc: "2026-09-24T10:00:00Z" },
	heldReadyEmail: {
		abc: {
			mail: { subject: "s", html: "<p>h</p>", text: "t" },
			at: "2026-09-24T10:00:00Z",
		},
	},
	savings: 30000,
};

describe("parseFirstTally", () => {
	it("returns a good record as it was", () => {
		expect(parseFirstTally(JSON.stringify(GOOD))).toEqual(GOOD);
	});

	it("returns the smallest record, and fills the two parts every record has", () => {
		expect(parseFirstTally('{"strokes":{},"budgets":{}}')).toEqual({
			strokes: {},
			budgets: {},
		});
		expect(parseFirstTally("{}")).toEqual({ strokes: {}, budgets: {} });
	});

	it("shows text that is not a record as a bug", () => {
		for (const bad of ["", "nope", "null", "[]", "3", '"x"'])
			expect(() => parseFirstTally(bad), bad).toThrow(/first_tally/);
	});

	it("keeps only the strokes that are real, with a day or null", () => {
		const record = parseFirstTally(
			JSON.stringify({
				strokes: {
					bank: "2026-09-22",
					pay: 5,
					bills: null,
					count: "2026-09-22",
					budgets: [],
				},
				budgets: {},
			}),
		);
		expect(record.strokes).toEqual({ bank: "2026-09-22", bills: null });
	});

	it("keeps only the budget answers that are well formed", () => {
		const record = parseFirstTally(
			JSON.stringify({
				strokes: {},
				budgets: {
					a: { kind: "suggested", cents: 100 },
					b: { kind: "suggested", cents: "100" },
					c: { kind: "another", cents: 1.5 },
					d: { kind: "skipped", cents: 5 },
					e: { kind: "skipped", cents: null },
					f: { kind: "other", cents: 1 },
					g: "x",
				},
			}),
		);
		expect(record.budgets).toEqual({
			a: { kind: "suggested", cents: 100 },
			e: { kind: "skipped", cents: null },
		});
	});

	it("drops a part of the wrong type and keeps the rest", () => {
		const record = parseFirstTally(
			JSON.stringify({
				strokes: { bank: "2026-09-22" },
				budgets: "many",
				pay: [],
				bills: { kept: "2", cents: 1 },
				reAsk: { bank: 3 },
				waitsForRun: false,
				readyEmailedTo: "a@example.com",
				readyPushedTo: ["a@example.com", 4],
				readyPushedAt: { x: 1 },
				savings: "later",
			}),
		);
		expect(record).toEqual({
			strokes: { bank: "2026-09-22" },
			budgets: {},
			readyPushedTo: ["a@example.com"],
			readyPushedAt: {},
		});
	});

	it("keeps savings as a whole number of cents or the word skipped", () => {
		expect(parseFirstTally('{"savings":"skipped"}').savings).toBe("skipped");
		expect(parseFirstTally('{"savings":0}').savings).toBe(0);
		expect(parseFirstTally('{"savings":1.5}').savings).toBeUndefined();
	});

	it("keeps a pay record only with its place and deposits that have a day and cents", () => {
		const record = parseFirstTally(
			JSON.stringify({
				pay: {
					ok: {
						yes: {
							"1": { date: "2026-09-01", cents: 100 },
							"2": { date: 3, cents: 1 },
						},
						at: 1,
					},
					noPlace: { yes: {} },
					notAnObject: 5,
				},
			}),
		);
		expect(record.pay).toEqual({
			ok: { yes: { "1": { date: "2026-09-01", cents: 100 } }, at: 1 },
		});
	});

	it("passes a kept email try through as it is stored, old shape included (the ready email reads it, decision 147)", () => {
		const legacy = { abc: { read: "line", at: "2026-09-24T10:00:00Z" } };
		const record = parseFirstTally(JSON.stringify({ heldReadyEmail: legacy }));
		expect(record.heldReadyEmail).toEqual(legacy);
		expect(
			parseFirstTally('{"heldReadyEmail":[]}').heldReadyEmail,
		).toBeUndefined();
	});
});

describe("the record the writers make is read back whole", () => {
	beforeEach(async () => {
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'first_tally'",
		).run();
	});

	it("keeps every stroke, budget answer and pay answer the real statements wrote", async () => {
		const db = env.DB;
		await markStroke(db, "bank", "2026-09-22");
		await markStroke(db, "pay", null);
		await keepBudgetStatement(db, 3, { kind: "suggested", cents: 50000 }).run();
		await keepBudgetStatement(db, 4, { kind: "skipped", cents: null }).run();
		await payAnswerStatement(db, "ACME", {
			yes: { "11": { date: "2026-09-01", cents: 250000 } },
		}).run();
		await payAnswerStatement(db, "ACME", {
			no: { "12": { date: "2026-09-02", cents: 900 } },
		}).run();
		await payAnswerStatement(db, "OTHER", { no: {} }).run();
		const raw = await db
			.prepare("SELECT value FROM household_settings WHERE key = 'first_tally'")
			.first<{ value: string }>();
		expect(await readFirstTally(db)).toEqual(JSON.parse(raw?.value ?? "null"));
		expect((await readFirstTally(db))?.pay?.ACME).toEqual({
			yes: { "11": { date: "2026-09-01", cents: 250000 } },
			no: { "12": { date: "2026-09-02", cents: 900 } },
			at: 0,
		});
	});
});
