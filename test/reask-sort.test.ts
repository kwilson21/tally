import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/ai/decide";
import { categorizePending } from "../src/categorize-pending";
import { householdToday } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import type {
	ResortCandidate,
	ResortSnapshot,
} from "../src/db/resort-candidates";
import {
	finishRun,
	readRun,
	reaskClearStatement,
	reaskRestoreStatement,
	startOrJoinRun,
} from "../src/db/resort-run";
import { releaseSortingTurn, takeSortingTurn } from "../src/db/sorting-turn";
import { saveJevResult } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { buildClusters } from "../src/resort-clusters";
import { sortGroups } from "../src/sort-groups";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

// The re-sort's re-ask through the sort path (decisions 157, 160): a `reask` run asks Jev once more about its own
// candidate rows only, clearing their Maybe mark under the sorting turn, category-only, and finishing the run.

const db = env.DB;
const TODAY = "2026-09-22";
const withKey = { DB: db, JEV_API_KEY: "test-key" };

/** A Jev reply: Eating Out at the given confidence, with flags that are all no. */
const reply = (confidence: number, flags: { transfer?: number } = {}) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence },
				transfer: { type: "noul", noul: flags.transfer ?? 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

/** A Jev reply for a chosen category, with its confidence and an optional mixed reading (decision 90, #233). */
const replyFor = (
	choice: string,
	confidence: number,
	mixed?: { probability: number; also: string },
) =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice, confidence },
				...(mixed
					? {
							mixed: { type: "noul", noul: mixed.probability },
							also_category: {
								type: "choice",
								choice: mixed.also,
								confidence: 0.5,
							},
						}
					: {}),
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

/** A Jev reply that also answers the details questions, as a run with details on would get. */
const replyWithDetails = () =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
				kind: { type: "choice", choice: "one_off", confidence: 0.9 },
				for_person: { type: "choice", choice: "none", confidence: 0.9 },
				note_worth_writing: { type: "noul", noul: 0.9 },
			},
		}),
		{ status: 200 },
	);

/** Jev's answers in call order, the last one repeated. */
function fakeJev(...responses: (() => Response | Promise<Response>)[]) {
	let calls = 0;
	const fetchImpl = vi.fn(async () => {
		const respond = responses[Math.min(calls, responses.length - 1)];
		calls += 1;
		return await (respond as () => Response | Promise<Response>)();
	});
	return { fetchImpl, calls: () => calls };
}

let seq = 0;
type Seed = {
	date?: string;
	/** The bank's raw text; a row's default is unique, so it never groups with another. */
	rawName?: string;
	amount?: number;
	confidence?: number | null;
	categoryId?: number | null;
	categorySource?: string | null;
	note?: string | null;
	plaid?: string | null;
};

/** Inserts one purchase, unique in its name and Plaid id, and returns its id. */
async function addRow(seed: Seed = {}): Promise<number> {
	seq += 1;
	const row = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_confidence, category_id, category_source, note, plaid_transaction_id)
			 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		)
		.bind(
			seed.date ?? TODAY,
			seed.amount ?? 1234,
			seed.rawName ?? `REASK ROW ${seq}`,
			seed.confidence ?? null,
			seed.categoryId ?? null,
			seed.categorySource ?? null,
			seed.note ?? null,
			seed.plaid === undefined ? `plaid-row-${seq}` : seed.plaid,
		)
		.first<{ id: number }>();
	return Number(row?.id);
}

const COLUMNS = `id, category_id, category_source, category_confidence, jev_category_id, jev_none_fit,
	jev_mixed, jev_also_category_id, jev_failed_at`;

