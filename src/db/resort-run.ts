// The re-sort's run state (decision 160): one run at a time, kept as JSON in household_settings under `resort_run`, and
// the rows it moved, kept under `resort_moved_<runId>` until Undo has had its ten seconds. No new table. Nothing here
// calls Jev or Workers AI.
//
// Concurrency: a run starts or joins by compare-and-set on the exact text it read (a write that finds the text changed
// writes nothing and reads again). Progress is one JSON-editing UPDATE that only moves a running run. Finishing is a
// batch (one D1 transaction) that first flips the run to done with a fresh token, then restores and records only if
// that flip happened, so a second finish changes nothing. Undo is one batch that restores only the moved rows still
// as the run left them, only before the moved record's `until`.

import { BASIS_POINTS } from "../ai/confidence";
import { askedBounds } from "../ai/maybe";
import type { ResortCandidate, ResortSnapshot } from "./resort-candidates";
import { withTurnGuard } from "./sorting-turn";

export const RUN_KEY = "resort_run";
/** A run older than this is closed when the next run starts (decision 160). */
export const STALE_MS = 2 * 60 * 60_000;
/** How long Undo stays open after the closing toast (decision 160, the existing toast's 10 seconds). */
export const UNDO_MS = 10_000;

export const movedKey = (runId: string) => `resort_moved_${runId}`;

export type ResortRun = {
	id: string;
	total: number;
	done: number;
	status: "running" | "done";
	instances: number;
	ids: number[];
	snapshots: ResortSnapshot[];
	categoryId: number;
	categoryName: string;
	startedAt: number;
	toasted: boolean;
	/** Set when the run finishes: the token of the one finish that did it. */
	finishToken?: string;
};

/** The record of the rows a run moved, kept for Undo. */
export type MovedRecord = {
	runId: string;
	categoryId: number;
	categoryName: string;
	/** Undo is open until this time (ms). */
	until: number;
	rows: { id: number; snapshot: ResortSnapshot }[];
	/** The run's rows now in the Maybe range with no category: the ones a person is asked about. */
	needAnswer: number;
};

const parseRun = (value: string): ResortRun => JSON.parse(value) as ResortRun;

/** The run, or null when none has ever been started. */
export async function readRun(db: D1Database): Promise<ResortRun | null> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(RUN_KEY)
		.first<{ value: string }>();
	return row ? parseRun(row.value) : null;
}

/** Writes `next` only if the stored text is still `expected` (null: no row yet). True when it wrote. */
async function writeRunIf(
	db: D1Database,
	expected: string | null,
	next: ResortRun,
): Promise<boolean> {
	const value = JSON.stringify(next);
	const statement =
		expected === null
			? db
					.prepare(
						"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
					)
					.bind(RUN_KEY, value)
			: db
					.prepare(
						"UPDATE household_settings SET value = ? WHERE key = ? AND value = ?",
					)
					.bind(value, RUN_KEY, expected);
	const { meta } = await statement.run();
	return meta.changes > 0;
}

/** The candidates not already in `known`, once each, in the order given. */
function freshCandidates(
	candidates: readonly ResortCandidate[],
	known: ReadonlySet<number>,
): ResortCandidate[] {
	const seen = new Set<number>();
	const out: ResortCandidate[] = [];
	for (const candidate of candidates) {
		if (known.has(candidate.id) || seen.has(candidate.id)) continue;
		seen.add(candidate.id);
		out.push(candidate);
	}
	return out;
}

/**
 * Starts a run for `candidates` into `categoryId`, or joins the fresh running one (its new ids only). A running run older
 * than STALE_MS is finished first. `newIds` are the ids this call added to the run.
 */
export async function startOrJoinRun(
	db: D1Database,
	{
		candidates,
		categoryId,
		categoryName,
		now,
	}: {
		candidates: readonly ResortCandidate[];
		categoryId: number;
		categoryName: string;
		now: number;
	},
): Promise<{ runId: string; newIds: number[]; joined: boolean }> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const row = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(RUN_KEY)
			.first<{ value: string }>();
		const expected = row?.value ?? null;
		const current = row ? parseRun(row.value) : null;

		if (current?.status === "running" && now - current.startedAt <= STALE_MS) {
			const fresh = freshCandidates(candidates, new Set(current.ids));
			const next: ResortRun = {
				...current,
				total: current.total + fresh.length,
				ids: [...current.ids, ...fresh.map((c) => c.id)],
				snapshots: [...current.snapshots, ...fresh.map((c) => c.snapshot)],
				instances: current.instances + 1,
			};
			if (await writeRunIf(db, expected, next)) {
				return {
					runId: current.id,
					newIds: fresh.map((c) => c.id),
					joined: true,
				};
			}
			continue;
		}

		if (current?.status === "running") {
			// Stale: close it, then start over from the stored text the close leaves.
			await finishRun(db, { runId: current.id, now });
			continue;
		}

		const fresh = freshCandidates(candidates, new Set());
		const run: ResortRun = {
			id: crypto.randomUUID(),
			total: fresh.length,
			done: 0,
			status: "running",
			instances: 1,
			ids: fresh.map((c) => c.id),
			snapshots: fresh.map((c) => c.snapshot),
			categoryId,
			categoryName,
			startedAt: now,
			toasted: false,
		};
		if (await writeRunIf(db, expected, run)) {
			return { runId: run.id, newIds: run.ids, joined: false };
		}
	}
	throw new Error("The re-sort could not start. Try again.");
}

