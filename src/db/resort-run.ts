// The re-sort's run state (decision 160): one run at a time, kept as JSON in household_settings under `resort_run`, and
// the rows it moved, kept under `resort_moved_<runId>` until Undo has had its ten seconds. No new table. Nothing here
// calls Jev or Workers AI.
//
// Concurrency: a run starts or joins by compare-and-set on the exact text it read (a write that finds the text changed
// writes nothing and reads again). Progress is one JSON-editing UPDATE that only moves a running run. Finishing is a
// batch (one D1 transaction) that first flips the run to done with a fresh token, then restores and records only if
// that flip happened, so a second finish changes nothing. Undo is one batch that restores only the moved rows still
// as the run left them, only before the moved record's `until`.

import { JEV_THRESHOLD } from "../ai/categorize";
import { BASIS_POINTS, confidenceBasisPoints } from "../ai/confidence";
import { askedBounds } from "../ai/maybe";
import { COUNTED_JOINS } from "./counted-month";
import { WAITING } from "./more-like-this";
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
	/** The first category the run started for (callers that want one category read this). */
	categoryId: number;
	categoryName: string;
	/** Every category the run holds, the first one first, each once. A joining call with a new one adds it. */
	categories: { id: number; name: string }[];
	/** The category each run row was started for, by row id. A row already in the run keeps its first category. */
	categoryByRow: Record<string, number>;
	/** The instance keys that have finished (each counted once). The run finalizes when there are `instances` of them. */
	finishedKeys: string[];
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
	/** The names of the run's categories, for the toast. */
	categories: string[];
	/** Undo is open until this time (ms). */
	until: number;
	/** Each row the run moved: the category it was started for (which it now holds), and its pre-run snapshot. */
	rows: { id: number; categoryId: number; snapshot: ResortSnapshot }[];
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

/** `list` with `category` added, unless its id is already there. */
const withCategory = (
	list: readonly { id: number; name: string }[],
	category: { id: number; name: string },
) => (list.some((c) => c.id === category.id) ? [...list] : [...list, category]);

/** The category each of `rows` was started for, keyed by row id. */
const byRow = (rows: readonly ResortCandidate[], categoryId: number) =>
	Object.fromEntries(rows.map((c) => [String(c.id), categoryId]));

/**
 * Starts a run for `candidates` into `categoryId`, or joins the fresh running one (its new ids only). A running run older
 * than STALE_MS is finished first. `newIds` are the ids this call added to the run; a row already in the run keeps the
 * category it was started for. With no candidates and no fresh running run, nothing is started or written: the result
 * is `{runId: null, newIds: [], joined: false}`, so an empty re-sort never leaves a run running.
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
): Promise<{ runId: string | null; newIds: number[]; joined: boolean }> {
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
				categoryByRow: {
					...current.categoryByRow,
					...byRow(fresh, categoryId),
				},
				categories: withCategory(current.categories, {
					id: categoryId,
					name: categoryName,
				}),
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
		if (fresh.length === 0) return { runId: null, newIds: [], joined: false };
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
			categories: [{ id: categoryId, name: categoryName }],
			categoryByRow: byRow(fresh, categoryId),
			finishedKeys: [],
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

/** A row's Maybe mark as it stood before a re-ask cleared it, so the mark can be put back exactly. */
export type ReaskMark = {
	id: number;
	confidence: number | null;
	mixed: number | null;
	also: number | null;
};

/**
 * The first of `ids` (in that order, skipping `except`, at most `limit`) that still wait for a category: a WAITING row
 * with no category and a confidence NULL or under the threshold (never one at or above it, never a decided row). Each
 * comes with its mark as it is now. One read.
 */
