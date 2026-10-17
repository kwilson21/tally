import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import type { FirstTally } from "../src/db/first-tally";
import { readFirstTally, takeBackBankStrokes } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { readSetup, setupView } from "../src/first-tally/setup";

// Home's setup (P125 E, spec §8.8): what the first week shows, from the record, the banks and what Jev still owes.
const TODAY = "2026-10-14";

/**
 * The test database with `hook` awaited just before readSetup's repair writes stroke one (its only INSERT into the record):
 * the disconnect a last bank's removal makes between readSetup's read and that write. prepare is synchronous, so the
 * hook runs inside the statement's run. Every other call forwards to the database.
 */
function raceBeforeBankStroke(hook: () => Promise<unknown>): D1Database {
	const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, prop) {
				if (prop === "bind") {
					return (...values: unknown[]) => racing(target.bind(...values));
				}
				if (prop === "run") {
					return async () => {
						await hook();
						return target.run();
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					return sql.startsWith("INSERT INTO household_settings")
						? racing(statement)
						: statement;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
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
		flagged: [],
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
			[false, "About a minute"],
			[false, "One question"],
			[false, "One question"],
			[false, "One tap, or one at a time"],
			[false, "Later"],
		]);
		expect(before?.steps.some((s) => s.note === "Next")).toBe(false);
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
		expect(reading?.historyIn).toBe(false);
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
			note: "When it's done",
		});
		expect(reading?.steps.slice(1, 4).map((s) => s.note)).toEqual([
			"When it's done",
			"When it's done",
			"When it's done",
		]);
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

	it("promises no time while any connected bank's history is still coming, even when another bank's is in", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const second = {
			name: "Northline",
			lastSyncedAt: "2026-10-13",
			historyCompleteAt: null,
		};
		const reading = view({
			record,
			banks: [BANK, second],
			waiting: 500,
			total: 1500,
			cap: 500,
		});
		expect(reading?.phase).toBe("reading");
		expect(reading?.historyIn).toBe(false);
		expect(reading?.steps.some((s) => s.note === "Tomorrow morning")).toBe(
			false,
		);
	});

	it("counts the connected banks and names the first one's, not the second's", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const two = view({
			record,
			banks: [BANK, { ...BANK, name: "Northline" }],
			waiting: 0,
			total: 10,
		});
		expect(two?.bankCount).toBe(2);
		expect(two?.bankName).toBe("Chase");
		expect(two?.steps[0]?.note).toBe("Chase, linked");
		expect(view({ record, banks: [BANK] })?.bankCount).toBe(1);
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
		expect(fits?.historyIn).toBe(true);
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

	it("a bank linked after the answers takes the questions back, so it reads again and says Tally asks again (#578)", () => {
		// takeBackQuestionStrokes has removed the three strokes; the answers and stroke one stay.
		const record: FirstTally = {
			strokes: { bank: "2026-10-13" },
			budgets: { "3": { kind: "suggested", cents: 65000 } },
		};
		const reading = view({
			record,
			banks: [
				BANK,
				{ name: "Wells Fargo", lastSyncedAt: null, historyCompleteAt: null },
			],
		});
		expect(reading?.phase).toBe("reading");
		expect(reading?.steps[0]).toEqual({
			name: "Link your bank",
			done: true,
			note: "Wells Fargo linked: Tally asks again about pay, bills and budgets.",
		});
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
		expect(
			await readSetup(env.DB, { today: TODAY, cap: 500, flagged: [] }),
		).toBeNull();
	});

	it("draws stroke one today for a connected bank that has none (linked before the first week shipped)", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const setup = await readSetup(env.DB, {
			today: TODAY,
			cap: 500,
			flagged: [],
		});
		// Stroke one is drawn today, so the questions open tomorrow at the earliest: the setup is reading, not set up.
		expect(setup?.phase).toBe("reading");
		expect(setup?.steps[0]?.done).toBe(true);
		const stored = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(JSON.parse(stored?.value ?? "null")?.strokes.bank).toBe(TODAY);
	});

	it("leaves stroke one undrawn when the last bank goes between the read and the repair's write", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		// The banks are read as connected; then every bank goes before the repair writes.
		const racing = raceBeforeBankStroke(() =>
			env.DB.prepare(
				"UPDATE plaid_items SET disconnected_at = datetime('now')",
			).run(),
		);
		await readSetup(racing, { today: TODAY, cap: 500, flagged: [] });
		expect((await readFirstTally(env.DB))?.strokes.bank).toBeUndefined();
	});

	it("reads before-bank setup for a household with no record and no connected bank", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		expect(
			(await readSetup(env.DB, { today: TODAY, cap: 500, flagged: [] }))?.phase,
		).toBe("before");
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

// The fifth day, the answered wait and the re-ask (P125 E, #586, #671, #578). Stroke five is drawn by readSetup on the first
// later household day after the night was kept.
describe("the fifth day (P125 E, #586)", () => {
	const night = { brought: 3, needYou: 1 };
	const budgetsDay = "2026-10-13";
	const later = "2026-10-14";

	/** One household: one connected bank, and the record as given. The bank's history is in, so the setup can be read. */
	const seedHousehold = async (record: unknown) => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare(
				"DELETE FROM household_settings WHERE key = 'first_tally'",
			),
		]);
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id, last_synced_at, history_complete_at) VALUES (?, 'Chase', 'person@example.com', 'item-chase', '2026-10-12T09:00:00Z', '2026-10-12T09:00:00Z')",
		)
			.bind(new Uint8Array([1, 2, 3]))
			.run();
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
		)
			.bind(JSON.stringify(record))
			.run();
	};
	const fourDrawn: FirstTally = {
		strokes: {
			bank: budgetsDay,
			pay: budgetsDay,
			bills: budgetsDay,
			budgets: budgetsDay,
		},
		budgets: {},
	};
	const countOf = async () => (await readFirstTally(env.DB))?.strokes.count;

	it("is not drawn on the budgets stroke's own day, even with the night kept", async () => {
		await seedHousehold({ ...fourDrawn, night });
		await readSetup(env.DB, { today: budgetsDay, cap: 500, flagged: [] });
		expect(await countOf()).toBeUndefined();
	});

	it("is drawn on the first later day, and that day's view carries the night's counts", async () => {
		await seedHousehold({ ...fourDrawn, night });
		const view = await readSetup(env.DB, {
			today: later,
			cap: 500,
			flagged: [],
		});
		expect(await countOf()).toBe(later);
		expect(view?.fifth).toEqual(night);
		expect(view?.steps[4]).toEqual({
			name: "Tomorrow · Tally keeps count on its own",
			done: true,
			note: "Today, Oct 14",
		});
	});

	it("keeps the first day it was drawn, so loading Home again the same day changes nothing", async () => {
		await seedHousehold({ ...fourDrawn, night });
		await readSetup(env.DB, { today: later, cap: 500, flagged: [] });
		const again = await readSetup(env.DB, {
			today: later,
			cap: 500,
			flagged: [],
		});
		expect(await countOf()).toBe(later);
		expect(again?.fifth).toEqual(night);
	});

	it("is Home again from the next household day: no set-up view, and the record stays", async () => {
		await seedHousehold({ ...fourDrawn, night });
		await readSetup(env.DB, { today: later, cap: 500, flagged: [] });
		expect(
			await readSetup(env.DB, { today: "2026-10-15", cap: 500, flagged: [] }),
		).toBeNull();
		expect(await countOf()).toBe(later);
	});

	it("is not drawn while no night has been kept", async () => {
		await seedHousehold(fourDrawn);
		await readSetup(env.DB, { today: later, cap: 500, flagged: [] });
		expect(await countOf()).toBeUndefined();
	});

	it("draws nothing on a household set up before the feature shipped (every stroke with no day, no night)", async () => {
		await seedHousehold({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
			budgets: {},
		});
		expect(
			await readSetup(env.DB, { today: later, cap: 500, flagged: [] }),
		).toBeNull();
	});

	it("is shown by setupView only on the day stroke five is drawn", () => {
		const fifth: FirstTally = {
			strokes: { ...fourDrawn.strokes, count: TODAY },
			budgets: {},
			night,
		};
		expect(view({ record: fifth, banks: [BANK] })?.fifth).toEqual(night);
		const after = {
			...fifth,
			strokes: { ...fifth.strokes, count: "2026-10-13" },
		};
		expect(view({ record: after, banks: [BANK] })).toBeNull();
	});
});