/**
 * The statement a sort's save adds to its batch: `done` goes up by `rows`, never past `total`, only while the run is
 * running, and only for the sorting turn when one is given (decision 139).
 */
export function bumpDoneStatement(
	db: D1Database,
	{ runId, rows, turnId }: { runId: string; rows: number; turnId?: string },
): D1PreparedStatement {
	const guarded = withTurnGuard(
		`UPDATE household_settings
			SET value = json_set(value, '$.done', MIN(json_extract(value, '$.total'), json_extract(value, '$.done') + ?))
			WHERE key = ? AND json_extract(value, '$.id') = ? AND json_extract(value, '$.status') = 'running'`,
		turnId,
	);
	return db.prepare(guarded.sql).bind(rows, RUN_KEY, runId, ...guarded.binds);
}

/** The run's snapshots, read from the run row (parameter ?1 is RUN_KEY). */
const SNAPSHOTS = `(SELECT json_extract(value, '$.snapshots') FROM household_settings WHERE key = ?1)`;

/** The Maybe range for a category guess, as basis points on a confidence column (`t`). */
const maybeRangeSql = () => {
	const bounds = askedBounds("category");
	return `CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) > ${bounds.above} AND CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) < ${bounds.below}`;
};

/**
 * Finishes the run once: marks it done, records the rows the sort moved into its category (with their pre-run
 * snapshots) and how many now need an answer, and restores the pre-run mark of each run row the run never reached
 * (still untouched). A second call changes nothing and returns the same counts. Undo stays open for UNDO_MS.
 */
export async function finishRun(
	db: D1Database,
	{ runId, now }: { runId: string; now: number },
): Promise<{ moved: number; needAnswer: number }> {
	const token = crypto.randomUUID();
	const key = movedKey(runId);
	// Parameter ?1 is RUN_KEY, ?2 the finish token: the restore and record only happen for the call that flipped.
	const won = `EXISTS (SELECT 1 FROM household_settings WHERE key = ?1 AND json_extract(value, '$.finishToken') = ?2)`;

	const flip = db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.status', 'done', '$.finishToken', ?)
			WHERE key = ? AND json_extract(value, '$.id') = ? AND json_extract(value, '$.status') = 'running'`,
		)
		.bind(token, RUN_KEY, runId);

	const snap = (column: string) =>
		`(SELECT json_extract(s.value, '$.${column}') FROM json_each(${SNAPSHOTS}) s WHERE json_extract(s.value, '$.id') = transactions.id)`;
	const restore = db
		.prepare(
			`UPDATE transactions SET
				category_id = ${snap("category_id")},
				category_source = ${snap("category_source")},
				category_confidence = ${snap("category_confidence")},
				jev_category_id = ${snap("jev_category_id")},
				jev_none_fit = ${snap("jev_none_fit")},
				jev_mixed = ${snap("jev_mixed")},
				jev_also_category_id = ${snap("jev_also_category_id")},
				jev_failed_at = ${snap("jev_failed_at")},
				updated_at = datetime('now')
			WHERE id IN (SELECT json_extract(s.value, '$.id') FROM json_each(${SNAPSHOTS}) s)
				AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
				AND jev_mixed IS NULL AND jev_also_category_id IS NULL
				AND ${won}`,
		)
		.bind(RUN_KEY, token);

	const runRowIds = `SELECT json_extract(s.value, '$.id') FROM json_each(${SNAPSHOTS}) s`;
	const record = db
		.prepare(
			`INSERT INTO household_settings (key, value)
			SELECT ?3, json_object(
				'runId', json_extract(r.value, '$.id'),
				'categoryId', json_extract(r.value, '$.categoryId'),
				'categoryName', json_extract(r.value, '$.categoryName'),
				'until', ?4,
				'rows', json((SELECT json_group_array(json_object('id', t.id, 'snapshot', json(s.value)))
					FROM json_each(json_extract(r.value, '$.snapshots')) s
					JOIN transactions t ON t.id = json_extract(s.value, '$.id')
					WHERE t.category_id = json_extract(r.value, '$.categoryId') AND t.category_source = 'jev')),
				'needAnswer', (SELECT COUNT(*) FROM transactions t
					WHERE t.id IN (${runRowIds}) AND t.category_id IS NULL AND ${maybeRangeSql()})
			)
			FROM household_settings r WHERE r.key = ?1 AND json_extract(r.value, '$.finishToken') = ?2`,
		)
		.bind(RUN_KEY, token, key, now + UNDO_MS);

	// Whether this call flipped the run or not, the record holds the answer: this call's, or the one that finished it.
	await db.batch([flip, restore, record]);
	return (await readRecord(db, runId)) ?? { moved: 0, needAnswer: 0 };
}

/** The moved record's counts, or null when there is none (never finished, or Undo has removed it). */
async function readRecord(
	db: D1Database,
	runId: string,
): Promise<{ moved: number; needAnswer: number } | null> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(movedKey(runId))
		.first<{ value: string }>();
	if (!row) return null;
	const record = JSON.parse(row.value) as MovedRecord;
	return { moved: record.rows.length, needAnswer: record.needAnswer };
}

/**
 * True for the one call that marks a finished run's closing toast as shown; every later call (and every poll that
 * finds it already shown) gets false. Only a done run has a toast to close.
 */
export async function closeToastOnce(
	db: D1Database,
	runId: string,
): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.toasted', json('true'))
			WHERE key = ? AND json_extract(value, '$.id') = ? AND json_extract(value, '$.status') = 'done'
				AND json_extract(value, '$.toasted') = 0`,
		)
		.bind(RUN_KEY, runId)
		.run();
	return meta.changes > 0;
}

