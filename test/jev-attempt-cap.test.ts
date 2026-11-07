import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/ai/decide";
import { askAgainMany } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	markJevFailedStatement,
	pendingForJev,
	saveJevResultStatements,
} from "../src/db/transactions";
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
const CAP = JEV_ATTEMPT_CAP;
const withKey = { DB: db, JEV_API_KEY: "test-key" };
const create = recordSorting();
// The category Eating Out, as the demo seed names it.
const EATING_OUT = 2;

type Fetch = (url?: string, init?: RequestInit) => Promise<Response>;

type RowKind =
	| "waiting"
	| "gave_up"
	| "unsure"
	| "filed by Jev"
	| "filed by a person"
	| "filed by a merchant rule";

/** Jev's reply: Eating Out at the given confidence, no flags. */
const replyAt = (confidence: number): Fetch =>
	vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					answers: {
						category: { type: "choice", choice: "Eating Out", confidence },
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: 0.01 },
					},
				}),
				{ status: 200 },
			),
	);

/** Jev's reply for a row it can never answer: a 400 for its bank text, and an answer for every other row. */
const fetchImpl = vi.fn(async (_url?: string, init?: RequestInit) =>
	String(init?.body ?? "").includes("HOPELESS")
		? new Response("{}", { status: 400 })
		: replyAt(0.9)(),
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

/** The retry columns of a row: what the machine reads, and whether the failure stamp is set. */
type Snapshot = {
	attempts: number;
	failed: boolean;
	categoryId: number | null;
	categorySource: string | null;
	confidence: number | null;
};

async function snapshot(id: number): Promise<Snapshot> {
	const row = await db
		.prepare(
			"SELECT jev_attempts AS attempts, jev_failed_at AS failedAt, category_id AS categoryId, category_source AS categorySource, category_confidence AS confidence FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			attempts: number;
			failedAt: string | null;
			categoryId: number | null;
			categorySource: string | null;
			confidence: number | null;
		}>();
	const categoryId = row?.categoryId ?? null;
	return {
		attempts: Number(row?.attempts),
		failed: row?.failedAt != null,
		categoryId,
		categorySource: row?.categorySource ?? null,
		// The machine reads a stored confidence only on a row with no category, so only that one is compared. A
		// filed row's stored confidence is the mark that Jev was asked, which the answer writer keeps (decision 143).
		confidence: categoryId === null ? (row?.confidence ?? null) : null,
	};
}

const stateOf = (row: Snapshot): JevRetryState => retryStateOf(row);

async function attempts(id: number): Promise<number> {
	return (await snapshot(id)).attempts;
}

async function categoryOf(id: number): Promise<number | null> {
	return (await snapshot(id)).categoryId;
}

/** One sorting run over these rows, as a sync or the night would start it. */
async function sortRun(ids: number[], fetch: Fetch = fetchImpl) {
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

/** Runs sorting until the row has failed CAP times, so it has given up. */
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

// The machine's transitions (decision 171), from one state, event and row context.
describe("the Jev retry machine", () => {
	const at = (attempts: number, categorized = false) => ({
		attempts,
		categorized,
	});

	it("JEV_FAILED from waiting counts one more, and gives up when that reaches the cap", () => {
		expect(next(jevRetry, "waiting", "JEV_FAILED", at(CAP - 2))).toBe(
			"waiting",
		);
		expect(next(jevRetry, "waiting", "JEV_FAILED", at(CAP - 1))).toBe(
			"gave_up",
		);
	});

	it("JEV_ANSWERED from waiting is filed when a category came back, and unsure when none did", () => {
		expect(next(jevRetry, "waiting", "JEV_ANSWERED", at(2, true))).toBe(
			"filed",
		);
		expect(next(jevRetry, "waiting", "JEV_ANSWERED", at(2, false))).toBe(
			"unsure",
		);
	});

	it("ASK_AGAIN and ROW_CHANGED from waiting stay waiting", () => {
		expect(next(jevRetry, "waiting", "ASK_AGAIN", at(3))).toBe("waiting");
		expect(next(jevRetry, "waiting", "ROW_CHANGED", at(3))).toBe("waiting");
	});

	it("gave_up refuses JEV_FAILED and JEV_ANSWERED, and ASK_AGAIN or ROW_CHANGED go to waiting", () => {
		expect(next(jevRetry, "gave_up", "JEV_FAILED", at(CAP))).toBeNull();
		expect(next(jevRetry, "gave_up", "JEV_ANSWERED", at(CAP))).toBeNull();
		expect(next(jevRetry, "gave_up", "ASK_AGAIN", at(CAP))).toBe("waiting");
		expect(next(jevRetry, "gave_up", "ROW_CHANGED", at(CAP))).toBe("waiting");
	});

	it("unsure refuses JEV_FAILED and JEV_ANSWERED, ASK_AGAIN goes to waiting, and ROW_CHANGED stays unsure", () => {
		expect(next(jevRetry, "unsure", "JEV_FAILED", at(0))).toBeNull();
		expect(next(jevRetry, "unsure", "JEV_ANSWERED", at(0, true))).toBeNull();
		expect(next(jevRetry, "unsure", "ASK_AGAIN", at(0))).toBe("waiting");
		expect(next(jevRetry, "unsure", "ROW_CHANGED", at(0))).toBe("unsure");
	});

	it("filed refuses every event: asking again or changing the bank text does not reopen a category", () => {
		for (const event of [
			"JEV_FAILED",
			"JEV_ANSWERED",
			"ASK_AGAIN",
			"ROW_CHANGED",
		]) {
			expect(next(jevRetry, "filed", event, at(0, true))).toBeNull();
		}
	});

	it("the cap is 5 failures", () => {
		expect(JEV_ATTEMPT_CAP).toBe(5);
	});

	// A row with a category, whoever set it, is filed: Jev's retry does not apply to it.
	it.each([
		["person", "user"],
		["merchant rule", "merchant_rule"],
	])("a row a %s categorized derives as filed", (_who, source) => {
		expect(
			retryStateOf({
				attempts: 0,
				categoryId: EATING_OUT,
				categorySource: source,
				confidence: null,
			}),
		).toBe("filed");
	});
});

// A failed income question is one of Jev's asks on a row that may already have a category. It counts only while the
// row is waiting: on an unsure or filed row it leaves the failure stamp alone (decision 171).
describe("a failed income question stamps only a waiting row", () => {
	async function stampedAfterFailure(id: number): Promise<boolean> {
		await markJevFailedStatement(db, id).run();
		return (await snapshot(id)).failed;
	}

	it("a waiting row is stamped", async () => {
		expect(await stampedAfterFailure(await addRow("WAITING ROW"))).toBe(true);
	});

	it("an unsure row is not stamped", async () => {
		const id = await addRow("UNSURE ROW");
		await db
			.prepare("UPDATE transactions SET category_confidence = 0.5 WHERE id = ?")
			.bind(id)
			.run();
		expect(await stampedAfterFailure(id)).toBe(false);
	});

	it("a filed row is not stamped", async () => {
		const id = await addRow("FILED ROW");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
			)
			.bind(EATING_OUT, id)
			.run();
		expect(await stampedAfterFailure(id)).toBe(false);
	});
});

// Every writer, from every state, against the machine (decision 171). A row is built in each state, the real writer
// runs (the failure statement, the sorting run's answer, ask again, or the bank-text trigger), and the row is read
// back. Where the machine allows the event, the row must reach the machine's state. Where it refuses, the row's retry
// columns must be exactly as they were. There are no exceptions to this grid.
describe("every writer agrees with the machine, state by state", () => {
	// Each kind of row, with the state the machine says it is in. A row with a category in any way is filed, so the
	// person's and the merchant rule's categories are grid rows too, not just Jev's.
	const ROWS: { kind: RowKind; state: JevRetryState }[] = [
		{ kind: "waiting", state: "waiting" },
		{ kind: "gave_up", state: "gave_up" },
		{ kind: "unsure", state: "unsure" },
		{ kind: "filed by Jev", state: "filed" },
		{ kind: "filed by a person", state: "filed" },
		{ kind: "filed by a merchant rule", state: "filed" },
	];
	const EVENTS = [
		{ name: "JEV_FAILED", categorized: false },
		{ name: "JEV_ANSWERED", categorized: true },
		{ name: "JEV_ANSWERED", categorized: false },
		{ name: "ASK_AGAIN", categorized: false },
		{ name: "ROW_CHANGED", categorized: false },
	] as const;

	/** A row built in the state: the columns the writers and the machine both read. */
	async function rowIn(kind: RowKind): Promise<number> {
		const id = await addRow("GRID BANK TEXT");
		if (kind === "gave_up") {
			await db
				.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
				.bind(CAP, id)
				.run();
		}
		if (kind === "unsure") {
			// Jev's answer was unsure: its confidence is stored, and no category is filed.
			await db
				.prepare(
					"UPDATE transactions SET category_confidence = 0.5 WHERE id = ?",
				)
				.bind(id)
				.run();
		}
		if (kind === "filed by Jev") {
			// Jev's answer filed the row in a category.
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
				)
				.bind(EATING_OUT, id)
				.run();
		}
		if (kind === "filed by a person") {
			// A person chose the category; Jev has not answered this row.
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
				)
				.bind(EATING_OUT, id)
				.run();
		}
		if (kind === "filed by a merchant rule") {
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'merchant_rule' WHERE id = ?",
				)
				.bind(EATING_OUT, id)
				.run();
		}
		return id;
	}

	async function fire(event: (typeof EVENTS)[number], id: number) {
		if (event.name === "JEV_FAILED") {
			await markJevFailedStatement(db, id).run();
		} else if (event.name === "JEV_ANSWERED") {
			// Only a row the sorting run asks is answered. A gave-up, unsure or filed row's pending
			// question is the one Jev is asked about, so the reply decides what the writer keeps.
			await sortRun([id], replyAt(event.categorized ? 0.9 : 0.5));
		} else if (event.name === "ASK_AGAIN") {
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

	for (const { kind, state } of ROWS) {
		for (const event of EVENTS) {
			const label = `${kind} + ${event.name}${event.name === "JEV_ANSWERED" ? (event.categorized ? " (categorized)" : " (unsure)") : ""}`;
			it(label, async () => {
				const id = await rowIn(kind);
				const before = await snapshot(id);
				expect(stateOf(before)).toBe(state);
				const expected = next(jevRetry, state, event.name, {
					attempts: before.attempts,
					categorized: event.categorized,
				});
				await fire(event, id);
				const after = await snapshot(id);
				if (expected === null) {
					expect(after).toEqual(before);
				} else {
					expect(stateOf(after)).toBe(expected);
				}
			});
		}
	}
});

// The answer writer refuses a row that has given up, so the machine holds even where the sorting run never asks.
describe("the answer writer refuses a row that has given up", () => {
	const decision = (categoryId: number | null, confidence: number) =>
		({
			categoryId,
			suggestedCategoryId: categoryId,
			confidence,
			flags: { transfer: false, reimbursement: false, income: false },
		}) as Decision;

	it("leaves a gave-up row exactly as it was", async () => {
		const id = await addRow("GIVEN UP");
		await db
			.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
			.bind(CAP, id)
			.run();
		const before = await snapshot(id);
		await saveJevResultStatements(
			db,
			id,
			decision(EATING_OUT, 0.9),
		).update.run();
		expect(await snapshot(id)).toEqual(before);
	});

	it("applies the same answer to a row that is still waiting", async () => {
		const id = await addRow("STILL WAITING");
		await saveJevResultStatements(
			db,
			id,
			decision(EATING_OUT, 0.9),
		).update.run();
		expect(await categoryOf(id)).toBe(EATING_OUT);
		expect(await attempts(id)).toBe(0);
	});
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
			return calls <= 2 ? new Response("{}", { status: 400 }) : replyAt(0.9)();
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
