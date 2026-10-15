import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import type { FirstTally } from "../src/db/first-tally";
import { takeBackBankStrokes } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { readSetup, setupView } from "../src/first-tally/setup";

// Home's setup (P125 E, spec §8.8): what the first week shows, from the record, the banks and what Jev still owes.
const TODAY = "2026-10-14";
const BANK = {
	name: "Chase",
	lastSyncedAt: "2026-10-13",
	historyCompleteAt: "2026-10-13",
};
const ALL_DRAWN: FirstTally = {
	strokes: { bank: null, pay: null, bills: null, budgets: null, count: null },
	budgets: {},
};

const view = (input: Partial<Parameters<typeof setupView>[0]> = {}) =>
	setupView({
		record: null,
		banks: [],
		waiting: 0,
		total: 0,
		cap: 500,
		today: TODAY,
		...input,
	});

describe("setupView: which setup state Home shows", () => {
	it("shows nothing once all five strokes are drawn, whatever the day", () => {
		expect(view({ record: ALL_DRAWN, banks: [BANK] })).toBeNull();
	});

	it("is before a bank with no connected bank, and draws no strokes", () => {
		const before = view();
		expect(before?.phase).toBe("before");
		expect(before?.drawn).toBe(0);
		expect(before?.bankName).toBeNull();
		expect(before?.steps.map((s) => [s.done, s.note])).toEqual([
			[false, "Next"],
			[false, "One question"],
			[false, "One question"],
			[false, "One tap, or one at a time"],
			[false, "Later"],
		]);
	});

	it("ignores a stroke one that is still drawn when no bank is connected (the disconnect retake)", () => {
		const record: FirstTally = { ...ALL_DRAWN, strokes: { bank: TODAY } };
		expect(view({ record })?.phase).toBe("before");
	});

	it("reads the import while the questions are shut, on the day stroke one is drawn", () => {
		const record: FirstTally = { strokes: { bank: TODAY }, budgets: {} };
		const reading = view({
			record,
			banks: [{ ...BANK, historyCompleteAt: null }],
		});
		expect(reading?.phase).toBe("reading");
		expect(reading?.drawn).toBe(1);
		expect(reading?.bankName).toBe("Chase");
		expect(reading?.steps[0]).toEqual({
			name: "Link your bank",
			done: true,
			note: "Chase, linked",
		});
		expect(reading?.steps[1]).toEqual({
			name: "Your pay",
			done: false,
			note: "Tomorrow morning",
		});
		expect(reading?.steps[4]?.note).toBe("Later");
	});

	it("says the import fits one night when what Jev owes fits the day's cap", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const fits = view({
			record,
			banks: [BANK],
			waiting: 500,
			total: 1500,
			cap: 500,
		});
		expect(fits?.phase).toBe("reading");
		expect(fits?.fitsOneNight).toBe(true);
		const catchUp = view({
			record,
			banks: [BANK],
			waiting: 600,
			total: 1500,
			cap: 500,
		});
		expect(catchUp?.fitsOneNight).toBe(false);
		expect(catchUp?.sorted).toBe(900);
		expect(catchUp?.total).toBe(1500);
	});

	it("is ready once the gate is open: every bank synced and its history in, and nothing waiting", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const ready = view({ record, banks: [BANK], waiting: 0, total: 362 });
		expect(ready?.phase).toBe("ready");
		expect(ready?.sorted).toBe(362);
		expect(ready?.steps[1]?.note).toBe("Next");
	});

	it("stays in reading while a bank's history is still coming", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		expect(
			view({ record, banks: [{ ...BANK, historyCompleteAt: null }], total: 10 })
				?.phase,
		).toBe("reading");
	});

	it("gives the catch-up lines no time: an import bigger than one night says 'When it's done', as the status does", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const catchUp = view({
			record,
			banks: [BANK],
			waiting: 600,
			total: 1500,
			cap: 500,
		});
		expect(catchUp?.fitsOneNight).toBe(false);
		expect(catchUp?.steps.slice(1).map((s) => s.note)).toEqual([
			"When it's done",
			"When it's done",
			"When it's done",
			"Later",
		]);
	});

	it("keeps 'Tomorrow morning' on the lines when the import fits one night", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const fits = view({ record, banks: [BANK], waiting: 500, cap: 500 });
		expect(fits?.steps.slice(1).map((s) => s.note)).toEqual([
			"Tomorrow morning",
			"Tomorrow morning",
			"Tomorrow morning",
			"Later",
		]);
	});

	it("says Next on the first line not drawn once the questions are open", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13", pay: "2026-10-13" },
			budgets: {},
		};
		const ready = view({ record, banks: [BANK], waiting: 0, total: 362 });
		expect(ready?.phase).toBe("ready");
		expect(ready?.steps).toEqual([
			{ name: "Link your bank", done: true, note: "Chase, linked" },
			{ name: "Your pay", done: true, note: "Oct 13" },
			{ name: "Your bills", done: false, note: "Next" },
			{
				name: "Your budgets",
				done: false,
				note: "One tap, or one at a time",
			},
			{
				name: "Tomorrow · Tally keeps count on its own",
				done: false,
				note: "Later",
			},
		]);
	});

	it("is answered once pay, bills and budgets are drawn: the count line waits for the night, and no line says Next", () => {
		const record: FirstTally = {
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: {},
		};
		const answered = view({ record, banks: [BANK], waiting: 0, total: 362 });
		expect(answered?.phase).toBe("answered");
		expect(answered?.drawn).toBe(4);
		expect(answered?.steps[4]).toEqual({
			name: "Tomorrow · Tally keeps count on its own",
			done: false,
			note: "Later",
		});
		expect(answered?.steps.some((s) => s.note === "Next")).toBe(false);
	});

	it("stays answered while a newly linked bank is read, since the three answers are kept", () => {
		const record: FirstTally = {
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: {},
		};
		expect(
			view({ record, banks: [{ ...BANK, historyCompleteAt: null }] })?.phase,
		).toBe("answered");
	});

	it("names the done lines by their day, and an undated stroke has no day", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13", pay: "2026-10-13", bills: null },
			budgets: {},
		};
		const partial = view({ record, banks: [BANK] });
		expect(partial?.drawn).toBe(3);
		expect(partial?.steps[1]).toEqual({
			name: "Your pay",
			done: true,
			note: "Oct 13",
		});
		expect(partial?.steps[2]?.done).toBe(true);
		expect(partial?.steps[2]?.note).toBe("");
	});
});

