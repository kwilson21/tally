import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RESORT_CANDIDATE_MAX,
	type ResortCandidate,
	resortCandidates,
} from "../src/db/resort-candidates";
import {
	bumpDoneStatement,
	closeToastOnce,
	finishRun,
	readRun,
	STALE_MS,
	startOrJoinRun,
	UNDO_MS,
	undoRun,
} from "../src/db/resort-run";
import { releaseSortingTurn, takeSortingTurn } from "../src/db/sorting-turn";
import { resetDemo } from "../src/demo/reset";

// The re-sort's run state (decision 160): the run and its progress in household_settings (`resort_run`), the rows it
// moved in `resort_moved_<runId>`, the toast that closes it, and Undo for ten seconds after it. Nothing here calls Jev
// or Workers AI. Every write is one statement or one batch, and every write names the run it changes.

const db = env.DB;
const HINT = "Shops";
const T0 = 1_000_000_000_000;
const HOUR = 3_600_000;

/** The run a start made. These tests start runs with candidates, so a null here is a broken test, not a result. */
function runIdOf(started: { runId: string | null }): string {
	if (started.runId === null) throw new Error("the start made no run");
	return started.runId;
}

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

type Fields = {
	raw?: string;
	amount?: number;
	confidence?: number | null;
	jevCategoryId?: number | null;
	plaidCategory?: string | null;
	categoryId?: number | null;
	categorySource?: string | null;
	jevMixed?: number | null;
	jevAlsoCategoryId?: number | null;
};

async function tx(fields: Fields = {}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name,
				category_confidence, jev_category_id, plaid_category, category_id, category_source, jev_mixed, jev_also_category_id)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.amount ?? 1500,
			fields.raw ?? "CHECKCARD 0921 CVS",
			fields.confidence ?? null,
			fields.jevCategoryId ?? null,
			fields.plaidCategory ?? null,
			fields.categoryId ?? null,
			fields.categorySource ?? null,
			fields.jevMixed ?? null,
			fields.jevAlsoCategoryId ?? null,
		)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

const state = (id: number) =>
	db
		.prepare(
			`SELECT category_id AS categoryId, category_source AS categorySource, category_confidence AS confidence,
				jev_category_id AS jevCategoryId, jev_mixed AS jevMixed, jev_also_category_id AS jevAlsoCategoryId,
				jev_failed_at AS jevFailedAt, jev_none_fit AS jevNoneFit
			FROM transactions WHERE id = ?`,
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			categorySource: string | null;
			confidence: number | null;
			jevCategoryId: number | null;
			jevMixed: number | null;
			jevAlsoCategoryId: number | null;
			jevFailedAt: string | null;
			jevNoneFit: number;
		}>();

/** The sort's answer: the row joins the new category, the way a Jev save files it. */
const answer = (id: number, category: number, confidence = 0.95) =>
	db
		.prepare(
			`UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = ?, updated_at = datetime('now') WHERE id = ?`,
		)
		.bind(category, confidence, id)
		.run();

