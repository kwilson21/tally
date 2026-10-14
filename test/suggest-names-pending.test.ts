import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import {
	nameCallLimit,
	suggestMerchantNames,
	suggestTransactionNotes,
} from "../src/suggest-names-pending";

// The nightly names step (spec §7, §8.6, §9; #33): Workers AI is asked, once per bank text, only for a
// merchant Plaid didn't name, and only while the names switch is on. What it says is only ever a
// pending suggestion.

const db = env.DB;
const RAW = "SQ *BLUE BOTTLE COF 0412";

/** A fake Workers AI answering each call from `answer`, which sees the bank's text. */
const fakeAi = (answer: (text: string) => unknown = () => ({ response: "" })) =>
	({
		run: vi.fn(async (_model: string, input: unknown) => {
			const text = (
				input as { messages: { role: string; content: string }[] }
			).messages
				.find((m) => m.role === "user")
				?.content.replace("Bank text: ", "");
			return answer(text ?? "");
		}),
	}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

const callsFor = (ai: { run: ReturnType<typeof vi.fn> }) =>
	ai.run.mock.calls.map(([, input]) =>
		(input as { messages: { role: string; content: string }[] }).messages
			.find((m) => m.role === "user")
			?.content.replace("Bank text: ", ""),
	);

async function addTransactions(
	rows: {
		rawName: string;
		merchantName?: string | null;
		plaid?: boolean;
		parent?: number;
		/** On the Cash account, as a cash entry a person typed is. */
		cash?: boolean;
	}[],
) {
	let n = 0;
	for (const row of rows) {
		n += 1;
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, parent_id)
				 VALUES (?, CASE WHEN ? THEN (SELECT id FROM accounts WHERE type = 'cash') ELSE 1 END, '2026-09-20', 650, ?, ?, ?)`,
			)
			.bind(
				row.plaid === false ? null : `plaid-${crypto.randomUUID()}-${n}`,
				row.cash ? 1 : 0,
				row.rawName,
				row.merchantName ?? null,
				row.parent ?? null,
			)
			.run();
	}
}

type MerchantRow = {
	raw_name: string;
	suggested_name: string | null;
	display_name: string | null;
	suggestion_status: string;
};
const merchants = async () =>
	(
		await db
			.prepare(
				"SELECT raw_name, suggested_name, display_name, suggestion_status FROM merchants ORDER BY raw_name",
			)
			.all<MerchantRow>()
	).results;

/** The bank texts whose last name call failed, the longest-ago failure first. */
const failedNames = async () =>
	(
		await db
			.prepare(
				"SELECT raw_name FROM merchant_name_failures ORDER BY failed_at, raw_name",
			)
			.all<{ raw_name: string }>()
	).results.map((row) => row.raw_name);

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM bill_payments"),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
	]);
});

describe("suggestMerchantNames", () => {
	it("reads household switches a bounded number of times for up to 100 names", async () => {
		await addTransactions(
			Array.from({ length: 100 }, (_, i) => ({
				rawName: `UNIQUE SHOP ${i}`,
			})),
		);
		let statements = 0;
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const ai = fakeAi(() => ({ response: "Unique Shop" }));
		await suggestMerchantNames({ DB: counted as D1Database, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(nameCallLimit);
		// One candidate query and the names switch read, then for every five calls a switch read and two writes
		// (the merchants upsert and the failures delete): 1 + 1 + 20 × 3 = 62. A save per name would be 100 or more.
		expect(statements).toBeLessThanOrEqual(62);
	});

	it("asks once for a merchant Plaid didn't name and keeps the names, pending, without renaming it", async () => {
		await addTransactions([{ rawName: RAW }, { rawName: RAW }]);
		const ai = fakeAi(() => ({
			response: "Blue Bottle Coffee\nBlue Bottle",
		}));

		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(callsFor(ai)).toEqual([RAW]);
		expect(await merchants()).toEqual([
			{
				raw_name: RAW,
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("never asks again for a merchant it already asked about, whatever the answer was", async () => {
		await addTransactions([{ rawName: RAW }, { rawName: "NOTHING USEFUL" }]);
		const ai = fakeAi((text) =>
			text === RAW
				? { response: "Blue Bottle Coffee" }
				: { response: "NOTHING USEFUL" },
		);
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(callsFor(ai).sort()).toEqual([RAW, "NOTHING USEFUL"].sort());
		// An answer with no usable name is remembered as an empty suggestion, not a pending one.
		expect(
			(await merchants()).find((m) => m.raw_name === "NOTHING USEFUL"),
		).toMatchObject({ suggested_name: "", suggestion_status: "none" });

		const again = fakeAi();
		expect(await suggestMerchantNames({ DB: db, AI: again })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(again.run).not.toHaveBeenCalled();
	});

	it("doesn't ask for a merchant Plaid named, a cash entry, a split part, or one a person already named", async () => {
		await db.batch([
			db.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED BY PERSON', 'My place')",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status, suggested_name) VALUES ('ALREADY PENDING', 'pending', 'Pending Place')",
			),
			db.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status) VALUES ('TURNED DOWN', 'rejected')",
			),
		]);
		await addTransactions([
			{ rawName: "SQ *LOCAL BAKERY 4432", merchantName: "Local Bakery" },
			{ rawName: "Cash at the fair", plaid: false, cash: true },
			{ rawName: "NAMED BY PERSON" },
			{ rawName: "ALREADY PENDING" },
			{ rawName: "TURNED DOWN" },
		]);
		const ai = fakeAi();
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("asks for a seeded-style row with no Plaid id and no merchant name, but not for a cash entry, so the demo's bank texts are asked after a reset", async () => {
		await addTransactions([
			{ rawName: "TST* CORNER DELI", plaid: false },
			{ rawName: "Farmers market stall", plaid: false, cash: true },
		]);
		const ai = fakeAi(() => ({ response: "Corner Deli Cafe" }));
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(callsFor(ai)).toEqual(["TST* CORNER DELI"]);
		expect(await merchants()).toMatchObject([
			{ raw_name: "TST* CORNER DELI", suggestion_status: "pending" },
		]);
	});

	it("asks about the seeded demo's unnamed bank texts, within its limit, and never about its cash entries or named merchants", async () => {
		await resetDemo(db, "2026-09-22");
		const ai = fakeAi(() => ({ response: "Some Place" }));
		await suggestMerchantNames({ DB: db, AI: ai });
		const asked = callsFor(ai);
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.length).toBeLessThanOrEqual(nameCallLimit);
		// Seeded merchants that already have a chosen name or a suggestion, and the cash entry, are left alone.
		expect(asked).not.toContain("Farmers market");
		expect(asked).not.toContain("TRADER JOE'S #552");
		expect(asked).not.toContain("TST* CORNER DELI");
		expect(asked).toContain("VENMO *J RIVERA");
	});

	it("asks for a bank text Plaid named on some charges but not others", async () => {
		await addTransactions([
			{ rawName: RAW, merchantName: "Blue Bottle Coffee" },
			{ rawName: RAW },
		]);
		const ai = fakeAi(() => ({ response: "Blue Bottle" }));
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(callsFor(ai)).toEqual([RAW]);
	});

	it("does nothing without a Workers AI binding", async () => {
		await addTransactions([{ rawName: RAW }]);
		expect(await suggestMerchantNames({ DB: db })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(await merchants()).toEqual([]);
	});

	it("with the names switch off, makes no call and no suggestion", async () => {
		await saveAiSwitches(db, { names: false });
		await addTransactions([{ rawName: RAW }]);
		const ai = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toEqual([]);
	});

	it("drops a batch of answers that come back after the switch went off, or after a person named the merchant", async () => {
		await addTransactions([
			{ rawName: "FIRST SHOP" },
			{ rawName: "SECOND SHOP" },
		]);
		const ai = fakeAi(() => ({ response: "A Name" }));
		ai.run.mockImplementationOnce(async () => {
			await saveAiSwitches(db, { names: false });
			return { response: "First Shop" };
		});
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toMatchObject({
			suggested: 0,
		});
		expect(await merchants()).toEqual([]);
		// It checks after a batch of at most five, then makes no further calls.
		expect(ai.run).toHaveBeenCalledTimes(2);

		await saveAiSwitches(db, { names: true });
		const naming = fakeAi(() => ({ response: "A Name" }));
		naming.run.mockImplementationOnce(async () => {
			await db
				.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES ('FIRST SHOP', 'Mine') ON CONFLICT(raw_name) DO UPDATE SET display_name = 'Mine'",
				)
				.run();
			return { response: "Shopfront" };
		});
		await suggestMerchantNames({ DB: db, AI: naming });
		expect(
			(await merchants()).find((m) => m.raw_name === "FIRST SHOP"),
		).toMatchObject({ display_name: "Mine", suggestion_status: "none" });
	});

	it("leaves a merchant to be asked tomorrow when the call fails, and stops after three failures in a row", async () => {
		await addTransactions(
			["ONE", "TWO", "THREE", "FOUR"].map((rawName) => ({ rawName })),
		);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		expect(await suggestMerchantNames({ DB: db, AI: failing })).toEqual({
			asked: 3,
			suggested: 0,
		});
		expect(failing.run).toHaveBeenCalledTimes(3);
		// A failure makes no merchant row; the three that failed in a row (FOUR, ONE, THREE) are remembered
		// apart from merchants, and TWO was never tried.
		expect(await merchants()).toEqual([]);
		expect((await failedNames()).sort()).toEqual(["FOUR", "ONE", "THREE"]);
		logged.mockRestore();

		// Back up the next night: everything is asked again, the one never tried first.
		const working = fakeAi(() => ({ response: "A Name" }));
		expect(await suggestMerchantNames({ DB: db, AI: working })).toEqual({
			asked: 4,
			suggested: 4,
		});
		expect(callsFor(working)[0]).toBe("TWO");
		expect(callsFor(working).slice(1).sort()).toEqual(["FOUR", "ONE", "THREE"]);
	});

	it("doesn't let three top merchants whose calls keep failing hold up the others: the others are asked by the second night", async () => {
		await addTransactions([
			...Array.from({ length: 5 }, () => ({ rawName: "TOP ONE" })),
			...Array.from({ length: 4 }, () => ({ rawName: "TOP TWO" })),
			...Array.from({ length: 3 }, () => ({ rawName: "TOP THREE" })),
			{ rawName: "SMALL A" },
			{ rawName: "SMALL B" },
		]);
		const answer = (text: string) => {
			if (text.startsWith("TOP")) throw new Error("capacity");
			return { response: "Small Place" };
		};
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		// Night one: the three top merchants fail in a row, so the run stops before the two small ones.
		const night1 = fakeAi(answer);
		expect(await suggestMerchantNames({ DB: db, AI: night1 })).toEqual({
			asked: 3,
			suggested: 0,
		});
		expect(callsFor(night1)).toEqual(["TOP ONE", "TOP TWO", "TOP THREE"]);

		// Night two: the two never asked come first; the three that failed come after them.
		const night2 = fakeAi(answer);
		expect(await suggestMerchantNames({ DB: db, AI: night2 })).toEqual({
			asked: 5,
			suggested: 2,
		});
		logged.mockRestore();
		expect(callsFor(night2)).toEqual([
			"SMALL A",
			"SMALL B",
			"TOP ONE",
			"TOP TWO",
			"TOP THREE",
		]);
		expect(
			(await merchants())
				.filter((m) => m.raw_name.startsWith("SMALL"))
				.map((m) => m.suggestion_status),
		).toEqual(["pending", "pending"]);
	});

	it("asks a merchant whose call failed again on a later night, and a later success clears its failure", async () => {
		await addTransactions([{ rawName: RAW }]);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		expect(await suggestMerchantNames({ DB: db, AI: failing })).toEqual({
			asked: 1,
			suggested: 0,
		});
		logged.mockRestore();
		expect(await failedNames()).toEqual([RAW]);

		const working = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		expect(await suggestMerchantNames({ DB: db, AI: working })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(callsFor(working)).toEqual([RAW]);
		expect(await failedNames()).toEqual([]);
		expect(await merchants()).toEqual([
			{
				raw_name: RAW,
				suggested_name: "Blue Bottle Coffee",
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("a failure again on a text that already failed updates its one row's time", async () => {
		await addTransactions([{ rawName: RAW }]);
		await db
			.prepare(
				"INSERT INTO merchant_name_failures (raw_name, failed_at) VALUES (?, '2000-01-01 00:00:00')",
			)
			.bind(RAW)
			.run();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		await suggestMerchantNames({ DB: db, AI: failing });
		logged.mockRestore();
		const failures = await db
			.prepare("SELECT raw_name, failed_at FROM merchant_name_failures")
			.all<{ raw_name: string; failed_at: string }>();
		const [failure] = failures.results;
		expect(failures.results).toHaveLength(1);
		expect(failure?.raw_name).toBe(RAW);
		// Newer than the seeded time (datetime('now') has a one-second resolution, so compare with the seed).
		expect((failure?.failed_at ?? "") > "2000-01-01 00:00:00").toBe(true);
		expect(await merchants()).toEqual([]);
	});

	it("a text that failed and is answered on a later night leaves no failure row", async () => {
		await addTransactions([{ rawName: RAW }]);
		await db
			.prepare(
				"INSERT INTO merchant_name_failures (raw_name, failed_at) VALUES (?, '2026-10-01 09:20:00')",
			)
			.bind(RAW)
			.run();
		const working = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		await suggestMerchantNames({ DB: db, AI: working });
		expect(await failedNames()).toEqual([]);
		expect(await merchants()).toMatchObject([
			{ raw_name: RAW, suggestion_status: "pending" },
		]);
	});

	it("asks the merchants whose calls failed after the never-tried ones, the longest-ago failure first", async () => {
		await addTransactions([
			...Array.from({ length: 3 }, () => ({ rawName: "RECENT FAIL" })),
			...Array.from({ length: 2 }, () => ({ rawName: "OLD FAIL" })),
			{ rawName: "NEVER TRIED" },
		]);
		await db.batch([
			db.prepare(
				"INSERT INTO merchant_name_failures (raw_name, failed_at) VALUES ('RECENT FAIL', '2026-10-06 09:20:00')",
			),
			db.prepare(
				"INSERT INTO merchant_name_failures (raw_name, failed_at) VALUES ('OLD FAIL', '2026-10-01 09:20:00')",
			),
		]);
		const ai = fakeAi(() => ({ response: "A Name" }));
		await suggestMerchantNames({ DB: db, AI: ai });
		expect(callsFor(ai)).toEqual(["NEVER TRIED", "OLD FAIL", "RECENT FAIL"]);
	});

	it("records a batch's answers and failed calls in one D1 batch", async () => {
		await addTransactions(
			["ONE", "TWO", "THREE", "FOUR", "FIVE"].map((rawName) => ({ rawName })),
		);
		let statements = 0;
		const counted = new Proxy(db, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		// Two of the five calls fail and three answer, all in one batch of five.
		const ai = fakeAi((text) => {
			if (text === "TWO" || text === "FOUR") throw new Error("capacity");
			return { response: "A Name" };
		});
		expect(
			await suggestMerchantNames({ DB: counted as D1Database, AI: ai }),
		).toEqual({ asked: 5, suggested: 3 });
		logged.mockRestore();
		// The candidate query, the names switch read at the start and again before the batch, then the batch's
		// three writes: the merchants upsert, the failures upsert and the failures delete. 1 + 1 + 1 + 3 = 6.
		expect(statements).toBeLessThanOrEqual(6);
		expect((await merchants()).map((m) => m.raw_name)).toEqual([
			"FIVE",
			"ONE",
			"THREE",
		]);
		expect(await failedNames()).toEqual(["FOUR", "TWO"]);
	});

	it("asks about the merchants with the most charges first, up to its limit for a night", async () => {
		expect(nameCallLimit).toBeGreaterThanOrEqual(10);
		await addTransactions([
			{ rawName: "RARE SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "OFTEN SHOP" },
			{ rawName: "SOMETIMES SHOP" },
			{ rawName: "SOMETIMES SHOP" },
		]);
		const ai = fakeAi(() => ({ response: "A Name" }));
		await suggestMerchantNames({ DB: db, AI: ai }, 2);
		expect(callsFor(ai)).toEqual(["OFTEN SHOP", "SOMETIMES SHOP"]);
	});

	// Slow requests must not hold up the rest of a run (src/index.tsx runs this after Jev, within a budget):
	// no new request starts once the deadline has passed, and what was answered by then is kept.
	it("stops starting new requests once its deadline has passed, keeping the answers it has", async () => {
		await addTransactions(
			["ONE", "TWO", "THREE", "FOUR", "FIVE"].map((rawName) => ({ rawName })),
		);
		let now = 0;
		const ai = fakeAi(() => {
			now += 1_000;
			return { response: "A Name" };
		});

		// Calls start at 0, 1,000 and 2,000; the next would start at 3,000, past the deadline.
		expect(
			await suggestMerchantNames({ DB: db, AI: ai }, nameCallLimit, {
				deadline: 2_500,
				now: () => now,
			}),
		).toEqual({ asked: 3, suggested: 3 });
		expect(ai.run).toHaveBeenCalledTimes(3);
		expect(await merchants()).toHaveLength(3);

		// The two it didn't reach wait for the next night.
		const next = fakeAi(() => ({ response: "A Name" }));
		expect(await suggestMerchantNames({ DB: db, AI: next })).toEqual({
			asked: 2,
			suggested: 2,
		});
	});

	// The names switch is read every five calls, as the notes' switch is, so one turned off mid-run stops within five.
	it("stops within five calls when the names switch is turned off during the run", async () => {
		await addTransactions(
			Array.from({ length: 30 }, (_, i) => ({ rawName: `SWITCH SHOP ${i}` })),
		);
		const ai = fakeAi(() => ({ response: "A Name" }));
		ai.run.mockImplementationOnce(async () => {
			await saveAiSwitches(db, { names: false });
			return { response: "A Name" };
		});
		expect(await suggestMerchantNames({ DB: db, AI: ai })).toEqual({
			asked: 5,
			suggested: 0,
		});
		expect(ai.run).toHaveBeenCalledTimes(5);
		expect(await merchants()).toEqual([]);
	});

	it("makes no request at all when its deadline has already passed", async () => {
		await addTransactions([{ rawName: RAW }]);
		const ai = fakeAi(() => ({ response: "Blue Bottle Coffee" }));
		expect(
			await suggestMerchantNames({ DB: db, AI: ai }, nameCallLimit, {
				deadline: 5_000,
				now: () => 5_000,
			}),
		).toEqual({ asked: 0, suggested: 0 });
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toEqual([]);
	});
});

/** `n` charges Jev said a note could help with, already asked about, none with a note yet (decision 103). */
async function addNoteCandidates(n: number) {
	await db
		.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing)
			 SELECT 'plaid-note-' || i, 1, '2026-09-20', 650, 'NOTE SHOP ' || i, 'Note Shop', 1, 1 FROM n`,
		)
		.bind(n)
		.run();
}