/**
 * Undo: puts back the snapshot of each moved row that still reads as the run left it (its category is the run's and
 * its source is Jev), and only before the record's `until`. A row that changed since is left alone and counted in
 * `changedSince`. `expired` is true when there is no open undo for the run (none, or the ten seconds have passed);
 * then nothing is restored, and an expired record is removed. Counts come from the statements' changes.
 */
export async function undoRun(
	db: D1Database,
	{ runId, now }: { runId: string; now: number },
): Promise<{ restored: number; changedSince: number; expired: boolean }> {
	const key = movedKey(runId);
	const existing = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	if (!existing) return { restored: 0, changedSince: 0, expired: true };
	const moved = (JSON.parse(existing.value) as MovedRecord).rows.length;

	// Parameter ?1 is the record's key, ?2 the time. The record's own `until` is checked in every write.
	const live = `EXISTS (SELECT 1 FROM household_settings WHERE key = ?1 AND json_extract(value, '$.until') >= ?2)`;
	const rows = `(SELECT json_extract(value, '$.rows') FROM household_settings WHERE key = ?1)`;
	const undoSnap = (column: string) =>
		`(SELECT json_extract(s.value, '$.snapshot.${column}') FROM json_each(${rows}) s WHERE json_extract(s.value, '$.id') = transactions.id)`;

	const restore = db
		.prepare(
			`UPDATE transactions SET
				category_id = ${undoSnap("category_id")},
				category_source = ${undoSnap("category_source")},
				category_confidence = ${undoSnap("category_confidence")},
				jev_category_id = ${undoSnap("jev_category_id")},
				jev_none_fit = ${undoSnap("jev_none_fit")},
				jev_mixed = ${undoSnap("jev_mixed")},
				jev_also_category_id = ${undoSnap("jev_also_category_id")},
				jev_failed_at = ${undoSnap("jev_failed_at")},
				updated_at = datetime('now')
			WHERE id IN (SELECT json_extract(s.value, '$.id') FROM json_each(${rows}) s)
				AND category_id = (SELECT json_extract(value, '$.categoryId') FROM household_settings WHERE key = ?1)
				AND category_source = 'jev'
				AND ${live}`,
		)
		.bind(key, now);
	const remove = db
		.prepare(
			"DELETE FROM household_settings WHERE key = ?1 AND json_extract(value, '$.until') >= ?2",
		)
		.bind(key, now);
	const expiredRemove = db
		.prepare(
			"DELETE FROM household_settings WHERE key = ?1 AND json_extract(value, '$.until') < ?2",
		)
		.bind(key, now);

	const [restored, removed] = await db.batch([restore, remove, expiredRemove]);
	if ((removed?.meta.changes ?? 0) === 0) {
		return { restored: 0, changedSince: 0, expired: true };
	}
	const count = restored?.meta.changes ?? 0;
	return { restored: count, changedSince: moved - count, expired: false };
}