export async function reaskPicks(
	db: D1Database,
	{
		ids,
		except,
		limit,
	}: { ids: readonly number[]; except: ReadonlySet<number>; limit: number },
): Promise<ReaskMark[]> {
	const wanted = [...new Set(ids)].filter((id) => !except.has(id));
	if (wanted.length === 0 || limit <= 0) return [];
	const { results } = await db
		.prepare(
			`SELECT t.id, t.category_confidence AS confidence, t.jev_mixed AS mixed, t.jev_also_category_id AS also
			FROM transactions t ${COUNTED_JOINS}
			WHERE (${WAITING}) AND t.category_id IS NULL
				AND (t.category_confidence IS NULL
					OR CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) < ${confidenceBasisPoints(JEV_THRESHOLD)})
				AND t.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(JSON.stringify(wanted))
		.all<{
			id: number;
			confidence: number | null;
			mixed: number | null;
			also: number | null;
		}>();
	const byId = new Map(results.map((row) => [row.id, row]));
	const picks: ReaskMark[] = [];
	for (const id of wanted) {
		const row = byId.get(id);
		if (!row) continue;
		picks.push({
			id,
			confidence: row.confidence,
			mixed: row.mixed,
			also: row.also,
		});
		if (picks.length === limit) break;
	}
	return picks;
}

/**
 * Clears the Maybe mark (confidence, mixed reading, also-category) of these rows, so Jev is asked about them again. Only
 * a row still waiting is touched, and only while the sorting turn is held (decision 160).
 */
export function reaskClearStatement(
	db: D1Database,
	ids: readonly number[],
	turnId: string,
): D1PreparedStatement {
	const guarded = withTurnGuard(
		`UPDATE transactions SET category_confidence = NULL, jev_mixed = NULL, jev_also_category_id = NULL
		WHERE id IN (SELECT value FROM json_each(?)) AND category_id IS NULL AND category_source IS NULL
			AND (category_confidence IS NULL
				OR CAST(category_confidence * ${BASIS_POINTS} AS INTEGER) < ${confidenceBasisPoints(JEV_THRESHOLD)})`,
		turnId,
	);
	return db.prepare(guarded.sql).bind(JSON.stringify(ids), ...guarded.binds);
}

/**
 * Puts one cleared row's Maybe mark back, but only while the row is still untouched since the clear: no category, no
 * source, and the cleared fields still NULL. A row that was answered (its confidence written) or decided is left alone.
 * Only while the sorting turn is held, so no other sort ever reads a cleared mark (decision 160).
 */
export function reaskRestoreStatement(
	db: D1Database,
	mark: ReaskMark,
	turnId: string,
): D1PreparedStatement {
	const guarded = withTurnGuard(
		`UPDATE transactions SET category_confidence = ?, jev_mixed = ?, jev_also_category_id = ?
		WHERE id = ? AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
			AND jev_mixed IS NULL AND jev_also_category_id IS NULL`,
		turnId,
	);
	return db
		.prepare(guarded.sql)
		.bind(mark.confidence, mark.mixed, mark.also, mark.id, ...guarded.binds);
}

/** The run's snapshots, read from the run row (parameter ?1 is RUN_KEY). */
const SNAPSHOTS = `(SELECT json_extract(value, '$.snapshots') FROM household_settings WHERE key = ?1)`;

/** The Maybe range for a category guess, as basis points on a confidence column (`t`). */
const maybeRangeSql = () => {
	const bounds = askedBounds("category");
	return `CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) > ${bounds.above} AND CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) < ${bounds.below}`;
};

export type FinishResult = {
	moved: number;
	needAnswer: number;
	categories: string[];
	/** False while some sorting instances have not finished yet (nothing is moved, recorded or restored then). */
	finished: boolean;
	/** The instances still to finish. */
	pending: number;
};

/**
 * Finishes one sorting instance of the run. Without `instanceKey` the run is finalized at once. With it, the key is
 * recorded once in `finishedKeys`, and the run is finalized only when every instance (the run's `instances`) has
 * finished; before that this returns `finished: false` with the count still `pending`, and writes nothing else. A run
 * that is done, or not this one, changes nothing.
 */
export async function finishRun(
	db: D1Database,
	{
		runId,
		now,
		instanceKey,
	}: { runId: string; now: number; instanceKey?: string },
): Promise<FinishResult> {
	if (instanceKey !== undefined) {
		const waiting = await recordInstanceFinish(db, runId, instanceKey);
		if (waiting) return waiting;
	}
	return finalizeRun(db, { runId, now });
}

/** Records `key` as finished and returns the waiting result, or null when every instance has finished (or none can). */
async function recordInstanceFinish(
	db: D1Database,
	runId: string,
	key: string,
): Promise<FinishResult | null> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const row = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(RUN_KEY)
			.first<{ value: string }>();
		const current = row ? parseRun(row.value) : null;
		if (
			!row ||
			!current ||
			current.id !== runId ||
			current.status !== "running"
		)
			return null;
		let next = current;
		if (!current.finishedKeys.includes(key)) {
			next = { ...current, finishedKeys: [...current.finishedKeys, key] };
			if (!(await writeRunIf(db, row.value, next))) continue;
		}
		const pending = Math.max(0, next.instances - next.finishedKeys.length);
		if (pending === 0) return null;
		return {
			moved: 0,
			needAnswer: 0,
			categories: [],
			finished: false,
			pending,
		};
	}
	throw new Error("The re-sort could not record its finish. Try again.");
}

/**
 * Finalizes the run once: marks it done, records the rows the sort moved (each one of the run's own rows, filed into
 * the category its entry was started for, by Jev) with their categories and pre-run snapshots, counts how many now
 * need an answer, and restores the pre-run mark of each run row the run never reached (still untouched). A second
 * call changes nothing and returns the same counts. Undo stays open for UNDO_MS.
 */
async function finalizeRun(
	db: D1Database,
	{ runId, now }: { runId: string; now: number },
): Promise<FinishResult> {
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
	// The moved rows: the run's own rows, now in the category their own entry was started for, filed by Jev.
	const movedRows = `(SELECT json_group_array(json_object('id', t.id, 'categoryId', t.category_id, 'snapshot', json(s.value)))
		FROM json_each(json_extract(r.value, '$.snapshots')) s
		JOIN transactions t ON t.id = json_extract(s.value, '$.id')
		WHERE t.category_id = json_extract(r.value, '$.categoryByRow.' || t.id) AND t.category_source = 'jev')`;
	const record = db
		.prepare(
			`INSERT INTO household_settings (key, value)
			SELECT ?3, json_object(
				'runId', json_extract(r.value, '$.id'),
				'categoryId', json_extract(r.value, '$.categoryId'),
				'categoryName', json_extract(r.value, '$.categoryName'),
				'categories', json((SELECT json_group_array(json_extract(c.value, '$.name'))
					FROM json_each(json_extract(r.value, '$.categories')) c
					WHERE json_extract(c.value, '$.id') IN (SELECT json_extract(m.value, '$.categoryId') FROM json_each(${movedRows}) m))),
				'until', ?4,
				'rows', json(${movedRows}),
				'needAnswer', (SELECT COUNT(*) FROM transactions t
					WHERE t.id IN (${runRowIds}) AND t.category_id IS NULL AND ${maybeRangeSql()})
			)
			FROM household_settings r WHERE r.key = ?1 AND json_extract(r.value, '$.finishToken') = ?2`,
		)
		.bind(RUN_KEY, token, key, now + UNDO_MS);

	// Whether this call flipped the run or not, the record holds the answer: this call's, or the one that finished it.
	await db.batch([flip, restore, record]);
	const counts = (await readRecord(db, runId)) ?? {
		moved: 0,
		needAnswer: 0,
		categories: [],
	};
	return { ...counts, finished: true, pending: 0 };
}

/** The moved record's counts and category names, or null when there is none (never finished, or Undo has removed it). */
async function readRecord(
	db: D1Database,
	runId: string,
): Promise<{ moved: number; needAnswer: number; categories: string[] } | null> {
	const row = await db
		.prepare("SELECT value FROM household_settings WHERE key = ?")
		.bind(movedKey(runId))
		.first<{ value: string }>();
	if (!row) return null;
	const record = JSON.parse(row.value) as MovedRecord;
	return {
		moved: record.rows.length,
		needAnswer: record.needAnswer,
		categories: record.categories,
	};
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
 * Undo: puts back the snapshot of each moved row that still reads as the run left it (its category is the one it moved
 * into and its source is Jev), and only before the record's `until`. A row that changed since is left alone and counted in
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
				AND category_id = (SELECT json_extract(s.value, '$.categoryId') FROM json_each(${rows}) s WHERE json_extract(s.value, '$.id') = transactions.id)
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
