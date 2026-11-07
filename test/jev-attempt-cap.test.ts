import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/ai/decide";
import { askAgainMany } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	markJevFailedStatement,
	pendingForJev,
	saveJevDetailsStatement,
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
import { mergePendingIntoPosted } from "../src/plaid/pending-merge";
import { sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";
import { recordSorting } from "./record-sorting";

// A row Jev can never answer stops being asked after JEV_ATTEMPT_CAP failures (decision 179). Only a person's
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
	| "gave up after an unsure answer"
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

// The machine's transitions (decision 179), from one state, event and row context.
describe("the Jev retry machine", () => {
	const at = (attempts: number, categorized = false, answered = false) => ({
		attempts,
		categorized,
		answered,
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

	// An unsure row is still asked about its income question, so its failures count like a waiting row's.
	it("unsure counts a failed income question and gives up at the cap", () => {
		expect(
			next(jevRetry, "unsure", "JEV_FAILED", at(CAP - 2, false, true)),
		).toBe("unsure");
		expect(
			next(jevRetry, "unsure", "JEV_FAILED", at(CAP - 1, false, true)),
		).toBe("gave_up");
	});

	it("unsure stays unsure on an answer, since its category question is not asked again", () => {
		expect(next(jevRetry, "unsure", "JEV_ANSWERED", at(2, true, true))).toBe(
			"unsure",
		);
	});

	it("unsure: ASK_AGAIN goes to waiting, and ROW_CHANGED stays unsure", () => {
		expect(next(jevRetry, "unsure", "ASK_AGAIN", at(0, false, true))).toBe(
			"waiting",
		);
		expect(next(jevRetry, "unsure", "ROW_CHANGED", at(0, false, true))).toBe(
			"unsure",
		);
	});

	// gave_up wins over unsure: a row that gave up after an unsure answer keeps the answer, so a changed bank text
	// leaves it unsure, and a row with no answer goes to waiting.
	it("gave_up after an unsure answer: ROW_CHANGED goes to unsure, and without an answer to waiting", () => {
		expect(next(jevRetry, "gave_up", "ROW_CHANGED", at(CAP, false, true))).toBe(
			"unsure",
		);
		expect(
			next(jevRetry, "gave_up", "ROW_CHANGED", at(CAP, false, false)),
		).toBe("waiting");
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

// A failed ask is one of Jev's asks on a row that may already have a category (its details or its income question). It
// is stamped, so the row goes behind the rows that have not failed, and it counts toward the cap only while the row is
// waiting or unsure (decision 179).
describe("a failed ask stamps a row that is still asked and counts only a waiting or unsure one", () => {
	async function stampedAfterFailure(id: number): Promise<boolean> {
		await markJevFailedStatement(db, id).run();
		return (await snapshot(id)).failed;
	}

	it("a waiting row is stamped", async () => {
		expect(await stampedAfterFailure(await addRow("WAITING ROW"))).toBe(true);
	});

	it("an unsure row is stamped and counted, and stops being asked at the cap", async () => {
		const id = await addRow("UNSURE ROW");
		await db
			.prepare("UPDATE transactions SET category_confidence = 0.5 WHERE id = ?")
			.bind(id)
			.run();
		expect(await stampedAfterFailure(id)).toBe(true);
		expect((await snapshot(id)).attempts).toBe(1);
		for (let failure = 2; failure <= CAP; failure++) {
			await markJevFailedStatement(db, id).run();
		}
		expect((await snapshot(id)).attempts).toBe(CAP);
		expect(await isPending(id)).toBe(false);
	});

	it("a filed row is stamped, so it goes behind the rows that have not failed, but is not counted", async () => {
		const id = await addRow("FILED ROW");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = 0.9 WHERE id = ?",
			)
			.bind(EATING_OUT, id)
			.run();
		expect(await stampedAfterFailure(id)).toBe(true);
		expect((await snapshot(id)).attempts).toBe(0);
	});

	it("a row that has given up is not stamped", async () => {
		const id = await addRow("GAVE UP ROW");
		await db
			.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
			.bind(CAP, id)
			.run();
		expect(await stampedAfterFailure(id)).toBe(false);
		expect((await snapshot(id)).attempts).toBe(CAP);
	});
});

// Every writer, from every state, against the machine (decision 179). A row is built in each state, the real writer
// runs (the failure statement, the sorting run's answer, ask again, or the bank-text trigger), and the row is read
// back. Where the machine allows the event, the row must reach the machine's state. Where it refuses, the row's retry
// columns must be exactly as they were. There are no exceptions to this grid. JEV_FAILED is allowed from waiting and
// unsure, and refused from gave up and filed. JEV_ANSWERED is allowed from waiting (filed or unsure, by the reply) and
// from unsure (unsure, with the count reset), and refused from gave up and filed.
describe("every writer agrees with the machine, state by state", () => {
	// Each kind of row, with the state the machine says it is in. A row with a category in any way is filed, so the
	// person's and the merchant rule's categories are grid rows too, not just Jev's.
	const ROWS: { kind: RowKind; state: JevRetryState }[] = [
		{ kind: "waiting", state: "waiting" },
		{ kind: "gave_up", state: "gave_up" },
		{ kind: "unsure", state: "unsure" },
		{ kind: "gave up after an unsure answer", state: "gave_up" },
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
		if (kind === "gave_up" || kind === "gave up after an unsure answer") {
			await db
				.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
				.bind(CAP, id)
				.run();
		}
		if (kind === "unsure" || kind === "gave up after an unsure answer") {
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
			// Only a row the sorting run asks is answered. A waiting row's category question and an unsure row's income
			// question are what Jev is asked about, so the reply decides what the writer keeps. A gave-up row is not
			// asked, and a filed row's category question is not asked again.
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
					answered: before.confidence !== null,
				});
				await fire(event, id);
				const after = await snapshot(id);
				if (expected === null) {
					// A filed row that is still asked is stamped by a failed ask, so it goes behind the rows that have
					// not failed. The machine decides the count and the state, so only the stamp is left out of the
					// comparison, and only for that one pair.
					const stampOnly = state === "filed" && event.name === "JEV_FAILED";
					expect(after).toEqual(
						stampOnly ? { ...before, failed: after.failed } : before,
					);
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

// An unsure row is still asked about its income question, so its failures count. Once it gives up, a run no longer
// asks it, and the rows beside it still run (decision 179).
describe("an unsure row whose income question keeps failing", () => {
	it("gives up at the cap, and a later run no longer asks it, so the rows beside it still run", async () => {
		const unsure = await addRow("HOPELESS UNSURE");
		await db
			.prepare("UPDATE transactions SET category_confidence = 0.5 WHERE id = ?")
			.bind(unsure)
			.run();
		for (let run = 0; run < CAP; run++) await sortRun([unsure]);
		expect(callsFor("HOPELESS UNSURE")).toBe(CAP);
		expect(await attempts(unsure)).toBe(CAP);

		const one = await addRow("HOPELESS ONE");
		const two = await addRow("HOPELESS TWO");
		await sortRun([unsure, one, two]);
		expect(callsFor("HOPELESS UNSURE")).toBe(CAP);
		expect(callsFor("HOPELESS ONE")).toBe(1);
		expect(callsFor("HOPELESS TWO")).toBe(1);
	});
});

// What the answer writer does to the retry columns of a row with no category, and to a row a person filed.
const answerWith = (categoryId: number | null, confidence: number) =>
	({
		categoryId,
		suggestedCategoryId: categoryId,
		confidence,
		flags: { transfer: false, reimbursement: false, income: false },
	}) as Decision;

describe("the answer writer and the failure columns", () => {
	it("pins what it writes to a person-filed row: the person's category stays, and Jev's confidence is stored", async () => {
		const id = await addRow("PERSON FILED");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(EATING_OUT, id)
			.run();
		await saveJevResultStatements(
			db,
			id,
			answerWith(EATING_OUT, 0.9),
		).update.run();
		expect(
			await db
				.prepare(
					"SELECT category_id AS c, category_source AS s, category_confidence AS k FROM transactions WHERE id = ?",
				)
				.bind(id)
				.first(),
		).toEqual({ c: EATING_OUT, s: "user", k: 0.9 });
	});

	it("an answer to an unsure row, with no category, sets its failure count to 0", async () => {
		const id = await addRow("UNSURE SUCCESS");
		await db
			.prepare(
				"UPDATE transactions SET category_confidence = 0.5, jev_attempts = 3 WHERE id = ?",
			)
			.bind(id)
			.run();
		await saveJevResultStatements(db, id, answerWith(null, 0.5)).update.run();
		expect(await attempts(id)).toBe(0);
	});

	it("an answer to a row a person filed keeps its failure count", async () => {
		const id = await addRow("PERSON FAILED THEN FILED");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user', jev_attempts = 3 WHERE id = ?",
			)
			.bind(EATING_OUT, id)
			.run();
		await saveJevResultStatements(
			db,
			id,
			answerWith(EATING_OUT, 0.9),
		).update.run();
		expect(await attempts(id)).toBe(3);
	});
	it("a details-only answer to a row with no category sets its failure count to 0", async () => {
		const id = await addRow("DETAILS ONLY SUCCESS");
		await db
			.prepare("UPDATE transactions SET jev_attempts = 4 WHERE id = ?")
			.bind(id)
			.run();
		await saveJevDetailsStatement(db, [
			{ id, kind: null, forPersonId: null, noteWorthWriting: 0 },
		])?.run();
		expect(await attempts(id)).toBe(0);
	});

	it("a details-only answer to a row a person filed keeps its failure count", async () => {
		const id = await addRow("DETAILS ONLY FILED");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user', jev_attempts = 3 WHERE id = ?",
			)
			.bind(EATING_OUT, id)
			.run();
		await saveJevDetailsStatement(db, [
			{ id, kind: null, forPersonId: null, noteWorthWriting: 0 },
		])?.run();
		expect(await attempts(id)).toBe(3);
	});
	it("a details-only answer does not reopen a row that has given up", async () => {
		const id = await addRow("DETAILS AFTER CAP");
		await db
			.prepare("UPDATE transactions SET jev_attempts = ? WHERE id = ?")
			.bind(CAP, id)
			.run();
		const before = await snapshot(id);
		await saveJevDetailsStatement(db, [
			{ id, kind: null, forPersonId: null, noteWorthWriting: 0 },
		])?.run();
		expect(await snapshot(id)).toEqual(before);
	});
});

// The pending row's failure count goes with the purchase to its posted row, as Jev's answers do, while the question is
// the same one (decision 179). A changed question starts over.
describe("the pending-to-posted merge and the failure count", () => {
	let lock = 0;

	async function mergeWith(
		pending: { attempts: number },
		posted: { name: string; categoryId?: number | null },
	): Promise<Snapshot> {
		lock += 1;
		const key = `merge-${lock}`;
		const item = (
			await db
				.prepare("SELECT id FROM plaid_items ORDER BY id LIMIT 1")
				.first<{ id: number }>()
		)?.id as number;
		await db
			.prepare("UPDATE plaid_items SET sync_lock_id = ? WHERE id = ?")
			.bind(`lock-${key}`, item)
			.run();
		const insert = (
			plaidId: string,
			isPending: number,
			name: string,
			attemptCount: number,
			categoryId: number | null,
		) =>
			db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id, pending, jev_attempts, jev_failed_at, category_id, category_source, updated_by)
					 VALUES ((SELECT MIN(id) FROM accounts), ?, -600, ?, ?, ?, ?, CASE WHEN ? > 0 THEN datetime('now') END, ?, ?, 'test') RETURNING id`,
				)
				.bind(
					TODAY,
					name,
					plaidId,
					isPending,
					attemptCount,
					isPending === 1 ? attemptCount : 0,
					categoryId,
					categoryId === null ? null : "user",
				)
				.first<{ id: number }>();
		await insert(`pend-${key}`, 1, "CORNER COFFEE", pending.attempts, null);
		const postedRow = await insert(
			`post-${key}`,
			0,
			posted.name,
			0,
			posted.categoryId ?? null,
		);
		await db.batch(
			mergePendingIntoPosted(db, item, `lock-${key}`, `pend-${key}`, {
				id: `post-${key}`,
				cents: -600,
				date: TODAY,
				name: posted.name,
				merchantName: null,
				plaidCategory: null,
			}),
		);
		return snapshot(Number(postedRow?.id));
	}

	it("carries a pending row's count and failure stamp onto the posted row when the bank text is the same", async () => {
		const merged = await mergeWith(
			{ attempts: CAP },
			{ name: "CORNER COFFEE" },
		);
		expect(merged.attempts).toBe(CAP);
		// The stamp goes with the count, so a row nothing will ask again is not still counted as waiting.
		expect(merged.failed).toBe(true);
	});

	it("starts over when the posted row's bank text is different", async () => {
		const merged = await mergeWith(
			{ attempts: CAP },
			{ name: "CORNER COFFEE #12" },
		);
		expect(merged.attempts).toBe(0);
		expect(merged.failed).toBe(false);
	});

	it("leaves a posted row that already has a category alone", async () => {
		const merged = await mergeWith(
			{ attempts: CAP },
			{ name: "CORNER COFFEE", categoryId: EATING_OUT },
		);
		expect(merged.attempts).toBe(0);
		expect(merged.failed).toBe(false);
	});
});