async function snapshotOf(id: number): Promise<ResortSnapshot> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM transactions WHERE id = ?`)
		.bind(id)
		.first<ResortSnapshot>();
	return row as ResortSnapshot;
}

/** The whole row's state, for checks that nothing else changed. */
const rowState = (id: number) =>
	db
		.prepare(
			`SELECT t.*, t.category_id AS c FROM transactions t WHERE t.id = ?`,
		)
		.bind(id)
		.first<Record<string, unknown>>();

/** A row's identity as the run holds it (its Plaid id and amount), for the helpers that check it. */
const identityOf = async (id: number) =>
	(await db
		.prepare(
			"SELECT plaid_transaction_id AS plaid, amount_cents AS amount FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{ plaid: string | null; amount: number }>()) ?? {
		plaid: null,
		amount: 0,
	};

/** A mark for a row with this confidence, carrying the row's identity (for the clear and restore helpers). */
const markAt = async (id: number, confidence: number | null) => ({
	id,
	confidence,
	mixed: null,
	also: null,
	...(await identityOf(id)),
});

const confOf = async (id: number) =>
	(
		await db
			.prepare("SELECT category_confidence AS v FROM transactions WHERE id = ?")
			.bind(id)
			.first<{ v: number | null }>()
	)?.v ?? null;

const field = async (id: number, column: string) =>
	(
		await db
			.prepare(`SELECT ${column} AS v FROM transactions WHERE id = ?`)
			.bind(id)
			.first<{ v: unknown }>()
	)?.v ?? null;

async function categoryIdByName(name: string): Promise<number> {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();
	return Number(row?.id);
}

/** The candidates the run holds for these rows, in this order: the identity and text each row has now. */
async function candidatesOf(ids: number[]): Promise<ResortCandidate[]> {
	const candidates: ResortCandidate[] = [];
	for (const id of ids) {
		// The identity the run stores is the one the row has now: its Plaid id and amount, read with its snapshot.
		const row = await db
			.prepare(
				"SELECT date, amount_cents AS amount, plaid_transaction_id AS plaid, raw_name AS rawName, note FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{
				date: string;
				amount: number;
				plaid: string | null;
				rawName: string;
				note: string | null;
			}>();
		candidates.push({
			id,
			date: row?.date ?? TODAY,
			amountCents: row?.amount ?? 0,
			plaidTransactionId: row?.plaid ?? null,
			rawName: row?.rawName ?? "",
			merchantKey: "",
			mixed: false,
			whatItWasNote: row?.note ?? null,
			snapshot: await snapshotOf(id),
		});
	}
	return candidates;
}

/** The clusters the start path would hand the re-ask for these rows (decision 158): each `[leader, ...followers]`. */
const clustersOf = async (ids: number[]) =>
	buildClusters(await candidatesOf(ids));

/** Starts the re-sort run over these rows (in this order) and returns its id. */
async function startRun(ids: number[]): Promise<string> {
	const started = await startOrJoinRun(db, {
		candidates: await candidatesOf(ids),
		categoryId: await categoryIdByName("Eating Out"),
		categoryName: "Eating Out",
		now: Date.now(),
	});
	if (started.runId === null) throw new Error("no run started");
	return started.runId;
}

const callsUsed = async () =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${await householdToday(db)}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

const runRow = () =>
	db
		.prepare("SELECT value FROM household_settings WHERE key = 'resort_run'")
		.first<{ value: string }>();

const movedRow = (runId: string) =>
	db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(`resort_moved_${runId}`)
		.first<{ value: string }>();

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a re-ask asks only the run's rows", () => {
	it("asks the run's rows only, in the order given, 25 a group", async () => {
		const others = [await addRow(), await addRow(), await addRow()];
		const ids: number[] = [];
		for (let i = 0; i < 27; i++) ids.push(await addRow());
		// Oldest id first: pendingForJev would give the newest first, so this checks the run's order is kept.
		const order = [...ids];
		const runId = await startRun(order);
		const fake = fakeSteps();
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			bySync: true,
			runId: "reask-order",
			reask: { runId, ids: order },
		});
		const asks = fake.names().filter((name) => name.includes("-ask-"));
		expect(asks).toEqual([
			...order.slice(0, 25).map((id) => `group-1-ask-${id}`),
			...order.slice(25).map((id) => `group-2-ask-${id}`),
		]);
		for (const id of others)
			expect(asks.some((name) => name.endsWith(`-${id}`))).toBe(false);
		expect(done.asked).toBe(27);
		expect(fetchImpl).toHaveBeenCalledTimes(27);
		expect(await callsUsed()).toBe(27);
	});
});

describe("a Maybe row is cleared, asked again, and kept or filed by the answer", () => {
	it("files a confident answer and keeps an unsure one as a Maybe with its new confidence", async () => {
		const a = await addRow({ date: "2026-09-22", confidence: 0.55 });
		const b = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const runId = await startRun([a, b]);
		const seenAtAsk: (number | null)[] = [];
		const jev = fakeJev(
			() => reply(0.9),
			() => reply(0.6),
		);
		const fetchImpl = vi.fn(async () => {
			seenAtAsk.push(await confOf(a));
			return jev.fetchImpl();
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-maybe",
			reask: { runId, ids: [a, b] },
		});
		// The mark was cleared before the ask, so the ask was made for a row Jev had not answered.
		expect(seenAtAsk[0]).toBeNull();
		expect(await field(a, "category_id")).toBe(
			await categoryIdByName("Eating Out"),
		);
		expect(await field(a, "category_source")).toBe("jev");
		expect(await confOf(a)).toBe(0.9);
		expect(await field(b, "category_id")).toBeNull();
		expect(await field(b, "category_source")).toBeNull();
		expect(await confOf(b)).toBe(0.6);
	});
});

describe("rows that are not Maybes are never cleared or asked", () => {
	it("leaves a row at 0.80 or above, and a decided row, untouched and unasked", async () => {
		const confident = await addRow({ confidence: 0.85 });
		const decided = await addRow({
			categoryId: await categoryIdByName("Groceries"),
			categorySource: "user",
		});
		const ruled = await addRow({
			categoryId: await categoryIdByName("Groceries"),
			categorySource: "merchant_rule",
		});
		const waiting = await addRow();
		const before = [
			await rowState(confident),
			await rowState(decided),
			await rowState(ruled),
		];
		const runId = await startRun([confident, decided, ruled, waiting]);
		const fake = fakeSteps();
		await sortGroups(
			withKey,
			fake.runStep,
			fakeJev(() => reply(0.9)).fetchImpl,
			{
				rulesApplied: true,
				runId: "reask-untouched",
				reask: { runId, ids: [confident, decided, ruled, waiting] },
			},
		);
		const asks = fake.names().filter((name) => name.includes("-ask-"));
		expect(asks).toEqual([`group-1-ask-${waiting}`]);
		expect([
			await rowState(confident),
			await rowState(decided),
			await rowState(ruled),
		]).toEqual(before);
	});
});

describe("no other sort path is affected", () => {
	it("a normal run never re-asks a Maybe row (decision 27)", async () => {
		const maybe = await addRow({ confidence: 0.55 });
		const waiting = await addRow();
		const fake = fakeSteps();
		const fetchImpl = fakeJev(() => reply(0.9));
		await sortGroups(withKey, fake.runStep, fetchImpl.fetchImpl, {
			rulesApplied: true,
			onlyIds: [maybe, waiting],
			runId: "normal-maybe",
		});
		const asks = fake.names().filter((name) => name.includes("-ask-"));
		expect(asks).toEqual([`group-1-ask-${waiting}`]);
		expect(await confOf(maybe)).toBe(0.55);
	});

	it("a normal run that starts while the re-ask holds the turn never sees a cleared mark", async () => {
		const a = await addRow({ confidence: 0.55 });
		const b = await addRow({ confidence: 0.55 });
		const runId = await startRun([a, b]);
		const normalFetch = vi.fn(async () => reply(0.9));
		let markDuringAsk: number | null | undefined;
		const fetchImpl = vi.fn(async () => {
			markDuringAsk = await confOf(a);
			// The re-ask holds the turn here, so a normal sort's read finds it busy and asks nothing.
			await sortGroups(withKey, fakeSteps().runStep, normalFetch, {
				rulesApplied: true,
				runId: "normal-during",
			});
			return reply(0.6);
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-holds",
			reask: { runId, ids: [a, b] },
		});
		expect(markDuringAsk).toBeNull();
		expect(normalFetch).not.toHaveBeenCalled();
	});

	it("a re-ask that finds another group holding the turn asks nothing and changes no mark", async () => {
		const a = await addRow({ confidence: 0.55 });
		const runId = await startRun([a]);
		expect(await takeSortingTurn(db, "other-group:1")).toBe(true);
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-busy",
			reask: { runId, ids: [a] },
		});
		expect(done.asked).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(await confOf(a)).toBe(0.55);
		await releaseSortingTurn(db, "other-group:1");
	});
});

describe("a person's answer during the run wins", () => {
	it("leaves a row a person categorised meanwhile, and a row whose fields changed, as they are", async () => {
		const first = await addRow({ date: "2026-09-22" });
		const decided = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const changed = await addRow({ date: "2026-09-20", confidence: 0.55 });
		const runId = await startRun([first, decided, changed]);
		const groceries = await categoryIdByName("Groceries");
		const jev = fakeJev(
			async () => {
				// A person files one row and edits another while the run asks.
				await db
					.prepare(
						"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
					)
					.bind(groceries, decided)
					.run();
				await db
					.prepare("UPDATE transactions SET note = 'edited' WHERE id = ?")
					.bind(changed)
					.run();
				return reply(0.9);
			},
			() => reply(0.9),
			() => reply(0.9),
		);
		await sortGroups(withKey, fakeSteps().runStep, jev.fetchImpl, {
			rulesApplied: true,
			runId: "reask-person",
			reask: { runId, ids: [first, decided, changed] },
		});
		expect(await field(decided, "category_id")).toBe(groceries);
		expect(await field(decided, "category_source")).toBe("user");
		// The edited row's answer doesn't apply (its seen fields changed), and its mark stays cleared, so the sort the
		// edit started can still ask Jev about the clarification (#831 round 2).
		expect(await field(changed, "category_id")).toBeNull();
		expect(await confOf(changed)).toBeNull();
	});
});

describe("the ask is category-only", () => {
	it("writes no flags, excludes, income, or details for a re-ask row, and keeps its category", async () => {
		const purchase = await addRow({ confidence: 0.55 });
		const runId = await startRun([purchase]);
		await saveAiSwitches(db, { details: true });
		const fake = fakeSteps();
		await sortGroups(
			withKey,
			fake.runStep,
			fakeJev(() => replyWithDetails()).fetchImpl,
			{
				rulesApplied: true,
				runId: "reask-category-only",
				reask: { runId, ids: [purchase] },
			},
		);
		expect(await field(purchase, "category_id")).toBe(
			await categoryIdByName("Eating Out"),
		);
		expect(await field(purchase, "flag_transfer")).toBe(0);
		expect(await field(purchase, "flag_reimbursement")).toBe(0);
		expect(await field(purchase, "excluded")).toBe(0);
		expect(await field(purchase, "excluded_source")).toBeNull();
		expect(await field(purchase, "transfer_confidence")).toBeNull();
		expect(await field(purchase, "income_source")).toBeNull();
		expect(await field(purchase, "income_confidence")).toBeNull();
		expect(await field(purchase, "flag_income")).toBe(0);
		expect(await field(purchase, "details_asked")).toBe(0);
		expect(await field(purchase, "kind")).toBeNull();
		expect(await field(purchase, "for_person_id")).toBeNull();
		expect(await field(purchase, "note")).toBeNull();
	});

	it("a purchase Jev would call a transfer stays a purchase, whatever the answer", async () => {
		const purchase = await addRow({ confidence: 0.55 });
		const runId = await startRun([purchase]);
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			fakeJev(() => reply(0.9, { transfer: 0.99 })).fetchImpl,
			{
				rulesApplied: true,
				runId: "reask-transfer",
				reask: { runId, ids: [purchase] },
			},
		);
		expect(await field(purchase, "excluded")).toBe(0);
		expect(await field(purchase, "flag_transfer")).toBe(0);
		expect(await field(purchase, "category_id")).toBe(
			await categoryIdByName("Eating Out"),
		);
	});
});

describe("progress, finish and restore", () => {
	it("counts the rows handled, never past the total, and finishes the run once", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 4; i++) ids.push(await addRow({ confidence: 0.55 }));
		const runId = await startRun(ids);
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: env.DEMO },
			fakeJev(() => reply(0.9)).fetchImpl,
			{ rulesApplied: true, reask: { runId, ids } },
		);
		const run = await readRun(db);
		expect(run?.status).toBe("done");
		expect(run?.done).toBe(4);
		expect(run?.done).toBeLessThanOrEqual(run?.total ?? 0);
		const before = [(await runRow())?.value, (await movedRow(runId))?.value];
		await finishRun(db, { runId, now: Date.now() + 5_000 });
		expect([(await runRow())?.value, (await movedRow(runId))?.value]).toEqual(
			before,
		);
	});

	it("restores the marks of rows the run never reached (the daily cap ran out)", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 6; i++) ids.push(await addRow({ confidence: 0.55 }));
		const runId = await startRun(ids);
		// 37 of the demo's 40 calls are used today, so the group may ask 3.
		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, '37')")
			.bind(`jev_calls_${await householdToday(db)}`)
			.run();
		const fetchImpl = vi.fn(async () => reply(0.9));
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-cap",
			reask: { runId, ids },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(await callsUsed()).toBe(40);
		// Not reached: the mark is back, in this group's own save, before any other sort can read the rows.
		for (const id of ids.slice(3)) expect(await confOf(id)).toBe(0.55);
		expect(await confOf(ids[0] as number)).toBe(0.9);
		expect((await readRun(db))?.status).toBe("running");
		await finishRun(db, { runId, now: Date.now() });
		expect(await callsUsed()).toBe(40);
		for (const id of ids.slice(3)) expect(await confOf(id)).toBe(0.55);
		const record = JSON.parse((await movedRow(runId))?.value ?? "{}") as {
			rows: unknown[];
		};
		expect(record.rows).toHaveLength(3);
	});

	it("the first 25 rows all decided by a person meanwhile do not stop the run", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 27; i++) ids.push(await addRow({ confidence: 0.55 }));
		const runId = await startRun(ids);
		const groceries = await categoryIdByName("Groceries");
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-1-read" || attempt !== 1) return;
				await db
					.prepare(
						"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id IN (SELECT value FROM json_each(?))",
					)
					.bind(groceries, JSON.stringify(ids.slice(0, 25)))
					.run();
			},
		});
		const fetchImpl = vi.fn(async () => reply(0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-decided",
			reask: { runId, ids },
		});
		expect(done.asked).toBe(2);
		expect(fake.names().filter((name) => name.includes("-ask-"))).toEqual([
			`group-1-ask-${ids[25]}`,
			`group-1-ask-${ids[26]}`,
		]);
		expect(await field(ids[0] as number, "category_source")).toBe("user");
	});

	it("a normal sort between groups never asks the rows a group has not reached", async () => {
		const ids: number[] = [];
		for (let i = 0; i < 27; i++) ids.push(await addRow({ confidence: 0.55 }));
		const runId = await startRun(ids);
		const normalFetch = vi.fn(async () => reply(0.9));
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-2-read" || attempt !== 1) return;
				await sortGroups(withKey, fakeSteps().runStep, normalFetch, {
					rulesApplied: true,
					onlyIds: ids,
					runId: "normal-between",
				});
			},
		});
		await sortGroups(
			withKey,
			fake.runStep,
			fakeJev(() => reply(0.6)).fetchImpl,
			{
				rulesApplied: true,
				runId: "reask-between",
				reask: { runId, ids },
			},
		);
		expect(normalFetch).not.toHaveBeenCalled();
	});

	it("a row whose ask fails (not service-wide) is marked failed, its mark comes back, and the run goes on", async () => {
		const a = await addRow({ date: "2026-09-22", confidence: 0.55 });
		const b = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const runId = await startRun([a, b]);
		const jev = fakeJev(
			() => new Response("{}", { status: 400 }),
			() => reply(0.9),
		);
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: env.DEMO },
			jev.fetchImpl,
			{ rulesApplied: true, reask: { runId, ids: [a, b] } },
		);
		expect(jev.calls()).toBe(2);
		expect(await field(a, "jev_failed_at")).not.toBeNull();
		expect(await confOf(a)).toBe(0.55);
		expect(await field(b, "category_source")).toBe("jev");
		expect((await readRun(db))?.status).toBe("done");
	});

	it("a service-wide failure ends the run: answered rows are saved, the rest are restored and the run finishes", async () => {
		const a = await addRow({ date: "2026-09-22", confidence: 0.55 });
		const b = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const c = await addRow({ date: "2026-09-20", confidence: 0.55 });
		const runId = await startRun([a, b, c]);
		const jev = fakeJev(
			() => reply(0.9),
			() => new Response("{}", { status: 503 }),
		);
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: env.DEMO },
			jev.fetchImpl,
			{ rulesApplied: true, reask: { runId, ids: [a, b, c] } },
		);
		expect(jev.calls()).toBe(2);
		expect(await field(a, "category_source")).toBe("jev");
		expect(await confOf(b)).toBe(0.55);
		expect(await confOf(c)).toBe(0.55);
		expect((await readRun(db))?.status).toBe("done");
	});

	it("the Workflow path runs the finish step once, after the groups", async () => {
		const a = await addRow({ confidence: 0.55 });
		const runId = await startRun([a]);
		const fake = fakeSteps();
		const params: SortParams = {
			bySync: false,
			rulesApplied: true,
			reask: { runId, ids: [a] },
		};
		await runSortInstance(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: env.DEMO },
			fake.runStep,
			params,
			{
				runId: "workflow-instance",
				fetchImpl: fakeJev(() => reply(0.9)).fetchImpl,
			},
		);
		expect(fake.names().filter((name) => name === "reask-finish")).toHaveLength(
			1,
		);
		expect((await readRun(db))?.status).toBe("done");
	});

	it("a sort that throws still finishes the run in-process", async () => {
		const a = await addRow({ confidence: 0.55 });
		const runId = await startRun([a]);
		// Only the merchant-rules step's write fails, so the sort throws before its groups; the finish still runs.
		const flaky = new Proxy(db, {
			get(target, key) {
				if (key === "prepare")
					return (sql: string) => {
						if (
							sql.includes("UPDATE transactions SET") &&
							sql.includes("merchant_rule")
						)
							throw new Error("rules broke");
						return target.prepare(sql);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await expect(
			categorizePending(
				{ DB: flaky, JEV_API_KEY: "test-key", DEMO: env.DEMO },
				fakeJev(() => reply(0.9)).fetchImpl,
				{ rulesApplied: false, reask: { runId, ids: [a] } },
			),
		).rejects.toThrow("rules broke");
		expect((await readRun(db))?.status).toBe("done");
	});
});

describe("a re-ask writes only while its run is still running (#828)", () => {
	const decision = (categoryId: number): Decision => ({
		categoryId,
		suggestedCategoryId: categoryId,
		confidence: 0.9,
		flags: { transfer: false, reimbursement: false, income: false },
		noneFit: false,
	});

	it("a category answer saved after its run finished writes nothing; while running, it does", async () => {
		const eatingOut = await categoryIdByName("Eating Out");
		const running = await addRow();
		const runIdRunning = await startRun([running]);
		// The run is still running: the answer applies.
		expect(
			await saveJevResult(db, running, decision(eatingOut), {
				reask: {
					runId: runIdRunning,
					plaidTransactionId: (await identityOf(running)).plaid,
					amountCents: (await identityOf(running)).amount,
				},
				categoryAsked: true,
			}),
		).toBe(true);
		await finishRun(db, { runId: runIdRunning, now: Date.now() });

		// A second run, finished before its answer arrives: the same save writes nothing.
		const closed = await addRow();
		const runIdClosed = await startRun([closed]);
		await finishRun(db, { runId: runIdClosed, now: Date.now() });
		expect((await readRun(db))?.status).toBe("done");
		expect(
			await saveJevResult(db, closed, decision(eatingOut), {
				reask: {
					runId: runIdClosed,
					plaidTransactionId: (await identityOf(closed)).plaid,
					amountCents: (await identityOf(closed)).amount,
				},
				categoryAsked: true,
			}),
		).toBe(false);
		expect(await field(closed, "category_id")).toBeNull();
		expect(await field(closed, "category_source")).toBeNull();
	});

	it("a run force-finalized while its group asks: the answer is not written", async () => {
		const maybe = await addRow({ confidence: 0.55 });
		const runId = await startRun([maybe]);
		const fetchImpl = vi.fn(async () => {
			// Forced finalize (no instance key) while the row's ask is in flight.
			await finishRun(db, { runId, now: Date.now() });
			return reply(0.9);
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-forced",
			reask: { runId, ids: [maybe] },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await field(maybe, "category_id")).toBeNull();
		// The finalize's restore put the mark back; the late answer did not overwrite it.
		expect(await confOf(maybe)).toBe(0.55);
		expect((await readRun(db))?.status).toBe("done");
	});
});

/** Deletes the row and inserts a different one under the same id, as an INTEGER PRIMARY KEY reuse does. */
async function reuseId(id: number, fields: { plaid: string; amount: number }) {
	await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();
	await db
		.prepare(
			`INSERT INTO transactions (id, account_id, date, amount_cents, raw_name, plaid_transaction_id)
			 VALUES (?, 1, ?, ?, 'REPLACEMENT ROW', ?)`,
		)
		.bind(id, TODAY, fields.amount, fields.plaid)
		.run();
}

describe("a failed re-ask stamps only the row it asked about (identity, #831 round 2)", () => {
	it("a non-service-wide failure does not stamp a replacement row that reused the asked id", async () => {
		const original = await addRow({ date: TODAY, confidence: 0.55 });
		const control = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const runId = await startRun([original, control]);
		const fetchImpl = vi.fn(async () => {
			if (fetchImpl.mock.calls.length === 1) {
				await reuseId(original, { plaid: "other-plaid", amount: 999 });
			}
			// 400 fails this one ask, not the service: it is marked, and the run goes on.
			return new Response("{}", { status: 400 });
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-reused-failure",
			reask: { runId, ids: [original, control] },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		// The replacement is not stamped as failed.
		expect(await field(original, "raw_name")).toBe("REPLACEMENT ROW");
		expect(await field(original, "jev_failed_at")).toBeNull();
		// The run's own row, still the same transaction, is stamped as it was asked.
		expect(await field(control, "jev_failed_at")).not.toBeNull();
	});
});

describe("a re-ask that a person edits mid-ask leaves its mark cleared (#831 round 2)", () => {
	it("an edited candidate keeps its mark cleared, through the group and the finish; an unchanged unreached one is restored", async () => {
		const edited = await addRow({ date: TODAY, confidence: 0.55 });
		const unchangedA = await addRow({ date: "2026-09-21", confidence: 0.55 });
		const unchangedB = await addRow({ date: "2026-09-20", confidence: 0.55 });
		const runId = await startRun([edited, unchangedA, unchangedB]);
		// Only the first row is granted today (39 of the demo's 40 calls are used), so the others are unreached.
		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, '39')")
			.bind(`jev_calls_${await householdToday(db)}`)
			.run();
		const fetchImpl = vi.fn(async () => {
			// A person edits the candidate's note while its ask is in flight.
			await db
				.prepare(
					"UPDATE transactions SET note = 'edited by a person' WHERE id = ?",
				)
				.bind(edited)
				.run();
			return reply(0.9);
		});
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: "reask-edited",
			reask: { runId, ids: [edited, unchangedA, unchangedB] },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// The edit's answer is not written, and its mark stays cleared, so the edit's own sort still asks Jev about it.
		expect(await confOf(edited)).toBeNull();
		expect(await field(edited, "category_id")).toBeNull();
		// The rows nobody edited are unreached: their marks are back.
		expect(await confOf(unchangedA)).toBe(0.55);
		expect(await confOf(unchangedB)).toBe(0.55);
		// The finish does not put the edited row's mark back over the edit.
		await finishRun(db, { runId, now: Date.now() });
		expect(await confOf(edited)).toBeNull();
		expect(await confOf(unchangedA)).toBe(0.55);
	});
});

describe("a re-ask writes only to the row it asked about (identity, #831)", () => {
	const cases: [string, number][] = [
		["a different Plaid id and amount", 999],
		["the same amount and a different Plaid id", 1234],
	];
	for (const [label, amount] of cases) {
		it(`a stale answer does not reach a replacement row with ${label}; the run's other row is still answered`, async () => {
			const original = await addRow({ date: TODAY, confidence: 0.55 });
			const control = await addRow({ date: "2026-09-21", confidence: 0.55 });
			const runId = await startRun([original, control]);
			const fetchImpl = vi.fn(async () => {
				if (fetchImpl.mock.calls.length === 1) {
					// The original is deleted and its id reused while its ask is in flight.
					await reuseId(original, { plaid: "other-plaid", amount });
				}
				return reply(0.9);
			});
			await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
				rulesApplied: true,
				runId: "reask-reused-id",
				reask: { runId, ids: [original, control] },
			});
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			// The replacement is not written: no category, no mark, and its own data as it was.
			expect(await field(original, "raw_name")).toBe("REPLACEMENT ROW");
			expect(await field(original, "category_id")).toBeNull();
			expect(await field(original, "category_source")).toBeNull();
			expect(await field(original, "category_confidence")).toBeNull();
			// The control row, still the run's own, is answered as usual.
			expect(await field(control, "category_source")).toBe("jev");
		});
	}
});

