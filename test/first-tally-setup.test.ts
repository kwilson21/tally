import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { bankSyncs } from "../src/db/accounts";
import type { FirstTally } from "../src/db/first-tally";
import { readFirstTally, takeBackBankStrokes } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { readSetup, setupView, storedTimeMs } from "../src/first-tally/setup";
import { flaggedBanks, homeBankNotice } from "../src/stale-bank";

// Home's setup (P125 E, spec §8.8): what the first week shows, from the record, the banks and what Jev still owes.
const TODAY = "2026-10-14";
/** Noon on TODAY, in UTC: the clock the sort's "recent" and "over an hour" are read against. */
const NOW = Date.parse("2026-10-14T12:00:00Z");

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
	id: 1,
	name: "Chase",
	linkedAt: "2026-10-13 09:00:00",
	lastSyncedAt: "2026-10-13",
	historyCompleteAt: "2026-10-13",
};
/** A bank whose history came in half an hour before NOW: the sort is recent. */
const RECENT = { ...BANK, historyCompleteAt: "2026-10-14 11:30:00" };
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
		today: TODAY,
		nowMs: NOW,
		timeZone: "America/New_York",
		...input,
	});

describe("setupView: which setup state Home shows", () => {
	it("gives the reading screen the daily run's time in the zone it is given, and no wait until part 2 sets one (decision 150)", () => {
		expect(view({ banks: [BANK] })?.runTime).toBe("5 AM");
		expect(view({ banks: [BANK], timeZone: "Europe/London" })?.runTime).toBe(
			"10 AM",
		);
		expect(view({ banks: [BANK] })?.waitsForRun).toBe(false);
	});

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
			note: "After sorting",
		});
		expect(reading?.steps.slice(1, 4).map((s) => s.note)).toEqual([
			"After sorting",
			"After sorting",
			"After sorting",
		]);
		expect(reading?.steps[4]?.note).toBe("Later");
	});

	it("is sorting once every history is in and something waits, counting the sorted ones (decision 146)", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const sorting = view({
			record,
			banks: [RECENT],
			waiting: 500,
			total: 1500,
		});
		expect(sorting?.phase).toBe("reading");
		expect(sorting?.sorting).toBe(true);
		expect(sorting?.slow).toBe(false);
		expect(sorting?.sorted).toBe(1000);
		expect(sorting?.total).toBe(1500);
		expect(sorting?.refreshes).toBe(true);
	});

	it("is slow once the newest bank's history came in over an hour ago, and then stops refreshing", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const slow = view({
			record,
			banks: [{ ...RECENT, historyCompleteAt: "2026-10-14 10:30:00" }],
			waiting: 500,
			total: 1500,
		});
		expect(slow?.sorting).toBe(true);
		expect(slow?.slow).toBe(true);
		expect(slow?.refreshes).toBe(false);
	});

	it("refreshes while a bank was linked in the last hour, even with its history still coming", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const linking = view({
			record,
			banks: [
				{ ...BANK, linkedAt: "2026-10-14 11:30:00", historyCompleteAt: null },
			],
			total: 10,
		});
		expect(linking?.phase).toBe("reading");
		expect(linking?.sorting).toBe(false);
		expect(linking?.refreshes).toBe(true);
	});

	it("stops refreshing once nothing has been linked or read for an hour", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const quiet = view({
			record,
			banks: [
				{ ...BANK, linkedAt: "2026-10-14 09:00:00", historyCompleteAt: null },
			],
			total: 10,
		});
		expect(quiet?.refreshes).toBe(false);
	});

	it("never counts a missing or unreadable time as recent", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const unknown = view({
			record,
			banks: [{ ...BANK, linkedAt: null, historyCompleteAt: null }],
			total: 10,
		});
		expect(unknown?.refreshes).toBe(false);
		const garbled = view({
			record,
			banks: [{ ...BANK, linkedAt: "last Tuesday", historyCompleteAt: null }],
			total: 10,
		});
		expect(garbled?.refreshes).toBe(false);
	});

	it("does not refresh for a recent bank that is still loading when it is flagged, since nothing is moving (decision 146)", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const loading = {
			...BANK,
			linkedAt: "2026-10-14 11:30:00",
			historyCompleteAt: null,
		};
		// Each bank's flag is the one the caller read for its row (flagged, by id): the same bank, flagged or not.
		const needsSignIn = view({
			record,
			banks: [loading],
			flagged: [{ id: 1, name: "Chase", reason: "sign-in" }],
			total: 10,
		});
		expect(needsSignIn?.phase).toBe("reading");
		expect(needsSignIn?.refreshes).toBe(false);
		const stopped = view({
			record,
			banks: [{ ...loading, lastSyncedAt: "2026-10-10" }],
			flagged: [{ id: 1, name: "Chase", reason: "stale", since: "2026-10-10" }],
			total: 10,
		});
		expect(stopped?.refreshes).toBe(false);
		// The same bank, nothing flagging it: it refreshes.
		expect(view({ record, banks: [loading], total: 10 })?.refreshes).toBe(true);
	});

	it("refreshes while one bank is flagged and another is still loading and healthy", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const loading = {
			...BANK,
			linkedAt: "2026-10-14 11:30:00",
			historyCompleteAt: null,
		};
		const both = view({
			record,
			banks: [loading, { ...loading, id: 2, name: "Wells Fargo" }],
			flagged: [{ id: 1, name: "Chase", reason: "sign-in" }],
			total: 10,
		});
		expect(both?.refreshes).toBe(true);
	});

	it("refreshes for a healthy bank still loading when a flagged bank has the same name: each bank's flag is its own (decision 146)", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const loading = {
			...BANK,
			linkedAt: "2026-10-14 11:30:00",
			historyCompleteAt: null,
		};
		// Two banks named Chase: the flag is the first row's, so the second, healthy and still loading, refreshes.
		const twoChases = view({
			record,
			banks: [loading, { ...loading, id: 2 }],
			flagged: [{ id: 1, name: "Chase", reason: "sign-in" }],
			total: 10,
		});
		expect(twoChases?.refreshes).toBe(true);
		// The flag on the second row alone: the first, healthy and still loading, refreshes.
		const flaggedSecond = view({
			record,
			banks: [loading, { ...loading, id: 2 }],
			flagged: [{ id: 2, name: "Chase", reason: "sign-in" }],
			total: 10,
		});
		expect(flaggedSecond?.refreshes).toBe(true);
		// Both flagged: nothing is moving, so nothing refreshes.
		const bothFlagged = view({
			record,
			banks: [loading, { ...loading, id: 2 }],
			flagged: [
				{ id: 1, name: "Chase", reason: "sign-in" },
				{ id: 2, name: "Chase", reason: "sign-in" },
			],
			total: 10,
		});
		expect(bothFlagged?.refreshes).toBe(false);
	});

	it("refreshes while the sort runs once every history is in, even with a flagged bank (decision 146)", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const sorting = view({
			record,
			banks: [
				{ ...RECENT, lastSyncedAt: "2026-10-10" },
				{ ...RECENT, id: 2, name: "Wells Fargo" },
			],
			flagged: [{ id: 1, name: "Chase", reason: "stale", since: "2026-10-10" }],
			waiting: 500,
			total: 1500,
		});
		expect(sorting?.sorting).toBe(true);
		expect(sorting?.slow).toBe(false);
		expect(sorting?.refreshes).toBe(true);
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
			id: 2,
			name: "Northline",
			linkedAt: "2026-10-13 09:00:00",
			lastSyncedAt: "2026-10-13",
			historyCompleteAt: null,
		};
		const reading = view({
			record,
			banks: [BANK, second],
			waiting: 500,
			total: 1500,
		});
		expect(reading?.phase).toBe("reading");
		expect(reading?.historyIn).toBe(false);
		expect(reading?.steps.slice(1).map((s) => s.note)).toEqual([
			"After sorting",
			"After sorting",
			"After sorting",
			"Later",
		]);
	});

	it("counts the connected banks and names the first one's, not the second's", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const two = view({
			record,
			banks: [BANK, { ...BANK, id: 2, name: "Northline" }],
			waiting: 0,
			total: 10,
		});
		expect(two?.bankCount).toBe(2);
		expect(two?.bankName).toBe("Chase");
		expect(two?.steps[0]?.note).toBe("2 banks, linked");
		expect(view({ record, banks: [BANK] })?.bankCount).toBe(1);
		expect(view({ record, banks: [BANK] })?.steps[0]?.note).toBe(
			"Chase, linked",
		);
	});

	it("says '2 banks, linked' on step one in the ready phase too, and keeps the first bank's name in the done note", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const ready = view({
			record,
			banks: [BANK, { ...BANK, id: 2, name: "Northline" }],
			waiting: 0,
			total: 10,
		});
		expect(ready?.phase).toBe("ready");
		expect(ready?.steps[0]?.note).toBe("2 banks, linked");
	});

	it("stays in reading while a bank's history is still coming", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		expect(
			view({ record, banks: [{ ...BANK, historyCompleteAt: null }], total: 10 })
				?.phase,
		).toBe("reading");
	});

	it("reads 'After sorting' on lines two to four while the import is read, and 'Later' on the fifth (decision 146)", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const reading = view({ record, banks: [BANK], waiting: 600, total: 1500 });
		expect(reading?.steps.slice(1).map((s) => s.note)).toEqual([
			"After sorting",
			"After sorting",
			"After sorting",
			"Later",
		]);
	});

	it("gives no time on the lines even when every history is in and the sort is under way", () => {
		const record: FirstTally = { strokes: { bank: "2026-10-13" }, budgets: {} };
		const sorting = view({
			record,
			banks: [RECENT],
			waiting: 500,
			total: 1500,
		});
		expect(sorting?.steps.slice(1).map((s) => s.note)).toEqual([
			"After sorting",
			"After sorting",
			"After sorting",
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
		// takeBackQuestionStrokes has removed the three strokes and set reAsk; the answers and stroke one stay.
		const record: FirstTally = {
			strokes: { bank: "2026-10-13" },
			budgets: { "3": { kind: "suggested", cents: 65000 } },
			reAsk: { bank: "Wells Fargo" },
		};
		const reading = view({
			record,
			banks: [
				BANK,
				{
					name: "Wells Fargo",
					linkedAt: "2026-10-13 09:00:00",
					lastSyncedAt: null,
					historyCompleteAt: null,
					id: 2,
				},
			],
		});
		expect(reading?.phase).toBe("reading");
		// The re-ask note is its own line under step one (#714), so step one's note stays the bank's own.
		expect(reading?.steps[0]).toEqual({
			name: "Link your bank",
			done: true,
			note: "2 banks, linked",
			reAsk:
				"Wells Fargo linked: Tally asks again about pay, bills and budgets.",
		});
	});

	it("names the bank in the re-ask note with the marker's name, quotes and all", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13" },
			budgets: {},
			reAsk: { bank: `O'Brien "Savings"` },
		};
		const reading = view({
			record,
			banks: [
				BANK,
				{
					name: "Chase",
					linkedAt: "2026-10-13 09:00:00",
					lastSyncedAt: null,
					historyCompleteAt: null,
					id: 2,
				},
			],
		});
		expect(reading?.steps[0]?.note).toBe("2 banks, linked");
		expect(reading?.steps[0]?.reAsk).toBe(
			`O'Brien "Savings" linked: Tally asks again about pay, bills and budgets.`,
		);
	});

	it("shows no re-ask note for two banks linked before the questions open, with pay drawn: no marker, so no note", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13", pay: "2026-10-13" },
			budgets: {},
		};
		const early = view({
			record,
			banks: [
				BANK,
				{
					name: "Wells Fargo",
					linkedAt: "2026-10-13 09:00:00",
					lastSyncedAt: null,
					historyCompleteAt: null,
					id: 2,
				},
			],
		});
		expect(early?.steps[0]).toEqual({
			name: "Link your bank",
			done: true,
			note: "2 banks, linked",
		});
	});

	it("shows no re-ask note for a two-bank record mid pay step: the answers alone are not a retake", () => {
		const record: FirstTally = {
			strokes: { bank: "2026-10-13" },
			budgets: {},
			pay: {
				"ACME CORP PAYROLL": {
					yes: { "1": { date: "2026-10-03", cents: 245000 } },
					at: 0,
				},
			},
		};
		const midPay = view({
			record,
			banks: [
				BANK,
				{
					name: "Wells Fargo",
					linkedAt: "2026-10-13 09:00:00",
					lastSyncedAt: null,
					historyCompleteAt: null,
					id: 2,
				},
			],
		});
		expect(midPay?.steps[0]?.note).toBe("2 banks, linked");
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

describe("storedTimeMs: the times the setup reads (decision 146)", () => {
	it("reads D1's UTC 'YYYY-MM-DD HH:MM:SS' as that UTC moment", () => {
		expect(storedTimeMs("2026-10-14 11:30:00")).toBe(
			Date.parse("2026-10-14T11:30:00Z"),
		);
	});

	it("reads an ISO time that ends in Z", () => {
		expect(storedTimeMs("2026-10-14T11:30:00Z")).toBe(
			Date.parse("2026-10-14T11:30:00Z"),
		);
		expect(storedTimeMs("2026-10-14T11:30:00.250Z")).toBe(
			Date.parse("2026-10-14T11:30:00.250Z"),
		);
	});

	it("reads a bare date as midnight UTC", () => {
		expect(storedTimeMs("2026-10-13")).toBe(Date.parse("2026-10-13T00:00:00Z"));
	});

	it("is null for no time, and for anything else, so it never counts as recent", () => {
		expect(storedTimeMs(null)).toBeNull();
		expect(storedTimeMs("")).toBeNull();
		expect(storedTimeMs("last Tuesday")).toBeNull();
		expect(storedTimeMs("2026-10-14T11:30:00")).toBeNull();
		expect(storedTimeMs("2026-13-45 99:99:99")).toBeNull();
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
		expect(await readSetup(env.DB, { today: TODAY, flagged: [] })).toBeNull();
	});

	it("draws stroke one today for a connected bank that has none (linked before the first week shipped)", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const setup = await readSetup(env.DB, {
			today: TODAY,
			flagged: [],
		});
		// Stroke one is drawn today, but the setup is reading, not set up: the connected banks' 90-day history isn't in yet
		// (the demo seed's banks carry no history mark), so the questions stay shut until it is.
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
		await readSetup(racing, { today: TODAY, flagged: [] });
		expect((await readFirstTally(env.DB))?.strokes.bank).toBeUndefined();
	});

	/** Two banks named Chase, linked just now, both still loading their history: each row is one `status` (plaid_items). */
	const twoChases = async (statuses: string[]) => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		for (const [i, status] of statuses.entries()) {
			await env.DB.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id, status, last_synced_at, created_at) VALUES (?, 'Chase', 'person@example.com', ?, ?, '2026-10-13 09:00:00', datetime('now'))",
			)
				.bind(new Uint8Array([1, 2, 3]), `item-chase-${i}`, status)
				.run();
		}
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
		)
			.bind(JSON.stringify({ strokes: { bank: TODAY }, budgets: {} }))
			.run();
	};

	/** The flags Home reads for the rows now, as its setup is given them: bankSyncs, then flaggedBanks, one list. */
	const homeFlags = async () => flaggedBanks(await bankSyncs(env.DB), TODAY);

	it("refreshes for a healthy bank still loading when another bank with the same name needs signing in (each row's own flag)", async () => {
		await twoChases(["needs_attention", "ok"]);
		const setup = await readSetup(env.DB, {
			today: TODAY,
			flagged: await homeFlags(),
		});
		expect(setup?.phase).toBe("reading");
		expect(setup?.refreshes).toBe(true);
	});

	it("stops refreshing when the only bank still loading needs signing in", async () => {
		await twoChases(["needs_attention"]);
		const setup = await readSetup(env.DB, {
			today: TODAY,
			flagged: await homeFlags(),
		});
		expect(setup?.phase).toBe("reading");
		expect(setup?.refreshes).toBe(false);
	});

	it("decides refreshes from the flags it is given, not the row: a list that flags the bank stops Home refreshing, and its notice names the bank", async () => {
		await twoChases(["ok"]);
		const id = (
			await env.DB.prepare("SELECT id FROM plaid_items ORDER BY id").first<{
				id: number;
			}>()
		)?.id;
		const flagged = [
			{ id: id ?? 0, name: "Chase", reason: "sign-in" as const },
		];
		const setup = await readSetup(env.DB, { today: TODAY, flagged });
		expect(setup?.refreshes).toBe(false);
		expect(homeBankNotice(flagged, TODAY)?.words).toEqual([
			"Chase needs signing in",
		]);
	});

	it("keeps refreshing when the list leaves the bank unflagged, even though its row says it needs signing in", async () => {
		await twoChases(["needs_attention"]);
		const setup = await readSetup(env.DB, { today: TODAY, flagged: [] });
		expect(setup?.phase).toBe("reading");
		expect(setup?.refreshes).toBe(true);
	});

	it("reads before-bank setup for a household with no record and no connected bank", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		expect(
			(await readSetup(env.DB, { today: TODAY, flagged: [] }))?.phase,
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
		await readSetup(env.DB, { today: budgetsDay, flagged: [] });
		expect(await countOf()).toBeUndefined();
	});

	it("is drawn on the first later day, and that day's view carries the night's counts", async () => {
		await seedHousehold({ ...fourDrawn, night });
		const view = await readSetup(env.DB, {
			today: later,
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
		await readSetup(env.DB, { today: later, flagged: [] });
		const again = await readSetup(env.DB, {
			today: later,
			flagged: [],
		});
		expect(await countOf()).toBe(later);
		expect(again?.fifth).toEqual(night);
	});

	it("is Home again from the next household day: no set-up view, and the record stays", async () => {
		await seedHousehold({ ...fourDrawn, night });
		await readSetup(env.DB, { today: later, flagged: [] });
		expect(
			await readSetup(env.DB, { today: "2026-10-15", flagged: [] }),
		).toBeNull();
		expect(await countOf()).toBe(later);
	});

	it("is not drawn while no night has been kept", async () => {
		await seedHousehold(fourDrawn);
		await readSetup(env.DB, { today: later, flagged: [] });
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
		expect(await readSetup(env.DB, { today: later, flagged: [] })).toBeNull();
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
		id: 2,
		name: "Chase",
		linkedAt: "2026-10-13 09:00:00",
		lastSyncedAt: null,
		historyCompleteAt: null,
	};
	const wells = {
		id: 3,
		name: "Wells Fargo",
		linkedAt: "2026-10-13 09:00:00",
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
			flagged: [{ id: 1, name: "Chase", reason: "sign-in" }],
		});
		expect(v?.answeredWaiting).toBe("once Chase is signed in again.");
	});

	it("names no wait for a bank that stopped updating: its Fix line says it (#671)", () => {
		const v = view({
			record: answered,
			banks: [{ ...BANK, lastSyncedAt: "2026-10-10" }],
		});
		expect(v?.phase).toBe("answered");
		expect(v?.answeredWaiting).toBeNull();
	});

	it("names both banks that need signing in", () => {
		const v = view({
			record: answered,
			banks: [BANK, wells],
			flagged: [
				{ id: 1, name: "Chase", reason: "sign-in" },
				{ id: 3, name: "Wells Fargo", reason: "sign-in" },
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
				{
					name: "Wells Fargo",
					linkedAt: "2026-10-13 09:00:00",
					lastSyncedAt: null,
					historyCompleteAt: null,
					id: 2,
				},
			],
		});
		expect(v?.steps[0]?.note).toBe("2 banks, linked");
	});
});