describe("readSetup", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'first_tally'",
		).run();
	});

	it("reads no setup for a household whose record is all five strokes", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
		)
			.bind(JSON.stringify(ALL_DRAWN))
			.run();
		expect(await readSetup(env.DB, { today: TODAY, cap: 500 })).toBeNull();
	});

	it("draws stroke one today for a connected bank that has none (linked before the first week shipped)", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const setup = await readSetup(env.DB, { today: TODAY, cap: 500 });
		// Stroke one is drawn today, so the questions open tomorrow at the earliest: the setup is reading, not set up.
		expect(setup?.phase).toBe("reading");
		expect(setup?.steps[0]?.done).toBe(true);
		const stored = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(JSON.parse(stored?.value ?? "null")?.strokes.bank).toBe(TODAY);
	});

	it("reads before-bank setup for a household with no record and no connected bank", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		expect((await readSetup(env.DB, { today: TODAY, cap: 500 }))?.phase).toBe(
			"before",
		);
	});
});

describe("takeBackBankStrokes", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'first_tally'",
		).run();
	});

	const store = (value: FirstTally) =>
		env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
			.bind(JSON.stringify(value))
			.run();
	const read = async () =>
		JSON.parse(
			(
				await env.DB.prepare(
					"SELECT value FROM household_settings WHERE key = 'first_tally'",
				).first<{
					value: string;
				}>()
			)?.value ?? "null",
		) as FirstTally | null;
	const lastBank = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id;

	it("takes strokes one to four back when the last connected bank goes, and keeps the budget answers", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
		).run();
		const onlyId =
			(
				await env.DB.prepare("SELECT MIN(id) AS id FROM plaid_items").first<{
					id: number;
				}>()
			)?.id ?? 0;
		await store({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: { "7": { kind: "suggested", cents: 65000 } },
		});
		await env.DB.batch([takeBackBankStrokes(env.DB, onlyId)]);
		expect(await read()).toEqual({
			strokes: {},
			budgets: { "7": { kind: "suggested", cents: 65000 } },
		});
	});

	it("keeps the strokes while another bank stays connected", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const id = await lastBank();
		const record = { strokes: { bank: "2026-10-13" }, budgets: {} };
		await store(record);
		await env.DB.batch([takeBackBankStrokes(env.DB, id ?? 0)]);
		expect(await read()).toEqual(record);
	});

	it("leaves a set-up household alone, including one set up before the feature (null days)", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		await store(ALL_DRAWN);
		await env.DB.batch([takeBackBankStrokes(env.DB, 999)]);
		expect(await read()).toEqual(ALL_DRAWN);
	});
});