describe("restore of a cleared mark, and updated_at", () => {
	const OLD = "2000-01-01 00:00:00";
	const stamp = (id: number) => field(id, "updated_at");

	it("finish restores an unreached Maybe candidate whose mark a cut-off instance left cleared", async () => {
		const maybe = await addRow({ confidence: 0.55 });
		const runId = await startRun([maybe]);
		// The instance read and cleared the row, then stopped before its save: the mark is still cleared.
		expect(await takeSortingTurn(db, "cut-off:1")).toBe(true);
		await db.batch([
			reaskClearStatement(db, [await markAt(maybe, 0.55)], "cut-off:1"),
		]);
		expect(await confOf(maybe)).toBeNull();
		await releaseSortingTurn(db, "cut-off:1");
		await finishRun(db, { runId, now: Date.now() });
		expect(await confOf(maybe)).toBe(0.55);
	});

	it("finish leaves updated_at alone on a row whose restore changes nothing", async () => {
		const untouched = await addRow();
		const runId = await startRun([untouched]);
		await db
			.prepare("UPDATE transactions SET updated_at = ? WHERE id = ?")
			.bind(OLD, untouched)
			.run();
		await finishRun(db, { runId, now: Date.now() });
		expect(await stamp(untouched)).toBe(OLD);
	});

	it("finish bumps updated_at on a row whose restore changes a value", async () => {
		const maybe = await addRow({ confidence: 0.55 });
		const runId = await startRun([maybe]);
		expect(await takeSortingTurn(db, "cut-off:2")).toBe(true);
		await db.batch([
			reaskClearStatement(db, [await markAt(maybe, 0.55)], "cut-off:2"),
		]);
		await releaseSortingTurn(db, "cut-off:2");
		await db
			.prepare("UPDATE transactions SET updated_at = ? WHERE id = ?")
			.bind(OLD, maybe)
			.run();
		await finishRun(db, { runId, now: Date.now() });
		expect(await confOf(maybe)).toBe(0.55);
		expect(await stamp(maybe)).not.toBe(OLD);
	});

	it("a re-ask restore bumps updated_at only when the mark it puts back is a value", async () => {
		const withMark = await addRow({ confidence: 0.55 });
		const noMark = await addRow();
		await db
			.prepare("UPDATE transactions SET updated_at = ? WHERE id IN (?, ?)")
			.bind(OLD, withMark, noMark)
			.run();
		expect(await takeSortingTurn(db, "stamp:1")).toBe(true);
		await db.batch([
			reaskClearStatement(
				db,
				[await markAt(withMark, 0.55), await markAt(noMark, null)],
				"stamp:1",
			),
		]);
		await db.batch([
			reaskRestoreStatement(db, await markAt(withMark, 0.55), "stamp:1"),
			reaskRestoreStatement(db, await markAt(noMark, null), "stamp:1"),
		]);
		await releaseSortingTurn(db, "stamp:1");
		expect(await confOf(withMark)).toBe(0.55);
		expect(await stamp(withMark)).not.toBe(OLD);
		expect(await stamp(noMark)).toBe(OLD);
	});

	it("the finish of an in-process sort records its instance key", async () => {
		const a = await addRow({ confidence: 0.55 });
		const runId = await startRun([a]);
		await categorizePending(
			{ DB: db, JEV_API_KEY: "test-key", DEMO: env.DEMO },
			fakeJev(() => reply(0.9)).fetchImpl,
			{ rulesApplied: true, reask: { runId, ids: [a] } },
		);
		const run = await readRun(db);
		expect(run?.status).toBe("done");
		expect(run?.finishedKeys).toHaveLength(1);
	});
});

