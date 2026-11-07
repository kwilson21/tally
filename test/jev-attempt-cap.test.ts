import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgainMany } from "../src/categorize-pending";
import { saveAiSwitches } from "../src/db/ai-switches";
import { pendingForJev } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { sortGroups } from "../src/sort-groups";
import { fakeSteps } from "./fake-sort-steps";
import { recordSorting } from "./record-sorting";

// A row Jev can never answer stops being asked after JEV_ATTEMPT_CAP failures (decision 169). Only a person's
// "ask again" or a change to the row's bank text, name, amount or account starts its count again.

const db = env.DB;
const TODAY = "2026-09-22";
const CAP = 5;
const withKey = { DB: db, JEV_API_KEY: "test-key" };
const create = recordSorting();

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
async function sortRun(ids: number[]) {
	const fake = fakeSteps();
	await sortGroups(withKey, fake.runStep, fetchImpl, {
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
	it("is categorized, keeps no failure count, and is not capped", async () => {
		const id = await addRow("GOOD BANK TEXT");
		await sortRun([id]);
		expect(await categoryOf(id)).not.toBeNull();
		expect(await attempts(id)).toBe(0);
	});
});
