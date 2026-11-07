import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgainMany } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import { markJevFailedStatement, pendingForJev } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import {
	JEV_ATTEMPT_CAP,
	type JevRetryState,
	jevRetry,
	retryStateOf,
} from "../src/machines/jev-retry";
import { next } from "../src/machines/next";
import { sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";
import { recordSorting } from "./record-sorting";

// A row Jev can never answer stops being asked after JEV_ATTEMPT_CAP failures (decision 171). Only a person's
// "ask again" or a change to the row's bank text, name, amount or account starts its count again.

const db = env.DB;
const TODAY = "2026-09-22";
const CAP = 5;
const withKey = { DB: db, JEV_API_KEY: "test-key" };
const create = recordSorting();

// The machine's transitions, from one state and event with the row's count (decision 171).
describe("the Jev retry machine", () => {
	const at = (attempts: number) => ({ attempts });

	it.each([
		[3, "waiting"],
		[4, "gave_up"],
	])(
		"JEV_FAILED from waiting with %i earlier failures goes to %s at the cap",
		(attempts, to) => {
			expect(next(jevRetry, "waiting", "JEV_FAILED", at(attempts))).toBe(to);
		},
	);

	it("JEV_ANSWERED from waiting goes to answered", () => {
		expect(next(jevRetry, "waiting", "JEV_ANSWERED", at(2))).toBe("answered");
	});

	it.each(["gave_up", "answered"] as const)(
		"%s refuses JEV_FAILED and JEV_ANSWERED",
		(state) => {
			expect(next(jevRetry, state, "JEV_FAILED", at(CAP))).toBeNull();
			expect(next(jevRetry, state, "JEV_ANSWERED", at(CAP))).toBeNull();
		},
	);

	it.each(["waiting", "gave_up", "answered"] as const)(
		"ASK_AGAIN and ROW_CHANGED from %s go to waiting",
		(state) => {
			expect(next(jevRetry, state, "ASK_AGAIN", at(CAP))).toBe("waiting");
			expect(next(jevRetry, state, "ROW_CHANGED", at(CAP))).toBe("waiting");
		},
	);

	it("the cap is 5 failures", () => {
		expect(JEV_ATTEMPT_CAP).toBe(5);
	});
});

// Every writer, from every state, against the machine (decision 171). A row is built in each state, a
// writer runs, and the state the row is then in is read back and compared with the machine's answer.
// A refused event must leave the state as it was. The one exception is listed with its reason.
describe("every writer agrees with the machine, state by state", () => {
	const STATES: JevRetryState[] = ["waiting", "gave_up", "answered"];
	const EVENTS = [
		"JEV_FAILED",
		"JEV_ANSWERED",
		"ASK_AGAIN",
		"ROW_CHANGED",
	] as const;
	// answered/ROW_CHANGED: a row Jev left unsure keeps its stored confidence when its bank text changes
	// (the trigger in migration 0067 resets only the count), so it stays answered, not waiting.
	const KNOWN_GAPS: Record<string, JevRetryState> = {
		"answered/ROW_CHANGED": "answered",
	};

	async function rowIn(state: JevRetryState): Promise<number> {
		const id = await addRow("GRID BANK TEXT");
		if (state === "gave_up") {
			await db
				.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
				.bind(CAP, id)
				.run();
		}
		if (state === "answered") {
			// Jev's unsure answer: its confidence is stored, and no category is filed.
			await db
				.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE id = ?",
				)
				.bind(id)
				.run();
		}
		return id;
	}

	async function readState(
		id: number,
	): Promise<{ attempts: number; state: JevRetryState }> {
		const row = await db
			.prepare(
				"SELECT jev_attempts AS attempts, category_confidence AS confidence FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{ attempts: number; confidence: number | null }>();
		const attempts = Number(row?.attempts);
		return {
			attempts,
			state: retryStateOf({ attempts, answered: row?.confidence != null }),
		};
	}

	async function fire(event: (typeof EVENTS)[number], id: number) {
		if (event === "JEV_FAILED") {
			await markJevFailedStatement(db, id).run();
		} else if (event === "JEV_ANSWERED") {
			// Only a row the sorting run asks is answered; a gave-up or answered row is not asked.
			await sortRun([id]);
		} else if (event === "ASK_AGAIN") {
			await askAgainMany({ DB: db, SORT: env.SORT, JEV_API_KEY: "test-key" }, [
				id,
			]);
		} else {
			await db
				.prepare(
					"UPDATE transactions SET raw_name = 'GRID CHANGED' WHERE id = ?",
				)
				.bind(id)
				.run();
		}
	}

	for (const state of STATES) {
		for (const event of EVENTS) {
			it(`${state} + ${event}`, async () => {
				const id = await rowIn(state);
				const before = await readState(id);
				expect(before.state).toBe(state);
				const machine = next(jevRetry, before.state, event, {
					attempts: before.attempts,
				});
				const expected = (machine ?? state) as JevRetryState;
				await fire(event, id);
				const after = await readState(id);
				const known = KNOWN_GAPS[`${state}/${event}`];
				expect(after.state).toBe(known ?? expected);
			});
		}
	}
});

/** Jev's answer for a row it can read: Eating Out at 0.9, no flags. */
const answer = () =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

/** Jev's reply for a row it can never answer: a 400 for its bank text, and an answer for every other row. */
const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
	String(init?.body ?? "").includes("HOPELESS")
		? new Response("{}", { status: 400 })
		: answer(),
);