describe("a re-ask sends the learned line that applies (decision 156)", () => {
	it("sends the line of its cleaned text as category only, and files the answer category-only", async () => {
		const eatingOut = await categoryIdByName("Eating Out");
		for (const day of ["01", "02"])
			await db
				.prepare(
					"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source, updated_at) VALUES (1, ?, 100, 'RESORT LINE SHOP', ?, 'user', '2020-01-01 00:00:00')",
				)
				.bind(`2026-08-${day}`, eatingOut)
				.run();
		const purchase = await addRow({
			rawName: "RESORT LINE SHOP",
			confidence: 0.55,
		});
		const runId = await startRun([purchase]);
		const sent: { state: Record<string, unknown> }[] = [];
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			vi.fn(async (_url: string, init?: RequestInit) => {
				sent.push(JSON.parse(String(init?.body)));
				return reply(0.9);
			}),
			{
				rulesApplied: true,
				runId: "reask-learned-line",
				reask: { runId, ids: [purchase] },
			},
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.state.learned_category).toEqual({
			category: "Eating Out",
			from_answers: 2,
		});
		expect(sent[0]?.state).not.toHaveProperty("merchant_category_history");
		expect(await field(purchase, "category_id")).toBe(eatingOut);
		expect(await field(purchase, "details_asked")).toBe(0);
	});
});