describe("suggestTransactionNotes", () => {
	// A note Workers AI answered empty is remembered as tried, so the nightly notes move on to the
	// next charges and the names get the night's calls; the names then run on their own calls.
	it("doesn't ask again about a note Workers AI answered empty, so the names still get their calls", async () => {
		await addNoteCandidates(nameCallLimit);
		const night1 = fakeAi(() => ({ response: "" }));
		expect(await suggestTransactionNotes({ DB: db, AI: night1 })).toEqual({
			asked: nameCallLimit,
			suggested: 0,
		});
		expect(night1.run).toHaveBeenCalledTimes(nameCallLimit);

		await addTransactions([
			{ rawName: "SHOP ONE" },
			{ rawName: "SHOP TWO" },
			{ rawName: "SHOP THREE" },
		]);
		const night2 = fakeAi(() => ({ response: "" }));
		expect(await suggestTransactionNotes({ DB: db, AI: night2 })).toEqual({
			asked: 0,
			suggested: 0,
		});
		expect(night2.run).not.toHaveBeenCalled();
		expect(
			await suggestMerchantNames({ DB: db, AI: night2 }, nameCallLimit),
		).toEqual({ asked: 3, suggested: 0 });
		expect(night2.run).toHaveBeenCalledTimes(3);
	});

	it("asks again about a note whose call failed", async () => {
		await addNoteCandidates(1);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = fakeAi(() => {
			throw new Error("capacity");
		});
		expect(await suggestTransactionNotes({ DB: db, AI: failing })).toEqual({
			asked: 1,
			suggested: 0,
		});
		logged.mockRestore();

		const working = fakeAi(() => ({ response: "" }));
		expect(await suggestTransactionNotes({ DB: db, AI: working })).toEqual({
			asked: 1,
			suggested: 0,
		});
	});

	it("asks a note whose call failed after the untried ones, so three failures in a row can't hold up older notes", async () => {
		for (const [rawName, date] of [
			["FAILS ONE", "2026-09-21"],
			["FAILS TWO", "2026-09-20"],
			["FAILS THREE", "2026-09-19"],
			["OLDER ONE", "2026-09-05"],
			["OLDER TWO", "2026-09-04"],
		] as const)
			await db
				.prepare(
					`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing)
					 VALUES (?, 1, ?, 650, ?, 'Note Shop', 1, 1)`,
				)
				.bind(`plaid-note-${rawName}`, date, rawName)
				.run();
		// Every call for a FAILS text throws; the others answer empty.
		const answer = (text: string) => {
			if (text.includes("FAILS")) throw new Error("capacity");
			return { response: "" };
		};

		// Night one: the three newest fail in a row, so the run stops before the older two.
		const night1 = fakeAi(answer);
		expect(await suggestTransactionNotes({ DB: db, AI: night1 })).toEqual({
			asked: 3,
			suggested: 0,
		});
		expect(callsFor(night1)).toEqual(["FAILS ONE", "FAILS TWO", "FAILS THREE"]);

		// Night two: the older notes, never asked, come before any note that failed.
		const night2 = fakeAi(answer);
		expect(await suggestTransactionNotes({ DB: db, AI: night2 })).toEqual({
			asked: 5,
			suggested: 0,
		});
		const sent = callsFor(night2);
		expect(sent.slice(0, 2)).toEqual(["OLDER ONE", "OLDER TWO"]);
		expect(sent.slice(2).every((text) => text?.startsWith("FAILS"))).toBe(true);

		// The failed notes stay untried, so a later night asks them again.
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'FAILS%' AND note_tried_at IS NULL AND note_failed_at IS NOT NULL",
				)
				.first<{ n: number }>(),
		).toEqual({ n: 3 });
	});

	// A renamed charge shows its own name, so a note that only repeats it is dropped (#426), the same as one
	// that repeats the bank text or the merchant's name. The rejected note is counted as answered empty.
	const noteOf = (rawName: string) =>
		db
			.prepare(
				"SELECT note, note_guessed, note_tried_at IS NOT NULL AS tried FROM transactions WHERE raw_name = ?",
			)
			.bind(rawName)
			.first<{ note: string | null; note_guessed: number; tried: number }>();

	it.each([
		["the same words", "Dog bed"],
		["another case and punctuation", "DOG-BED."],
	])(
		"a renamed charge whose note only repeats its own name (%s) saves no note and counts as answered empty",
		async (_label, guess) => {
			await addNoteCandidates(1);
			await db
				.prepare(
					"UPDATE transactions SET own_name = 'Dog bed' WHERE raw_name = 'NOTE SHOP 1'",
				)
				.run();
			const ai = fakeAi(() => ({ response: guess }));
			expect(await suggestTransactionNotes({ DB: db, AI: ai })).toEqual({
				asked: 1,
				suggested: 0,
			});
			expect(await noteOf("NOTE SHOP 1")).toEqual({
				note: null,
				note_guessed: 0,
				tried: 1,
			});

			// Answered empty, so a later night doesn't ask about it again.
			const later = fakeAi(() => ({ response: guess }));
			expect(await suggestTransactionNotes({ DB: db, AI: later })).toEqual({
				asked: 0,
				suggested: 0,
			});
			expect(later.run).not.toHaveBeenCalled();
		},
	);

	it("a renamed charge whose note says more than its own name keeps the note", async () => {
		await addNoteCandidates(1);
		await db
			.prepare(
				"UPDATE transactions SET own_name = 'Dog bed' WHERE raw_name = 'NOTE SHOP 1'",
			)
			.run();
		const ai = fakeAi(() => ({ response: "Dog bed for the puppy" }));
		expect(await suggestTransactionNotes({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(await noteOf("NOTE SHOP 1")).toEqual({
			note: "Dog bed for the puppy",
			note_guessed: 1,
			tried: 1,
		});
	});

	it("a charge with no own name keeps a note whose words it doesn't show, as before", async () => {
		await addNoteCandidates(1);
		const ai = fakeAi(() => ({ response: "Dog bed" }));
		expect(await suggestTransactionNotes({ DB: db, AI: ai })).toEqual({
			asked: 1,
			suggested: 1,
		});
		expect(await noteOf("NOTE SHOP 1")).toEqual({
			note: "Dog bed",
			note_guessed: 1,
			tried: 1,
		});
	});
});