/** The run's clear step (#820): the mark on a row it is about to ask goes, so only its own answer shows. */
const clear = (ids: number[]) =>
	db
		.prepare(
			`UPDATE transactions SET category_confidence = NULL, jev_mixed = NULL, jev_also_category_id = NULL WHERE id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(ids))
		.run();

const settingsKeys = async () =>
	(
		await db
			.prepare(
				"SELECT key FROM household_settings WHERE key LIKE 'resort%' ORDER BY key",
			)
			.all<{ key: string }>()
	).results.map((r) => r.key);

let filed: number;
let groceries: number;
let eatingOut: number;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db
		.prepare(
			`UPDATE transactions SET category_source = 'user',
				category_id = (SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1)
			WHERE category_id IS NULL AND category_source IS NULL`,
		)
		.run();
	await db
		.prepare("DELETE FROM household_settings WHERE key LIKE 'resort%'")
		.run();
	groceries = await categoryId("Groceries");
	eatingOut = await categoryId("Eating Out");
	filed = await tx({
		plaidCategory: HINT,
		jevCategoryId: eatingOut,
		categoryId: eatingOut,
		categorySource: "user",
	});
	fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
	fetchSpy.mockRestore();
});

/** The candidates a run would start from, read the way the re-sort reads them. */
const candidatesNow = (): Promise<ResortCandidate[]> =>
	resortCandidates(db, {
		filedId: filed,
		newCategoryId: groceries,
		cameFromCategoryId: eatingOut,
		queueIds: [],
	});

describe("startOrJoinRun", () => {
	it("starts a run with its progress, ids and snapshots when none is running", async () => {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b = await tx({ plaidCategory: HINT, confidence: null });
		const candidates = (await candidatesNow()).filter((c) =>
			[a, b].includes(c.id),
		);
		const started = await startOrJoinRun(db, {
			candidates,
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		expect(started.joined).toBe(false);
		expect(started.newIds.sort()).toEqual([a, b].sort());
		const run = await readRun(db);
		expect(run).toMatchObject({
			id: started.runId,
			total: 2,
			done: 0,
			status: "running",
			instances: 1,
			categoryId: groceries,
			categoryName: "Groceries",
			startedAt: T0,
			toasted: false,
		});
		expect(run?.ids.sort()).toEqual([a, b].sort());
		expect(run?.snapshots.map((s) => s.id).sort()).toEqual([a, b].sort());
	});

	it("joins a fresh running run: only the new ids are added and returned, and instances goes up", async () => {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const all = await candidatesNow();
		const first = await startOrJoinRun(db, {
			candidates: all.filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const second = await startOrJoinRun(db, {
			candidates: all.filter((c) => c.id === a || c.id === b),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 1000,
		});
		expect(second.joined).toBe(true);
		expect(second.runId).toBe(first.runId);
		expect(second.newIds).toEqual([b]);
		const run = await readRun(db);
		expect(run).toMatchObject({ total: 2, instances: 2, startedAt: T0 });
		expect(run?.ids.sort()).toEqual([a, b].sort());
	});

	it("closes a stale run (older than 2 hours) and starts a new one", async () => {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const all = await candidatesNow();
		const old = await startOrJoinRun(db, {
			candidates: all,
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const later = await startOrJoinRun(db, {
			candidates: all.filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 2 * HOUR + 1,
		});
		expect(later.joined).toBe(false);
		expect(later.runId).not.toBe(old.runId);
		expect((await readRun(db))?.status).toBe("running");
		expect(await settingsKeys()).toEqual(
			[`resort_moved_${old.runId}`, "resort_run"].sort(),
		);
	});

	it("keeps a run that is exactly 2 hours old as fresh", async () => {
		await tx({ plaidCategory: HINT, confidence: 0.3 });
		const all = await candidatesNow();
		const first = await startOrJoinRun(db, {
			candidates: all,
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const second = await startOrJoinRun(db, {
			candidates: [],
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 2 * HOUR,
		});
		expect(second.joined).toBe(true);
		expect(second.runId).toBe(first.runId);
	});
});

describe("startOrJoinRun: categories and empty starts", () => {
	it("starts no run when there are no candidates, so none is left running (decision 160)", async () => {
		const result = await startOrJoinRun(db, {
			candidates: [],
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		expect(result).toEqual({ runId: null, newIds: [], joined: false });
		expect(await readRun(db)).toBeNull();
		expect(await settingsKeys()).toEqual([]);
	});

	it("a joining call with a new category adds it; categoryId stays the first category", async () => {
		const other = await otherCategory();
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b = await tx({ plaidCategory: "Books", confidence: 0.3 });
		const first = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const joined = await startOrJoinRun(db, {
			candidates: (await otherCandidates(other.id)).filter((c) => c.id === b),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		expect(joined).toEqual({ runId: first.runId, newIds: [b], joined: true });
		const run = await readRun(db);
		expect(run).toMatchObject({
			categoryId: groceries,
			categoryName: "Groceries",
			total: 2,
		});
		expect(run?.categories).toEqual([
			{ id: groceries, name: "Groceries" },
			{ id: other.id, name: other.name },
		]);
		// Joining the same category again adds nothing to the list.
		await startOrJoinRun(db, {
			candidates: [],
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 2000,
		});
		expect((await readRun(db))?.categories).toHaveLength(2);
	});

	it("records each joined row with the category it was started for", async () => {
		const other = await otherCategory();
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b = await tx({ plaidCategory: "Books", confidence: 0.3 });
		await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await startOrJoinRun(db, {
			candidates: (await otherCandidates(other.id)).filter((c) => c.id === b),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		expect((await readRun(db))?.categoryByRow).toEqual({
			[a]: groceries,
			[b]: other.id,
		});
	});

	it("a row already in the run keeps the category it was started for, and is not added twice", async () => {
		const other = await otherCategory();
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const again = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		expect(again.newIds).toEqual([]);
		const run = await readRun(db);
		expect(run?.total).toBe(1);
		expect(run?.categoryByRow).toEqual({ [a]: groceries });
	});
});

/** A second active category than Groceries and Eating Out, and the candidates for it from its own filed row. */
async function otherCategory(): Promise<{ id: number; name: string }> {
	const row = await db
		.prepare(
			"SELECT id, name FROM categories WHERE archived = 0 AND id NOT IN (?, ?) ORDER BY id LIMIT 1",
		)
		.bind(groceries, eatingOut)
		.first<{ id: number; name: string }>();
	return row ?? { id: 0, name: "" };
}

/** Candidates for `categoryId`, read from its own filed row (a row with the "Books" hint, filed into that category). */
async function otherCandidates(categoryId: number): Promise<ResortCandidate[]> {
	const booksFiled = await tx({
		plaidCategory: "Books",
		jevCategoryId: categoryId,
		categoryId,
		categorySource: "user",
	});
	return resortCandidates(db, {
		filedId: booksFiled,
		newCategoryId: categoryId,
		cameFromCategoryId: null,
		queueIds: [],
	});
}

describe("bumpDoneStatement", () => {
	it("adds to done and never goes past total", async () => {
		const ids = [
			await tx({ plaidCategory: HINT }),
			await tx({ plaidCategory: HINT }),
		];
		await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => ids.includes(c.id)),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const run = await readRun(db);
		await bumpDoneStatement(db, { runId: run?.id ?? "", rows: 1 }).run();
		expect((await readRun(db))?.done).toBe(1);
		await bumpDoneStatement(db, { runId: run?.id ?? "", rows: 5 }).run();
		expect((await readRun(db))?.done).toBe(2);
	});

	it("is a no-op once the run is done", async () => {
		await tx({ plaidCategory: HINT });
		const started = await startOrJoinRun(db, {
			candidates: await candidatesNow(),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		const result = await bumpDoneStatement(db, {
			runId: runIdOf(started),
			rows: 1,
		}).run();
		expect(result.meta.changes).toBe(0);
	});

	it("only counts for the sorting turn that holds it, when a turn is given", async () => {
		const ids = [
			await tx({ plaidCategory: HINT }),
			await tx({ plaidCategory: HINT }),
		];
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => ids.includes(c.id)),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		expect(await takeSortingTurn(db, "turn-a")).toBe(true);
		const wrong = await bumpDoneStatement(db, {
			runId: runIdOf(started),
			rows: 1,
			turnId: "turn-b",
		}).run();
		expect(wrong.meta.changes).toBe(0);
		expect((await readRun(db))?.done).toBe(0);
		const right = await bumpDoneStatement(db, {
			runId: runIdOf(started),
			rows: 2,
			turnId: "turn-a",
		}).run();
		expect(right.meta.changes).toBe(1);
		expect((await readRun(db))?.done).toBe(2);
		await releaseSortingTurn(db, "turn-a");
	});
});

describe("finishRun", () => {
	it("marks the run done, records exactly the rows the sort moved into its category, and counts the Maybe rows left", async () => {
		const moved = await tx({ plaidCategory: HINT, confidence: 0.58 });
		const stayed = await tx({ plaidCategory: HINT, confidence: 0.58 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) =>
				[moved, stayed].includes(c.id),
			),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([moved, stayed]);
		await answer(moved, groceries);
		// `stayed` is not reached: it is still untouched, so it is restored to its pre-run mark (0.58, a Maybe).
		const result = await finishRun(db, {
			runId: runIdOf(started),
			now: T0 + 5000,
		});
		expect(result).toEqual({
			moved: 1,
			needAnswer: 1,
			categories: ["Groceries"],
			finished: true,
			pending: 0,
		});
		expect((await readRun(db))?.status).toBe("done");
		const record = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`resort_moved_${started.runId}`)
			.first<{ value: string }>();
		const parsed = JSON.parse(record?.value ?? "{}");
		expect(parsed).toMatchObject({
			runId: runIdOf(started),
			categoryId: groceries,
			categoryName: "Groceries",
			until: null,
			claimedAt: null,
			finalizedAt: T0 + 5000,
			needAnswer: 1,
		});
		expect(parsed.rows.map((r: { id: number }) => r.id)).toEqual([moved]);
		expect(parsed.rows[0].categoryId).toBe(groceries);
		expect(parsed.categories).toEqual(["Groceries"]);
		expect(parsed.rows[0].snapshot).toMatchObject({
			id: moved,
			category_confidence: 0.58,
		});
		expect(await state(stayed)).toMatchObject({
			categoryId: null,
			categorySource: null,
			confidence: 0.58,
		});
	});

	it("is idempotent: a second call changes nothing and returns the same counts", async () => {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([a]);
		await answer(a, groceries);
		const first = await finishRun(db, {
			runId: runIdOf(started),
			now: T0 + 5000,
		});
		const before = await db
			.prepare(
				"SELECT value FROM household_settings WHERE key IN ('resort_run', ?)",
			)
			.bind(`resort_moved_${started.runId}`)
			.all();
		const second = await finishRun(db, {
			runId: runIdOf(started),
			now: T0 + 9000,
		});
		const after = await db
			.prepare(
				"SELECT value FROM household_settings WHERE key IN ('resort_run', ?)",
			)
			.bind(`resort_moved_${started.runId}`)
			.all();
		expect(second).toEqual(first);
		expect(after.results).toEqual(before.results);
	});

	it("does not restore a row a person or a later sort has already changed", async () => {
		const sorted = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === sorted),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		// The row was asked again and got a confidence back: it is not untouched, so the run leaves it alone.
		await db
			.prepare("UPDATE transactions SET category_confidence = 0.5 WHERE id = ?")
			.bind(sorted)
			.run();
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		expect((await state(sorted))?.confidence).toBe(0.5);
	});

	it("restores the pre-run mark of an untouched row, including its Jev fields", async () => {
		const row = await tx({
			plaidCategory: HINT,
			confidence: 0.58,
			jevCategoryId: eatingOut,
			jevMixed: 0.2,
			jevAlsoCategoryId: groceries,
		});
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([row]);
		const cleared = await state(row);
		expect(cleared?.confidence).toBeNull();
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		expect(await state(row)).toMatchObject({
			categoryId: null,
			categorySource: null,
			confidence: 0.58,
			jevCategoryId: eatingOut,
			jevMixed: 0.2,
			jevAlsoCategoryId: groceries,
		});
	});

	it("never moves a row the person filed by hand, even one that was a candidate", async () => {
		const row = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(groceries, row)
			.run();
		expect(
			await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 }),
		).toEqual({
			moved: 0,
			needAnswer: 0,
			categories: [],
			finished: true,
			pending: 0,
		});
	});

	it("never calls Jev or Workers AI", async () => {
		const row = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("two categories in one run", () => {
	/**
	 * Run 1 starts for Groceries with g1 and g2; run 2 joins it for the other category with b1. A stray row is filed
	 * into Groceries by a normal sort and is not in the run.
	 */
	async function twoCategoryRun() {
		const other = await otherCategory();
		const g1 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const g2 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b1 = await tx({ plaidCategory: "Books", confidence: 0.3 });
		const stray = await tx({
			plaidCategory: HINT,
			categoryId: groceries,
			categorySource: "jev",
			confidence: 0.9,
		});
		const first = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) =>
				[g1, g2].includes(c.id),
			),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await startOrJoinRun(db, {
			candidates: (await otherCandidates(other.id)).filter((c) => c.id === b1),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		await clear([g1, g2, b1]);
		await answer(g1, groceries);
		await answer(b1, other.id);
		return { g1, g2, b1, stray, other, runId: runIdOf(first) };
	}

	it("records each moved row under its own category, leaves out the stray row, and says which categories moved", async () => {
		const { g1, b1, stray, other, runId } = await twoCategoryRun();
		const result = await finishRun(db, { runId, now: T0 + 5000 });
		expect(result).toEqual({
			moved: 2,
			needAnswer: 0,
			categories: ["Groceries", other.name],
			finished: true,
			pending: 0,
		});
		const record = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`resort_moved_${runId}`)
			.first<{ value: string }>();
		const parsed = JSON.parse(record?.value ?? "{}") as {
			rows: { id: number; categoryId: number }[];
		};
		expect(
			Object.fromEntries(parsed.rows.map((r) => [r.id, r.categoryId])),
		).toEqual({ [g1]: groceries, [b1]: other.id });
		expect(parsed.rows.map((r) => r.id)).not.toContain(stray);
		expect(await state(stray)).toMatchObject({
			categoryId: groceries,
			categorySource: "jev",
		});
	});

	it("undoes both groups when nothing changed since", async () => {
		const { g1, b1, g2, runId } = await twoCategoryRun();
		await finishRun(db, { runId, now: T0 + 5000 });
		await closeToastOnce(db, runId, T0 + 5000);
		expect(await undoRun(db, { runId, now: T0 + 6000 })).toEqual({
			restored: 2,
			changedSince: 0,
			expired: false,
		});
		expect(await state(g1)).toMatchObject({
			categoryId: null,
			confidence: 0.3,
		});
		expect(await state(b1)).toMatchObject({
			categoryId: null,
			confidence: 0.3,
		});
		expect(await state(g2)).toMatchObject({
			categoryId: null,
			confidence: 0.3,
		});
	});

	it("undoes each group only while its row still reads as the run left it", async () => {
		const { g1, b1, stray, runId } = await twoCategoryRun();
		await finishRun(db, { runId, now: T0 + 5000 });
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(groceries, b1)
			.run();
		await closeToastOnce(db, runId, T0 + 5000);
		expect(await undoRun(db, { runId, now: T0 + 6000 })).toEqual({
			restored: 1,
			changedSince: 1,
			expired: false,
		});
		expect(await state(g1)).toMatchObject({
			categoryId: null,
			confidence: 0.3,
		});
		expect(await state(b1)).toMatchObject({
			categoryId: groceries,
			categorySource: "user",
		});
		expect(await state(stray)).toMatchObject({
			categoryId: groceries,
			categorySource: "jev",
		});
	});

	it("names in the toast only the categories that got a moved row", async () => {
		const other = await otherCategory();
		const g1 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b1 = await tx({ plaidCategory: "Books", confidence: 0.3 });
		const first = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === g1),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await startOrJoinRun(db, {
			candidates: (await otherCandidates(other.id)).filter((c) => c.id === b1),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		await clear([g1, b1]);
		await answer(g1, groceries);
		// b1 is not reached: the other category holds no moved row, so the toast does not name it.
		expect(
			await finishRun(db, { runId: runIdOf(first), now: T0 + 5000 }),
		).toEqual({
			moved: 1,
			needAnswer: 0,
			categories: ["Groceries"],
			finished: true,
			pending: 0,
		});
	});

	it("does not record a joined row that the run filed into another category", async () => {
		// b1 was started for the other category; the run files it into Groceries instead. That is not its own
		// category, so it is not recorded (only g1, which went into its own category, is).
		const { b1, runId } = await twoCategoryRun();
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev' WHERE id = ?",
			)
			.bind(groceries, b1)
			.run();
		const result = await finishRun(db, { runId, now: T0 + 5000 });
		expect(result.moved).toBe(1);
	});
});

describe("finishRun: a row a person answered during the run", () => {
	it("leaves it alone (its category is set, so it is not untouched)", async () => {
		const row = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL WHERE id = ?",
			)
			.bind(eatingOut, row)
			.run();
		expect(
			await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 }),
		).toEqual({
			moved: 0,
			needAnswer: 0,
			categories: [],
			finished: true,
			pending: 0,
		});
		expect(await state(row)).toMatchObject({
			categoryId: eatingOut,
			categorySource: "user",
		});
	});
});

describe("finishRun: one finish per sorting instance", () => {
	/** Instance A starts the run for Groceries with g1; instance B joins for the other category (instances = 2). */
	async function joinedRun() {
		const other = await otherCategory();
		const g1 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b1 = await tx({ plaidCategory: "Books", confidence: 0.3 });
		const first = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === g1),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await startOrJoinRun(db, {
			candidates: (await otherCandidates(other.id)).filter((c) => c.id === b1),
			categoryId: other.id,
			categoryName: other.name,
			now: T0 + 1000,
		});
		await clear([g1, b1]);
		await answer(g1, groceries);
		return { g1, b1, other, runId: runIdOf(first) };
	}

	const movedRecord = async (runId: string) =>
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`resort_moved_${runId}`)
				.first<{ value: string }>()
		)?.value ?? null;

	it("the first instance's finish does not finalize the run or write the moved record", async () => {
		const { runId } = await joinedRun();
		expect(
			await finishRun(db, { runId, now: T0 + 5000, instanceKey: "A" }),
		).toEqual({
			moved: 0,
			needAnswer: 0,
			categories: [],
			finished: false,
			pending: 1,
		});
		expect((await readRun(db))?.status).toBe("running");
		expect(await movedRecord(runId)).toBeNull();
	});

	it("rows the second instance files are included when it finishes last", async () => {
		const { g1, b1, other, runId } = await joinedRun();
		await finishRun(db, { runId, now: T0 + 5000, instanceKey: "A" });
		// Instance B files its row after A has finished.
		await clear([b1]);
		await answer(b1, other.id);
		expect(
			await finishRun(db, { runId, now: T0 + 6000, instanceKey: "B" }),
		).toEqual({
			moved: 2,
			needAnswer: 0,
			categories: ["Groceries", other.name],
			finished: true,
			pending: 0,
		});
		const parsed = JSON.parse((await movedRecord(runId)) ?? "{}") as {
			rows: { id: number }[];
		};
		expect(parsed.rows.map((r) => r.id).sort((x, y) => x - y)).toEqual(
			[g1, b1].sort((x, y) => x - y),
		);
		expect((await readRun(db))?.status).toBe("done");
	});

	it("a repeated call with the same key counts once", async () => {
		const { runId } = await joinedRun();
		const once = await finishRun(db, {
			runId,
			now: T0 + 5000,
			instanceKey: "A",
		});
		const twice = await finishRun(db, {
			runId,
			now: T0 + 5001,
			instanceKey: "A",
		});
		expect(once.pending).toBe(1);
		expect(twice).toEqual(once);
		expect((await readRun(db))?.status).toBe("running");
	});

	it("omitting the key finalizes at once, as before", async () => {
		const { g1, runId } = await joinedRun();
		expect(await finishRun(db, { runId, now: T0 + 5000 })).toEqual({
			moved: 1,
			needAnswer: 0,
			categories: ["Groceries"],
			finished: true,
			pending: 0,
		});
		expect((await readRun(db))?.status).toBe("done");
		const parsed = JSON.parse((await movedRecord(runId)) ?? "{}") as {
			rows: { id: number }[];
		};
		expect(parsed.rows.map((r) => r.id)).toEqual([g1]);
	});

	it("a run with one instance finalizes on its single keyed finish", async () => {
		const g1 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === g1),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([g1]);
		await answer(g1, groceries);
		expect(
			await finishRun(db, {
				runId: runIdOf(started),
				now: T0 + 5000,
				instanceKey: "A",
			}),
		).toEqual({
			moved: 1,
			needAnswer: 0,
			categories: ["Groceries"],
			finished: true,
			pending: 0,
		});
		expect((await readRun(db))?.status).toBe("done");
	});

	it("a keyed call after the run is done changes nothing", async () => {
		const { runId } = await joinedRun();
		await finishRun(db, { runId, now: T0 + 5000 });
		const before = await readRun(db);
		const movedBefore = await movedRecord(runId);
		expect(
			await finishRun(db, { runId, now: T0 + 6000, instanceKey: "B" }),
		).toMatchObject({ finished: true, pending: 0 });
		expect(await readRun(db)).toEqual(before);
		expect(await movedRecord(runId)).toEqual(movedBefore);
	});

	it("a stale run finalizes, with the rows of the instances that finished, when another run starts", async () => {
		const { g1, runId } = await joinedRun();
		await finishRun(db, { runId, now: T0 + 5000, instanceKey: "A" });
		const late = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const next = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === late),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 2 * HOUR + 1,
		});
		expect(next.joined).toBe(false);
		expect(await settingsKeys()).toEqual(
			[`resort_moved_${runId}`, "resort_run"].sort(),
		);
		const parsed = JSON.parse((await movedRecord(runId)) ?? "{}") as {
			rows: { id: number }[];
		};
		expect(parsed.rows.map((r) => r.id)).toEqual([g1]);
	});
});

describe("closeToastOnce", () => {
	it("flips once: only the first call for a finished run says so", async () => {
		const row = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		expect(await closeToastOnce(db, runIdOf(started), T0)).toBe(false);
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		expect(await closeToastOnce(db, runIdOf(started), T0 + 6000)).toBe(true);
		expect(await closeToastOnce(db, runIdOf(started), T0 + 6001)).toBe(false);
		expect((await readRun(db))?.toasted).toBe(true);
	});
});

describe("undoRun", () => {
	async function finishedRunWithTwoMoved() {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const b = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => [a, b].includes(c.id)),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([a, b]);
		await answer(a, groceries);
		await answer(b, groceries);
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		await closeToastOnce(db, runIdOf(started), T0 + 5000);
		return { a, b, runId: runIdOf(started) };
	}

	it("restores every moved row to its snapshot, deletes the record, and reports the count", async () => {
		const { a, b, runId } = await finishedRunWithTwoMoved();
		const result = await undoRun(db, { runId, now: T0 + 6000 });
		expect(result).toEqual({ restored: 2, changedSince: 0, expired: false });
		expect(await state(a)).toMatchObject({
			categoryId: null,
			categorySource: null,
			confidence: 0.3,
		});
		expect(await state(b)).toMatchObject({
			categoryId: null,
			categorySource: null,
			confidence: 0.3,
		});
		expect(await settingsKeys()).toEqual(["resort_run"]);
	});

	it("restores only the rows still as the run left them and counts a re-categorised row as changed since", async () => {
		const { a, b, runId } = await finishedRunWithTwoMoved();
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(eatingOut, b)
			.run();
		const result = await undoRun(db, { runId, now: T0 + 6000 });
		expect(result).toEqual({ restored: 1, changedSince: 1, expired: false });
		expect(await state(a)).toMatchObject({ categoryId: null, confidence: 0.3 });
		expect(await state(b)).toMatchObject({
			categoryId: eatingOut,
			categorySource: "user",
		});
	});

	it("restores nothing after the ten seconds, and removes the expired record", async () => {
		const { a, runId } = await finishedRunWithTwoMoved();
		const result = await undoRun(db, { runId, now: T0 + 5000 + 10_001 });
		expect(result).toEqual({ restored: 0, changedSince: 0, expired: true });
		expect(await state(a)).toMatchObject({
			categoryId: groceries,
			categorySource: "jev",
		});
		expect(await settingsKeys()).toEqual(["resort_run"]);
	});

	it("still undoes at exactly the ten-second mark", async () => {
		const { a, runId } = await finishedRunWithTwoMoved();
		const result = await undoRun(db, { runId, now: T0 + 5000 + 10_000 });
		expect(result).toEqual({ restored: 2, changedSince: 0, expired: false });
		expect(await state(a)).toMatchObject({ categoryId: null });
	});

	it("a second undo after a successful one reports expired and changes nothing", async () => {
		const { a, runId } = await finishedRunWithTwoMoved();
		expect(await undoRun(db, { runId, now: T0 + 6000 })).toEqual({
			restored: 2,
			changedSince: 0,
			expired: false,
		});
		// The person files a again; a second Undo must not touch it.
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(eatingOut, a)
			.run();
		const before = await state(a);
		expect(await undoRun(db, { runId, now: T0 + 6001 })).toEqual({
			restored: 0,
			changedSince: 0,
			expired: true,
		});
		expect(await state(a)).toEqual(before);
		expect(await settingsKeys()).toEqual(["resort_run"]);
	});

	it("reports an unknown run as expired and restores nothing", async () => {
		await finishedRunWithTwoMoved();
		expect(await undoRun(db, { runId: "no-such-run", now: T0 + 6000 })).toEqual(
			{ restored: 0, changedSince: 0, expired: true },
		);
	});

	it("never calls Jev or Workers AI", async () => {
		const { runId } = await finishedRunWithTwoMoved();
		await undoRun(db, { runId, now: T0 + 6000 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("the closing toast, the Undo deadline, the sweep, identity and the cap", () => {
	/** A finished run with one row moved into Groceries, not yet claimed. Returns the row and the run id. */
	async function finishedUnclaimed(finishAt = T0 + 5000) {
		const a = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === a),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([a]);
		await answer(a, groceries);
		await finishRun(db, { runId: runIdOf(started), now: finishAt });
		return { a, runId: runIdOf(started) };
	}

	/** A fresh candidate row that starts the next run. */
	async function nextRunStart(now: number) {
		const c = await tx({ plaidCategory: HINT, confidence: 0.3 });
		return startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((x) => x.id === c),
			categoryId: groceries,
			categoryName: "Groceries",
			now,
		});
	}

	const recordText = async (runId: string) =>
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`resort_moved_${runId}`)
				.first<{ value: string }>()
		)?.value ?? null;

	it("an expired, claimed record is gone after the next start, without Undo", async () => {
		const { runId } = await finishedUnclaimed();
		expect(await closeToastOnce(db, runId, T0 + 5000)).toBe(true);
		// Ten seconds after the claim nobody undid it; the next run's start removes the record.
		await nextRunStart(T0 + 5000 + UNDO_MS + 1);
		expect(await settingsKeys()).toEqual(["resort_run"]);
	});

	it("an unclaimed record is removed by the first start after STALE_MS past its finish", async () => {
		const { runId } = await finishedUnclaimed();
		await nextRunStart(T0 + 5000 + STALE_MS + 1);
		expect(await settingsKeys()).toEqual(["resort_run"]);
		expect(await recordText(runId)).toBeNull();
	});

	it("an unclaimed record is still claimable at exactly STALE_MS after it finished", async () => {
		const { runId } = await finishedUnclaimed();
		await nextRunStart(T0 + 5000 + STALE_MS);
		expect(await recordText(runId)).not.toBeNull();
		expect(await closeToastOnce(db, runId, T0 + 5000 + STALE_MS)).toBe(true);
	});

	it("a new run does not drop a completed run's unseen toast: its closing still delivers Undo", async () => {
		const { a, runId } = await finishedUnclaimed();
		const next = await nextRunStart(T0 + 6000);
		expect(next.joined).toBe(false);
		expect(await closeToastOnce(db, runId, T0 + 7000)).toBe(true);
		expect(await undoRun(db, { runId, now: T0 + 7000 })).toEqual({
			restored: 1,
			changedSince: 0,
			expired: false,
		});
		expect(await state(a)).toMatchObject({ categoryId: null, confidence: 0.3 });
	});

	it("the Undo deadline starts when the toast is claimed, not when the run finishes", async () => {
		const { a, runId } = await finishedUnclaimed(T0 + 5000);
		expect(JSON.parse((await recordText(runId)) ?? "{}")).toMatchObject({
			until: null,
			claimedAt: null,
		});
		// Undo before the claim: nothing is open.
		expect(await undoRun(db, { runId, now: T0 + 6000 })).toEqual({
			restored: 0,
			changedSince: 0,
			expired: true,
		});
		expect(await state(a)).toMatchObject({ categoryId: groceries });
		// The toast is claimed well after the finish: Undo is open from the claim.
		expect(await closeToastOnce(db, runId, T0 + 20_000)).toBe(true);
		expect(JSON.parse((await recordText(runId)) ?? "{}")).toMatchObject({
			claimedAt: T0 + 20_000,
			until: T0 + 20_000 + UNDO_MS,
		});
		expect(await undoRun(db, { runId, now: T0 + 20_000 + UNDO_MS })).toEqual({
			restored: 1,
			changedSince: 0,
			expired: false,
		});
	});

	it("an Undo after the claim's ten seconds restores nothing", async () => {
		const { a, runId } = await finishedUnclaimed(T0 + 5000);
		await closeToastOnce(db, runId, T0 + 20_000);
		expect(
			await undoRun(db, { runId, now: T0 + 20_000 + UNDO_MS + 1 }),
		).toEqual({ restored: 0, changedSince: 0, expired: true });
		expect(await state(a)).toMatchObject({ categoryId: groceries });
	});

	it("a candidate deleted and its id reused by another row is not restored", async () => {
		const x = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === x),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([x]);
		await db.prepare("DELETE FROM transactions WHERE id = ?").bind(x).run();
		// Another purchase takes the same id: untouched, but a different transaction.
		await db
			.prepare(
				`INSERT INTO transactions (id, plaid_transaction_id, account_id, date, amount_cents, raw_name)
				VALUES (?, 'plaid-reused-candidate', (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', 2500, 'OTHER SHOP')`,
			)
			.bind(x)
			.run();
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		expect(await state(x)).toMatchObject({
			categoryId: null,
			confidence: null,
		});
	});

	it("a moved row deleted and its id reused by another row is not undone", async () => {
		const m = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === m),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await clear([m]);
		await answer(m, groceries);
		await finishRun(db, { runId: runIdOf(started), now: T0 + 5000 });
		await closeToastOnce(db, runIdOf(started), T0 + 5000);
		await db.prepare("DELETE FROM transactions WHERE id = ?").bind(m).run();
		await db
			.prepare(
				`INSERT INTO transactions (id, plaid_transaction_id, account_id, date, amount_cents, raw_name,
					category_id, category_source, category_confidence)
				VALUES (?, 'plaid-reused-moved', (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-03', 900, 'OTHER SHOP', ?, 'jev', 0.9)`,
			)
			.bind(m, groceries)
			.run();
		expect(
			await undoRun(db, { runId: runIdOf(started), now: T0 + 6000 }),
		).toEqual({ restored: 0, changedSince: 1, expired: false });
		expect(await state(m)).toMatchObject({
			categoryId: groceries,
			categorySource: "jev",
			confidence: 0.9,
		});
	});

	/** A db whose next batch is preceded by `before` (the joiner that arrives between the key and the flip). */
	function beforeNextBatch(before: () => Promise<unknown>): D1Database {
		let fired = false;
		return new Proxy(db, {
			get(target, prop) {
				if (prop === "batch") {
					return async (statements: D1PreparedStatement[]) => {
						if (!fired) {
							fired = true;
							await before();
						}
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as D1Database;
	}

	it("a joiner arriving between the instance's key and the flip keeps the run open", async () => {
		const g1 = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === g1),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const runId = runIdOf(started);
		await clear([g1]);
		await answer(g1, groceries);
		const racing = beforeNextBatch(async () => {
			// A joiner starts between A's key write and A's flip: instances goes to 2.
			await startOrJoinRun(db, {
				candidates: [],
				categoryId: groceries,
				categoryName: "Groceries",
				now: T0 + 3000,
			});
		});
		expect(
			await finishRun(racing, { runId, now: T0 + 4000, instanceKey: "A" }),
		).toEqual({
			moved: 0,
			needAnswer: 0,
			categories: [],
			finished: false,
			pending: 1,
		});
		expect((await readRun(db))?.status).toBe("running");
		expect(await recordText(runId)).toBeNull();
		// Instance B finishes last; the run finalizes with A's row.
		expect(
			await finishRun(db, { runId, now: T0 + 5000, instanceKey: "B" }),
		).toMatchObject({ moved: 1, finished: true, pending: 0 });
		expect((await readRun(db))?.status).toBe("done");
	});

	it("a joined run never holds more than RESORT_CANDIDATE_MAX rows", async () => {
		const range = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) => synthCandidate(from + i));
		const first = await startOrJoinRun(db, {
			candidates: range(900_000, 900_089),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		const joined = await startOrJoinRun(db, {
			candidates: range(900_090, 900_119),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 1000,
		});
		expect(joined.joined).toBe(true);
		expect(joined.newIds).toHaveLength(RESORT_CANDIDATE_MAX - 90);
		expect((await readRun(db))?.total).toBe(RESORT_CANDIDATE_MAX);
		const full = await startOrJoinRun(db, {
			candidates: range(900_120, 900_124),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0 + 2000,
		});
		expect(full).toMatchObject({
			runId: first.runId,
			newIds: [],
			joined: true,
		});
		expect((await readRun(db))?.total).toBe(RESORT_CANDIDATE_MAX);
	});

	it("a new run holds at most RESORT_CANDIDATE_MAX rows", async () => {
		const started = await startOrJoinRun(db, {
			candidates: Array.from({ length: RESORT_CANDIDATE_MAX + 50 }, (_, i) =>
				synthCandidate(900_000 + i),
			),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		expect(started.newIds).toHaveLength(RESORT_CANDIDATE_MAX);
		expect((await readRun(db))?.total).toBe(RESORT_CANDIDATE_MAX);
	});
});

/** A candidate for an id no row has, with the snapshot a real one carries. */
function synthCandidate(id: number): ResortCandidate {
	return {
		id,
		date: "2026-10-02",
		amountCents: 1500,
		rawName: `ROW ${id}`,
		merchantKey: `row${id}`,
		mixed: false,
		whatItWasNote: null,
		snapshot: {
			id,
			category_id: null,
			category_source: null,
			category_confidence: null,
			jev_category_id: null,
			jev_none_fit: 0,
			jev_mixed: null,
			jev_also_category_id: null,
			jev_failed_at: null,
		},
	};
}