describe("the daily cap counts a re-ask like any sort", () => {
	it("reserves and gives back the same calls for the same number of asks", async () => {
		const normal = [await addRow(), await addRow(), await addRow()];
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			fakeJev(() => reply(0.9)).fetchImpl,
			{
				rulesApplied: true,
				onlyIds: normal,
				runId: "cap-normal",
			},
		);
		const afterNormal = await callsUsed();
		const reaskRows = [
			await addRow({ confidence: 0.55 }),
			await addRow({ confidence: 0.55 }),
			await addRow({ confidence: 0.55 }),
		];
		const runId = await startRun(reaskRows);
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			fakeJev(() => reply(0.9)).fetchImpl,
			{
				rulesApplied: true,
				runId: "cap-reask",
				reask: { runId, ids: reaskRows },
			},
		);
		expect(afterNormal).toBe(3);
		expect(await callsUsed()).toBe(6);
	});
});

describe("a cluster's leader is asked once, and its followers take the answer (decision 158)", () => {
	/** `count` waiting rows with the same bank text and amount: one cluster, in this order. */
	const cluster = async (count: number, text = "SAME SHOP") => {
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push(await addRow({ confidence: 0.55, rawName: text }));
		return ids;
	};

	/** Starts the re-sort run over these rows and runs its groups with their clusters. */
	async function reaskClusters(
		ids: number[],
		fetchImpl: (url?: string, init?: RequestInit) => Promise<Response>,
		steps = fakeSteps(),
	) {
		const runId = await startRun(ids);
		const done = await sortGroups(withKey, steps.runStep, fetchImpl, {
			rulesApplied: true,
			runId: `cluster-${runId}`,
			reask: { runId, ids, clusters: await clustersOf(ids) },
		});
		return { runId, steps, done };
	}

	it("a cluster of 4 asks Jev once, for its leader, and each row takes the leader's category", async () => {
		const ids = await cluster(4);
		const eatingOut = await categoryIdByName("Eating Out");
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		const { steps, done } = await reaskClusters(ids, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(steps.names().filter((name) => name.includes("-ask-"))).toEqual([
			`group-1-ask-${ids[0]}`,
		]);
		expect(done.asked).toBe(1);
		expect(await callsUsed()).toBe(1);
		for (const id of ids) {
			expect(await field(id, "category_id")).toBe(eatingOut);
			expect(await field(id, "category_source")).toBe("jev");
			expect(await confOf(id)).toBe(0.9);
		}
	});

	it("the moved record lists every follower the leader's answer filed, so Undo covers them", async () => {
		const ids = await cluster(4);
		const { runId } = await reaskClusters(
			ids,
			vi.fn(async () => replyFor("Eating Out", 0.9)),
		);
		await finishRun(db, { runId, now: Date.now() });
		const record = JSON.parse((await movedRow(runId))?.value ?? "{}") as {
			rows: { id: number }[];
		};
		expect(record.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
			[...ids].sort((a, b) => a - b),
		);
	});

	const unsure: [string, () => Response][] = [
		["a leader below 0.80", () => replyFor("Eating Out", 0.6)],
		[
			"a leader with a mixed trip",
			() =>
				replyFor("Eating Out", 0.9, { probability: 0.9, also: "Groceries" }),
		],
		["a leader that fits none", () => replyFor("None of these fit", 0.9)],
	];
	for (const [label, respond] of unsure) {
		it(`${label}: no follower is applied or asked, and each gets its mark back`, async () => {
			const ids = await cluster(4);
			const fetchImpl = vi.fn(async () => respond());
			const { steps } = await reaskClusters(ids, fetchImpl);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(steps.names().filter((name) => name.includes("-ask-"))).toEqual([
				`group-1-ask-${ids[0]}`,
			]);
			for (const id of ids.slice(1)) {
				expect(await field(id, "category_id")).toBeNull();
				expect(await field(id, "category_source")).toBeNull();
				expect(await confOf(id)).toBe(0.55);
			}
		});
	}

	it("a leader whose ask fails (400) is marked failed, its followers get their marks back, and none is asked", async () => {
		const ids = await cluster(3);
		const jev = fakeJev(() => new Response("{}", { status: 400 }));
		const { runId } = await reaskClusters(ids, jev.fetchImpl);
		expect(jev.calls()).toBe(1);
		expect(await field(ids[0] as number, "jev_failed_at")).not.toBeNull();
		for (const id of ids) expect(await confOf(id)).toBe(0.55);
		for (const id of ids.slice(1))
			expect(await field(id, "jev_failed_at")).toBeNull();
		await finishRun(db, { runId, now: Date.now() });
		for (const id of ids) expect(await confOf(id)).toBe(0.55);
	});

	it("a service-wide failure (503) on the leader restores its followers, and the run finishes", async () => {
		const ids = await cluster(3);
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		const { runId } = await reaskClusters(ids, jev.fetchImpl);
		expect(jev.calls()).toBe(1);
		for (const id of ids) expect(await confOf(id)).toBe(0.55);
		await finishRun(db, { runId, now: Date.now() });
		expect((await readRun(db))?.status).toBe("done");
	});

	it("reserves a call per leader, never per follower: three clusters of 4 use three calls", async () => {
		const ids = [
			...(await cluster(4, "SHOP A")),
			...(await cluster(4, "SHOP B")),
			...(await cluster(4, "SHOP C")),
		];
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		await reaskClusters(ids, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(await callsUsed()).toBe(3);
	});

	it("at the daily cap, three clusters of 4 still get their three leaders asked (followers take no call)", async () => {
		const ids = [
			...(await cluster(4, "SHOP A")),
			...(await cluster(4, "SHOP B")),
			...(await cluster(4, "SHOP C")),
		];
		// 37 of the demo's 40 calls are used, so exactly three leaders fit.
		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, '37')")
			.bind(`jev_calls_${await householdToday(db)}`)
			.run();
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		await reaskClusters(ids, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(await callsUsed()).toBe(40);
		for (const id of ids) expect(await confOf(id)).toBe(0.9);
	});

	it("a follower a person categorised meanwhile is not written; the others take the answer", async () => {
		const ids = await cluster(4);
		const groceries = await categoryIdByName("Groceries");
		const fetchImpl = vi.fn(async () => {
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
				)
				.bind(groceries, ids[1])
				.run();
			return replyFor("Eating Out", 0.9);
		});
		await reaskClusters(ids, fetchImpl);
		expect(await field(ids[1] as number, "category_id")).toBe(groceries);
		expect(await field(ids[1] as number, "category_source")).toBe("user");
		for (const id of [ids[0], ids[2], ids[3]] as number[]) {
			expect(await field(id, "category_source")).toBe("jev");
		}
	});

	it("a follower whose note changed meanwhile is not written and keeps its cleared mark", async () => {
		const ids = await cluster(4);
		const fetchImpl = vi.fn(async () => {
			await db
				.prepare("UPDATE transactions SET note = 'edited' WHERE id = ?")
				.bind(ids[2])
				.run();
			return replyFor("Eating Out", 0.9);
		});
		const { runId } = await reaskClusters(ids, fetchImpl);
		expect(await field(ids[2] as number, "category_id")).toBeNull();
		expect(await confOf(ids[2] as number)).toBeNull();
		expect((await readRun(db))?.keptCleared).toContain(ids[2]);
		expect(await field(ids[1] as number, "category_source")).toBe("jev");
		await finishRun(db, { runId, now: Date.now() });
		expect(await confOf(ids[2] as number)).toBeNull();
	});

	it("a follower whose id was reused by another transaction is not written", async () => {
		const ids = await cluster(4);
		const fetchImpl = vi.fn(async () => {
			await reuseId(ids[3] as number, { plaid: "other-plaid", amount: 999 });
			return replyFor("Eating Out", 0.9);
		});
		await reaskClusters(ids, fetchImpl);
		expect(await field(ids[3] as number, "raw_name")).toBe("REPLACEMENT ROW");
		expect(await field(ids[3] as number, "category_id")).toBeNull();
		expect(await field(ids[3] as number, "category_source")).toBeNull();
		expect(await confOf(ids[3] as number)).toBeNull();
		expect(await field(ids[1] as number, "category_source")).toBe("jev");
	});

	it("30 rows with the same text make two clusters (25 and 5), and two leaders are asked", async () => {
		const ids = await cluster(30);
		expect((await clustersOf(ids)).map((c) => c.length)).toEqual([25, 5]);
		const fake = fakeSteps();
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		const { done } = await reaskClusters(ids, fetchImpl, fake);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fake.names().filter((name) => name.includes("-ask-"))).toEqual([
			`group-1-ask-${ids[0]}`,
			`group-1-ask-${ids[25]}`,
		]);
		expect(done.asked).toBe(2);
		expect(await callsUsed()).toBe(2);
		for (const id of ids) expect(await confOf(id)).toBe(0.9);
	});

	it("progress counts the leader and its followers once each, never past the total", async () => {
		const first = await cluster(4, "SHOP A");
		const second = await cluster(4, "SHOP B");
		const ids = [...first, ...second];
		// 39 of 40 calls are used: one leader fits, so the second cluster is not asked.
		await db
			.prepare("INSERT INTO household_settings (key, value) VALUES (?, '39')")
			.bind(`jev_calls_${await householdToday(db)}`)
			.run();
		const { runId } = await reaskClusters(
			ids,
			vi.fn(async () => replyFor("Eating Out", 0.9)),
		);
		const run = await readRun(db);
		expect(run?.done).toBe(4);
		expect(run?.done).toBeLessThanOrEqual(run?.total ?? 0);
		// The second cluster's leader was never asked, so its followers were restored, not counted.
		for (const id of second) expect(await confOf(id)).toBe(0.55);
		await finishRun(db, { runId, now: Date.now() });
		expect((await readRun(db))?.done).toBeLessThanOrEqual(8);
		for (const id of second) expect(await confOf(id)).toBe(0.55);
	});

	it("finish restores the followers of a leader a cut-off instance left cleared", async () => {
		const ids = await cluster(3);
		const runId = await startRun(ids);
		expect(await takeSortingTurn(db, "cut-off:cluster")).toBe(true);
		const marks = [];
		for (const id of ids) marks.push(await markAt(id, 0.55));
		await db.batch([reaskClearStatement(db, marks, "cut-off:cluster")]);
		await releaseSortingTurn(db, "cut-off:cluster");
		await finishRun(db, { runId, now: Date.now() });
		for (const id of ids) expect(await confOf(id)).toBe(0.55);
	});

	it("a candidate with no same-text partner is its own leader and is asked as before (#820)", async () => {
		const alone = await addRow({ confidence: 0.55, rawName: "ONLY ONCE SHOP" });
		expect(await clustersOf([alone])).toEqual([[alone]]);
		const eatingOut = await categoryIdByName("Eating Out");
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		await reaskClusters([alone], fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(await field(alone, "category_id")).toBe(eatingOut);
		expect(await confOf(alone)).toBe(0.9);
	});

	it("a follower's save writes only the category columns, never a flag, exclusion, income or details", async () => {
		const ids = await cluster(2);
		await saveAiSwitches(db, { details: true });
		const follower = ids[1] as number;
		const touched = [
			"category_id",
			"category_source",
			"category_confidence",
			"jev_category_id",
			"jev_none_fit",
			"jev_mixed",
			"jev_also_category_id",
			"updated_at",
		];
		const before = (await rowState(follower)) ?? {};
		await reaskClusters(
			ids,
			vi.fn(async () => reply(0.9, { transfer: 0.99 })),
		);
		const after = (await rowState(follower)) ?? {};
		for (const key of Object.keys(before)) {
			if (touched.includes(key) || key === "c") continue;
			expect(after[key], key).toEqual(before[key]);
		}
		expect(await field(follower, "category_source")).toBe("jev");
		expect(await field(follower, "category_id")).toBe(
			await categoryIdByName("Eating Out"),
		);
	});
});

describe("a follower takes its leader's answer only when the leader itself was filed (decision 158)", () => {
	const cluster = async (count: number, text = "SAME SHOP") => {
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push(await addRow({ confidence: 0.55, rawName: text }));
		return ids;
	};

	async function reaskClusters(
		ids: number[],
		fetchImpl: (url?: string, init?: RequestInit) => Promise<Response>,
	) {
		const runId = await startRun(ids);
		await sortGroups(withKey, fakeSteps().runStep, fetchImpl, {
			rulesApplied: true,
			runId: `leader-${runId}`,
			reask: { runId, ids, clusters: await clustersOf(ids) },
		});
		return { runId };
	}

	const expectFollowersRestored = async (ids: number[]) => {
		for (const id of ids.slice(1)) {
			expect(await field(id, "category_id")).toBeNull();
			expect(await field(id, "category_source")).toBeNull();
			expect(await confOf(id)).toBe(0.55);
		}
	};

	it("a leader edited mid-ask is not filed, so its followers are restored and not filed; the leader stays cleared", async () => {
		const ids = await cluster(4);
		const fetchImpl = vi.fn(async () => {
			await db
				.prepare("UPDATE transactions SET note = 'edited' WHERE id = ?")
				.bind(ids[0])
				.run();
			return replyFor("Eating Out", 0.9);
		});
		const { runId } = await reaskClusters(ids, fetchImpl);
		expect(await field(ids[0] as number, "category_id")).toBeNull();
		expect(await confOf(ids[0] as number)).toBeNull();
		await expectFollowersRestored(ids);
		expect((await readRun(db))?.keptCleared).toContain(ids[0]);
		await finishRun(db, { runId, now: Date.now() });
		expect(await confOf(ids[0] as number)).toBeNull();
		await expectFollowersRestored(ids);
	});

	it("a leader a person decided mid-ask keeps the person's choice, and its followers are restored", async () => {
		const ids = await cluster(3);
		const groceries = await categoryIdByName("Groceries");
		await reaskClusters(ids, async () => {
			await db
				.prepare(
					"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
				)
				.bind(groceries, ids[0])
				.run();
			return replyFor("Eating Out", 0.9);
		});
		expect(await field(ids[0] as number, "category_source")).toBe("user");
		await expectFollowersRestored(ids);
	});

	it("a leader whose id was reused mid-ask is not filed, and its followers are restored", async () => {
		const ids = await cluster(3);
		await reaskClusters(ids, async () => {
			await reuseId(ids[0] as number, { plaid: "other-plaid", amount: 999 });
			return replyFor("Eating Out", 0.9);
		});
		expect(await field(ids[0] as number, "raw_name")).toBe("REPLACEMENT ROW");
		expect(await field(ids[0] as number, "category_id")).toBeNull();
		await expectFollowersRestored(ids);
	});

	it("a mixed reading that names the same category is not a mixed trip, so the followers are applied", async () => {
		const ids = await cluster(3);
		await reaskClusters(
			ids,
			vi.fn(async () =>
				replyFor("Eating Out", 0.9, { probability: 0.9, also: "Eating Out" }),
			),
		);
		for (const id of ids)
			expect(await field(id, "category_source")).toBe("jev");
	});

	it("a mixed reading below 0.80 is not a mixed trip, so the followers are applied", async () => {
		const ids = await cluster(3);
		await reaskClusters(
			ids,
			vi.fn(async () =>
				replyFor("Eating Out", 0.9, { probability: 0.7, also: "Groceries" }),
			),
		);
		for (const id of ids)
			expect(await field(id, "category_source")).toBe("jev");
	});
});

describe("a cluster's followers are logged, and a decided leader hands its cluster to the next waiting row (decision 158)", () => {
	const cluster = async (count: number, text = "SAME SHOP") => {
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push(await addRow({ confidence: 0.55, rawName: text }));
		return ids;
	};

	it("the What AI did log counts each follower the leader's answer applied, once each, and the leader once", async () => {
		const ids = await cluster(4);
		const runId = await startRun(ids);
		await sortGroups(
			withKey,
			fakeSteps().runStep,
			vi.fn(async () => replyFor("Eating Out", 0.9)),
			{
				rulesApplied: true,
				runId: `log-${runId}`,
				reask: { runId, ids, clusters: await clustersOf(ids) },
			},
		);
		const logged = await db
			.prepare(
				"SELECT COUNT(*) AS n, COUNT(DISTINCT transaction_id) AS distinct_n FROM ai_log WHERE kind = 'category' AND transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(ids))
			.first<{ n: number; distinct_n: number }>();
		expect(logged?.n).toBe(4);
		expect(logged?.distinct_n).toBe(4);
	});

	it("a leader a person decided before the group reads hands the cluster to its next waiting row, asked once", async () => {
		const ids = await cluster(4);
		const groceries = await categoryIdByName("Groceries");
		const runId = await startRun(ids);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-1-read" || attempt !== 1) return;
				await db
					.prepare(
						"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
					)
					.bind(groceries, ids[0])
					.run();
			},
		});
		const fetchImpl = vi.fn(async () => replyFor("Eating Out", 0.9));
		const done = await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			runId: `promote-${runId}`,
			reask: { runId, ids, clusters: await clustersOf(ids) },
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(fake.names().filter((name) => name.includes("-ask-"))).toEqual([
			`group-1-ask-${ids[1]}`,
		]);
		expect(done.asked).toBe(1);
		expect(await field(ids[0] as number, "category_source")).toBe("user");
		for (const id of ids.slice(1)) {
			expect(await field(id, "category_source")).toBe("jev");
			expect(await confOf(id)).toBe(0.9);
		}
		// The person-decided row is not counted by the sort, as before (#820): done is the rows the sort handled.
		expect((await readRun(db))?.done).toBe(3);
	});
});

