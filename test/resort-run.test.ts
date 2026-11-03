import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ResortCandidate,
	resortCandidates,
} from "../src/db/resort-candidates";
import {
	bumpDoneStatement,
	closeToastOnce,
	finishRun,
	readRun,
	startOrJoinRun,
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
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
		const result = await bumpDoneStatement(db, {
			runId: started.runId,
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
			runId: started.runId,
			rows: 1,
			turnId: "turn-b",
		}).run();
		expect(wrong.meta.changes).toBe(0);
		expect((await readRun(db))?.done).toBe(0);
		const right = await bumpDoneStatement(db, {
			runId: started.runId,
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
			runId: started.runId,
			now: T0 + 5000,
		});
		expect(result).toEqual({ moved: 1, needAnswer: 1 });
		expect((await readRun(db))?.status).toBe("done");
		const record = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(`resort_moved_${started.runId}`)
			.first<{ value: string }>();
		const parsed = JSON.parse(record?.value ?? "{}");
		expect(parsed).toMatchObject({
			runId: started.runId,
			categoryId: groceries,
			categoryName: "Groceries",
			until: T0 + 15000,
			needAnswer: 1,
		});
		expect(parsed.rows.map((r: { id: number }) => r.id)).toEqual([moved]);
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
		const first = await finishRun(db, { runId: started.runId, now: T0 + 5000 });
		const before = await db
			.prepare(
				"SELECT value FROM household_settings WHERE key IN ('resort_run', ?)",
			)
			.bind(`resort_moved_${started.runId}`)
			.all();
		const second = await finishRun(db, {
			runId: started.runId,
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
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
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
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
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
			await finishRun(db, { runId: started.runId, now: T0 + 5000 }),
		).toEqual({ moved: 0, needAnswer: 0 });
	});

	it("never calls Jev or Workers AI", async () => {
		const row = await tx({ plaidCategory: HINT, confidence: 0.3 });
		const started = await startOrJoinRun(db, {
			candidates: (await candidatesNow()).filter((c) => c.id === row),
			categoryId: groceries,
			categoryName: "Groceries",
			now: T0,
		});
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
		expect(fetchSpy).not.toHaveBeenCalled();
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
		expect(await closeToastOnce(db, started.runId)).toBe(false);
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
		expect(await closeToastOnce(db, started.runId)).toBe(true);
		expect(await closeToastOnce(db, started.runId)).toBe(false);
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
		await finishRun(db, { runId: started.runId, now: T0 + 5000 });
		return { a, b, runId: started.runId };
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