describe("the answered wait (P125 E, #671)", () => {
	const answered: FirstTally = {
		strokes: {
			bank: "2026-10-13",
			pay: "2026-10-13",
			bills: "2026-10-13",
			budgets: "2026-10-13",
		},
		budgets: {},
	};
	const reading = {
		name: "Chase",
		lastSyncedAt: null,
		historyCompleteAt: null,
	};
	const wells = {
		name: "Wells Fargo",
		lastSyncedAt: "2026-10-13",
		historyCompleteAt: "2026-10-13",
	};

	it("says what Tally waits for while one bank reads its history, and promises nothing for tomorrow", () => {
		const v = view({
			record: answered,
			banks: [{ ...BANK, historyCompleteAt: null }],
		});
		expect(v?.phase).toBe("answered");
		expect(v?.answeredWaiting).toBe("once Chase's history is in.");
	});

	it("names the one bank that needs signing in", () => {
		const v = view({
			record: answered,
			banks: [BANK],
			flagged: [{ name: "Chase", reason: "sign-in" }],
		});
		expect(v?.answeredWaiting).toBe("once Chase is signed in again.");
	});

	it("makes no promise beside a bank that stopped updating, and names no wait it cannot give (#671)", () => {
		const v = view({
			record: answered,
			banks: [BANK],
			flagged: [{ name: "Chase", reason: "stale", since: "2026-10-10" }],
		});
		expect(v?.phase).toBe("answered");
		expect(v?.answeredWaiting).toBeNull();
		expect(v?.answeredFlagged).toBe(true);
	});

	it("flags nothing in the answered phase while no bank is flagged", () => {
		expect(
			view({ record: answered, banks: [BANK, wells] })?.answeredFlagged,
		).toBe(false);
	});

	it("names both banks that need signing in", () => {
		const v = view({
			record: answered,
			banks: [BANK, wells],
			flagged: [
				{ name: "Chase", reason: "sign-in" },
				{ name: "Wells Fargo", reason: "sign-in" },
			],
		});
		expect(v?.answeredWaiting).toBe(
			"once Chase and Wells Fargo are signed in again.",
		);
	});

	it("says your banks' history with two banks reading", () => {
		const v = view({
			record: answered,
			banks: [{ ...BANK, historyCompleteAt: null }, reading],
		});
		expect(v?.answeredWaiting).toBe("once your banks' history is in.");
	});

	it("waits for nothing once every bank is in and signed in", () => {
		expect(
			view({ record: answered, banks: [BANK, wells] })?.answeredWaiting,
		).toBeNull();
	});

	it("waits for nothing outside the answered phase", () => {
		const v = view({
			record: { ...answered, strokes: { bank: "2026-10-13" }, budgets: {} },
			banks: [{ ...BANK, historyCompleteAt: null }],
		});
		expect(v?.phase).toBe("reading");
		expect(v?.answeredWaiting).toBeNull();
	});
});

describe("the re-ask note (P125 E, #578)", () => {
	it("says nothing with one bank, even when an answer is kept and a question is undrawn", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13" },
			budgets: { "3": { kind: "suggested", cents: 65000 } },
		};
		expect(view({ record, banks: [BANK] })?.steps[0]?.note).toBe(
			"Chase, linked",
		);
	});

	it("says nothing with two banks when no answer is kept", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const v = view({
			record,
			banks: [
				BANK,
				{ name: "Wells Fargo", lastSyncedAt: null, historyCompleteAt: null },
			],
		});
		expect(v?.steps[0]?.note).toBe("Chase, linked");
	});
});