describe("a follower that no longer belongs to its leader's cluster at read time is not filed (decision 158)", () => {
	const cluster = async (
		count: number,
		text = "SAME SHOP",
		note: string | null = null,
	) => {
		const ids: number[] = [];
		for (let i = 0; i < count; i++)
			ids.push(await addRow({ confidence: 0.55, rawName: text, note }));
		return ids;
	};

	/** Starts the run with its clusters as they are now, then changes the rows before the group reads (once). */
	async function reaskAfterChange(
		ids: number[],
		change: (ids: number[]) => Promise<void>,
		fetchImpl: (url?: string, init?: RequestInit) => Promise<Response>,
	) {
		const clusters = await clustersOf(ids);
		const runId = await startRun(ids);
		const fake = fakeSteps({
			beforeAttempt: async (name, attempt) => {
				if (name !== "group-1-read" || attempt !== 1) return;
				await change(ids);
			},
		});
		await sortGroups(withKey, fake.runStep, fetchImpl, {
			rulesApplied: true,
			runId: `revalidate-${runId}`,
			reask: { runId, ids, clusters },
		});
		return { fake };
	}

	it("a follower renamed to other text before the read is not filed; the leader is asked once and the other followers are filed", async () => {
		const ids = await cluster(4);
		const jev = fakeJev(
			() => replyFor("Eating Out", 0.9),
			() => replyFor("Groceries", 0.6),
		);
		const { fake } = await reaskAfterChange(
			ids,
			async ([, renamed]) => {
				await db
					.prepare(
						"UPDATE transactions SET raw_name = 'OTHER SHOP' WHERE id = ?",
					)
					.bind(renamed)
					.run();
			},
			jev.fetchImpl,
		);
		const [leader, renamed, ...others] = ids as [number, number, ...number[]];
		// The leader is asked once in its group. The renamed row is no longer its follower, so it gets its own ask later.
		expect(fake.names().filter((name) => name.includes("-ask-"))).toEqual([
			`group-1-ask-${leader}`,
			`group-2-ask-${renamed}`,
		]);
		// Its own answer (0.6, a Maybe), not the leader's 0.9.
		expect(await field(renamed, "category_id")).toBeNull();
		expect(await field(renamed, "category_source")).toBeNull();
		expect(await confOf(renamed)).toBe(0.6);
		for (const id of others)
			expect(await field(id, "category_source")).toBe("jev");
	});

	it("a follower whose note changed on a vague text before the read is not filed", async () => {
		const ids = await cluster(4, "apple.com/bill cupertino", "same note");
		expect((await clustersOf(ids)).map((c) => c.length)).toEqual([4]);
		const jev = fakeJev(
			() => replyFor("Eating Out", 0.9),
			() => replyFor("Groceries", 0.6),
		);
		await reaskAfterChange(
			ids,
			async ([, , changed]) => {
				await db
					.prepare(
						"UPDATE transactions SET note = 'a different note' WHERE id = ?",
					)
					.bind(changed)
					.run();
			},
			jev.fetchImpl,
		);
		// Its own answer (0.6), not the leader's: it was asked on its own, after it left the leader's cluster.
		const changed = ids[2] as number;
		expect(await field(changed, "category_source")).toBeNull();
		expect(await confOf(changed)).toBe(0.6);
		for (const id of [ids[1], ids[3]] as number[]) {
			expect(await field(id, "category_source")).toBe("jev");
		}
	});

	it("a follower whose amount now breaks the amount rule is not filed and stays waiting", async () => {
		const ids = await cluster(4);
		await reaskAfterChange(
			ids,
			async ([, , , broken]) => {
				await db
					.prepare("UPDATE transactions SET amount_cents = 99999 WHERE id = ?")
					.bind(broken)
					.run();
			},
			vi.fn(async () => replyFor("Eating Out", 0.9)),
		);
		const broken = ids[3] as number;
		expect(await field(broken, "category_source")).toBeNull();
		// Still waiting: a NULL or a Maybe confidence is asked again later.
		expect([0.55, null]).toContain(await confOf(broken));
		for (const id of ids.slice(1, 3) as number[]) {
			expect(await field(id, "category_source")).toBe("jev");
		}
	});
});