const callsFor = (text: string) =>
	fetchImpl.mock.calls.filter(([, init]) =>
		String(init?.body ?? "").includes(text),
	).length;

async function addRow(raw: string): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES((SELECT MIN(id) FROM accounts),?,-600,?) RETURNING id",
		)
		.bind(TODAY, raw)
		.first<{ id: number }>();
	return Number(row?.id);
}

async function attempts(id: number): Promise<number> {
	const row = await db
		.prepare("SELECT jev_attempts AS n FROM transactions WHERE id = ?")
		.bind(id)
		.first<{ n: number }>();
	return Number(row?.n);
}

async function categoryOf(id: number): Promise<number | null> {
	const row = await db
		.prepare("SELECT category_id AS c FROM transactions WHERE id = ?")
		.bind(id)
		.first<{ c: number | null }>();
	return row?.c ?? null;
}

/** One sorting run over these rows, as a sync or the night would start it. */
async function sortRun(
	ids: number[],
	fetch: (url: string, init?: RequestInit) => Promise<Response> = fetchImpl,
) {
	const fake = fakeSteps();
	await sortGroups(withKey, fake.runStep, fetch, {
		rulesApplied: true,
		onlyIds: ids,
		runId: crypto.randomUUID(),
	});
}

async function isPending(id: number): Promise<boolean> {
	const rows = await pendingForJev(db, 500);
	return rows.some((row) => row.id === id);
}

/** Runs sorting until the row has failed CAP times, so it is left alone. */
async function failUntilCapped(id: number) {
	for (let run = 0; run < CAP; run++) await sortRun([id]);
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	// The category answer alone: a "Fill in details" question would need its own answers, or the call fails.
	await saveAiSwitches(db, { details: false });
	// The test env is the demo (40 calls a day), and resetDemo keeps the day's count: start each test with none.
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	fetchImpl.mockClear();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a row Jev can never answer", () => {
	it("is asked until the cap, then left out of the sorting run", async () => {
		const id = await addRow("HOPELESS BANK TEXT");
		await failUntilCapped(id);
		expect(callsFor("HOPELESS")).toBe(CAP);
		expect(await attempts(id)).toBe(CAP);
		expect(await isPending(id)).toBe(false);

		await sortRun([id]);
		expect(callsFor("HOPELESS")).toBe(CAP);
	});

	it("counts one attempt for each failed ask, below the cap", async () => {
		const id = await addRow("HOPELESS BANK TEXT");
		await sortRun([id]);
		await sortRun([id]);
		expect(await attempts(id)).toBe(2);
		expect(await isPending(id)).toBe(true);
	});

	it("is asked again when a person asks again, which resets its count to 0", async () => {
		const id = await addRow("HOPELESS BANK TEXT");
		await failUntilCapped(id);
		expect(await isPending(id)).toBe(false);

		vi.spyOn(console, "error").mockImplementation(() => {});
		await askAgainMany({ DB: db, SORT: env.SORT, JEV_API_KEY: "test-key" }, [
			id,
		]);
		expect(await attempts(id)).toBe(0);
		expect(await isPending(id)).toBe(true);
		expect(create).toHaveBeenCalled();
	});

	it.each([
		[
			"bank text",
			"UPDATE transactions SET raw_name = 'HOPELESS NEW TEXT' WHERE id = ?",
		],
		["amount", "UPDATE transactions SET amount_cents = -700 WHERE id = ?"],
		[
			"account",
			"UPDATE transactions SET account_id = (SELECT MAX(id) FROM accounts) WHERE id = ?",
		],
		["name", "UPDATE transactions SET own_name = 'Clearer name' WHERE id = ?"],
	])("is counted again from 0 when its %s changes", async (_field, sql) => {
		const id = await addRow("HOPELESS BANK TEXT");
		await failUntilCapped(id);
		expect(await isPending(id)).toBe(false);

		await db.prepare(sql).bind(id).run();
		expect(await attempts(id)).toBe(0);
		expect(await isPending(id)).toBe(true);
	});

	it("keeps its count when something other than its bank text, name, amount or account changes", async () => {
		const id = await addRow("HOPELESS BANK TEXT");
		await failUntilCapped(id);
		await db
			.prepare("UPDATE transactions SET note = 'a note' WHERE id = ?")
			.bind(id)
			.run();
		expect(await attempts(id)).toBe(CAP);
		expect(await isPending(id)).toBe(false);
	});
});

describe("a row Jev answers", () => {
	it("a success after earlier failures sets its count back to 0", async () => {
		const id = await addRow("FLAKY BANK TEXT");
		let calls = 0;
		const flaky = vi.fn(async () => {
			calls += 1;
			return calls <= 2 ? new Response("{}", { status: 400 }) : answer();
		});
		await sortRun([id], flaky);
		await sortRun([id], flaky);
		expect(await attempts(id)).toBe(2);

		await sortRun([id], flaky);
		expect(await categoryOf(id)).not.toBeNull();
		expect(await attempts(id)).toBe(0);
	});

	it("is categorized, keeps no failure count, and is not capped", async () => {
		const id = await addRow("GOOD BANK TEXT");
		await sortRun([id]);
		expect(await categoryOf(id)).not.toBeNull();
		expect(await attempts(id)).toBe(0);
	});
});
