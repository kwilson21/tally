// The re-sort's run state (decision 160): one run at a time, kept as JSON in household_settings under `resort_run`, and
// the rows it moved, kept under `resort_moved_<runId>`: the record holds the closing toast's claim and Undo's deadline
// (ten seconds from the claim), and an unclaimed record lasts STALE_MS from its finish. No new table. Nothing here
// calls Jev or Workers AI.
//
// Concurrency: a run starts or joins by compare-and-set on the exact text it read (a write that finds the text changed
// writes nothing and reads again). Progress is one JSON-editing UPDATE that only moves a running run. A sorting instance
// records its finish by compare-and-set too; the run is finalized by one batch (one D1 transaction) whose first
// statement flips it to done with a fresh token, and the restore and record run only if that flip happened. A keyed
// finish flips only while every instance has finished, so a joiner that arrived since raises the count and the flip
// does nothing. Undo is one batch that restores only the moved rows still as the run left them, while the record's
// claim is open. A row is the same transaction only while its Plaid id and amount are the ones the run recorded, so a
// deleted row whose id another purchase reused is never restored or undone.

import { JEV_THRESHOLD } from "../ai/categorize";
import { BASIS_POINTS, confidenceBasisPoints } from "../ai/confidence";
import { askedBounds } from "../ai/maybe";
import { COUNTED_JOINS } from "./counted-month";
import { WAITING } from "./more-like-this";
import {
	RESORT_CANDIDATE_MAX,
	type ResortCandidate,
	type ResortSnapshot,
} from "./resort-candidates";
import { withTurnGuard } from "./sorting-turn";

export const RUN_KEY = "resort_run";
/** A run older than this is closed when the next run starts (decision 160), and an unclaimed record lasts as long. */
export const STALE_MS = 2 * 60 * 60_000;
/** How long Undo stays open after the closing toast is claimed (decision 160, the existing toast's 10 seconds). */
export const UNDO_MS = 10_000;

const MOVED_PREFIX = "resort_moved_";
export const movedKey = (runId: string) => `${MOVED_PREFIX}${runId}`;

/** A candidate's pre-run snapshot, with the identity Finish and Undo check: its Plaid id and its amount in cents. */
export type RunSnapshot = ResortSnapshot & {
	plaid_transaction_id: string | null;
	amount_cents: number;
};

export type ResortRun = {
	id: string;
	total: number;
	done: number;
	status: "running" | "done";
	instances: number;
	ids: number[];
	snapshots: RunSnapshot[];
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
	/** True once the run's closing toast was claimed while this run was the current one. */
	toasted: boolean;
	/** Set when the run finishes: the token of the one finish that did it. */
	finishToken?: string;
};

/** The record of the rows a run moved, kept for the closing toast and Undo. */
export type MovedRecord = {
	runId: string;
	categoryId: number;
	categoryName: string;
	/** The names of the categories the moved rows went to (the toast), in category id order. */
	categories: string[];
	/** The moved rows per category they went to: the toast's counts. */
	byCategory: { id: number; name: string; count: number }[];
	/** When the closing toast was claimed; null until it is. */
	claimedAt: number | null;
	/** Undo is open until this time (ms): claimedAt + UNDO_MS. Null until the toast is claimed. */
	until: number | null;
	/** When the run was finalized: an unclaimed record is removed STALE_MS after this. */
	finalizedAt: number;
	/** Each row the run moved: the category it now holds (Undo puts it back from there), its identity and its snapshot. */
	rows: {
		id: number;
		categoryId: number;
		plaid_transaction_id: string | null;
		amount_cents: number;
		snapshot: RunSnapshot;
	}[];
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
 * category it was started for. A run holds at most RESORT_CANDIDATE_MAX rows, so a join adds only the room left. With
 * no candidates and no fresh running run, nothing is started or written: the result is
 * `{runId: null, newIds: [], joined: false}`, so an empty re-sort never leaves a run running.
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
	// The identity comes from the candidate row it was read with, in the same query as its snapshot.
	const snapshotOf = (c: ResortCandidate): RunSnapshot => ({
		...c.snapshot,
		plaid_transaction_id: c.plaidTransactionId,
		amount_cents: c.amountCents,
	});

	for (let attempt = 0; attempt < 5; attempt++) {
		const row = await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(RUN_KEY)
			.first<{ value: string }>();
		const expected = row?.value ?? null;
		const current = row ? parseRun(row.value) : null;

		if (current?.status === "running" && now - current.startedAt <= STALE_MS) {
			const room = Math.max(0, RESORT_CANDIDATE_MAX - current.ids.length);
			const fresh = freshCandidates(candidates, new Set(current.ids)).slice(
				0,
				room,
			);
			// Nothing new to add: join without writing, so no instance is counted for a call that asks nothing.
			if (fresh.length === 0)
				return { runId: current.id, newIds: [], joined: true };
			const next: ResortRun = {
				...current,
				total: current.total + fresh.length,
				ids: [...current.ids, ...fresh.map((c) => c.id)],
				snapshots: [...current.snapshots, ...fresh.map(snapshotOf)],
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
			// Stale: close it (forced: its instances are not waited for), then start over from the stored text the close leaves.
			await finishRun(db, { runId: current.id, now });
			continue;
		}

		const fresh = freshCandidates(candidates, new Set()).slice(
			0,
			RESORT_CANDIDATE_MAX,
		);
		if (fresh.length === 0) return { runId: null, newIds: [], joined: false };
		const run: ResortRun = {
			id: crypto.randomUUID(),
			total: fresh.length,
			done: 0,
			status: "running",
			instances: 1,
			ids: fresh.map((c) => c.id),
			snapshots: fresh.map(snapshotOf),
			categoryId,
			categoryName,
			categories: [{ id: categoryId, name: categoryName }],
			categoryByRow: byRow(fresh, categoryId),
			finishedKeys: [],
			startedAt: now,
			toasted: false,
		};
		if (await writeRunIf(db, expected, run)) {
			await sweepMovedRecords(db, now);
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

/**
 * True when the row `alias` is the transaction the run snapshotted for its id: the same Plaid id and amount. A deleted
 * row's id that another purchase reused fails this, so it is never restored or counted as moved.
 */
const sameRunRow = (alias: string, list: string) =>
	`EXISTS (SELECT 1 FROM json_each(${list}) s WHERE json_extract(s.value, '$.id') = ${alias}.id
		AND ${alias}.plaid_transaction_id IS json_extract(s.value, '$.plaid_transaction_id')
		AND ${alias}.amount_cents = json_extract(s.value, '$.amount_cents'))`;

/** The Maybe range for a category guess, as basis points on a confidence column (`t`). */
const maybeRangeSql = () => {
	const bounds = askedBounds("category");
	return `CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) > ${bounds.above} AND CAST(t.category_confidence * ${BASIS_POINTS} AS INTEGER) < ${bounds.below}`;
};

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
				AND t.id IN (SELECT value FROM json_each(?2))
				AND ${sameRunRow("t", SNAPSHOTS)}`,
		)
		.bind(RUN_KEY, JSON.stringify(wanted))
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
		`UPDATE transactions SET category_confidence = ?, jev_mixed = ?, jev_also_category_id = ?,
			updated_at = CASE WHEN category_confidence IS NOT ? OR jev_mixed IS NOT ? OR jev_also_category_id IS NOT ?
				THEN datetime('now') ELSE updated_at END
		WHERE id = ? AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
			AND jev_mixed IS NULL AND jev_also_category_id IS NULL`,
		turnId,
	);
	return db
		.prepare(guarded.sql)
		.bind(
			mark.confidence,
			mark.mixed,
			mark.also,
			mark.confidence,
			mark.mixed,
			mark.also,
			mark.id,
			...guarded.binds,
		);
}

type FinishCounts = {
	moved: number;
	needAnswer: number;
	categories: string[];
	byCategory: { id: number; name: string; count: number }[];
};

export type FinishResult = FinishCounts & {
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
	if (instanceKey === undefined)
		return finalizeRun(db, { runId, now, keyed: false });
	const waiting = await recordInstanceFinish(db, runId, instanceKey);
	if (waiting) return waiting;
	return finalizeRun(db, { runId, now, keyed: true });
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
			byCategory: [],
			finished: false,
			pending,
		};
	}
	throw new Error("The re-sort could not record its finish. Try again.");
}

/**
 * Finalizes the run once: marks it done, records the rows the sort moved (each one of the run's own rows that Jev filed
 * into a category, whichever it is) with the category each holds and its snapshot, counts how many now need an
 * answer, and restores the pre-run mark of each run row the run never reached (still untouched). A keyed finalize
 * flips only while every instance has finished; if the flip does nothing, the run is still open and this returns the
 * waiting result. A second call changes nothing and returns the same counts.
 */
async function finalizeRun(
	db: D1Database,
	{ runId, now, keyed }: { runId: string; now: number; keyed: boolean },
): Promise<FinishResult> {
	const token = crypto.randomUUID();
	const key = movedKey(runId);
	// Parameter ?1 is RUN_KEY, ?2 the finish token: the restore and record only happen for the call that flipped.
	const won = `EXISTS (SELECT 1 FROM household_settings WHERE key = ?1 AND json_extract(value, '$.finishToken') = ?2)`;

	// The flip is the compare-and-set: a keyed finish flips only while the finished keys still cover every instance.
	const flip = db
		.prepare(
			`UPDATE household_settings SET value = json_set(value, '$.status', 'done', '$.finishToken', ?)
			WHERE key = ? AND json_extract(value, '$.id') = ? AND json_extract(value, '$.status') = 'running'
				AND (? = 1 OR json_array_length(json_extract(value, '$.finishedKeys')) >= json_extract(value, '$.instances'))`,
		)
		.bind(token, RUN_KEY, runId, keyed ? 0 : 1);

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
				updated_at = CASE WHEN category_id IS NOT ${snap("category_id")}
					OR category_source IS NOT ${snap("category_source")}
					OR category_confidence IS NOT ${snap("category_confidence")}
					OR jev_category_id IS NOT ${snap("jev_category_id")}
					OR jev_none_fit IS NOT ${snap("jev_none_fit")}
					OR jev_mixed IS NOT ${snap("jev_mixed")}
					OR jev_also_category_id IS NOT ${snap("jev_also_category_id")}
					OR jev_failed_at IS NOT ${snap("jev_failed_at")}
				THEN datetime('now') ELSE updated_at END
			WHERE ${sameRunRow("transactions", SNAPSHOTS)}
				AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL
				AND jev_mixed IS NULL AND jev_also_category_id IS NULL AND jev_failed_at IS NULL
				AND ${won}`,
		)
		.bind(RUN_KEY, token);

	// The moved rows: the run's own rows that were undecided and that Jev has filed into some category (whichever it is),
	// still the same transaction. Each records the category it now holds, which is where Undo puts it back from.
	const movedRows = `(SELECT json_group_array(json_object('id', t.id, 'categoryId', t.category_id,
			'plaid_transaction_id', t.plaid_transaction_id, 'amount_cents', t.amount_cents, 'snapshot', json(s.value)))
		FROM json_each(json_extract(r.value, '$.snapshots')) s
		JOIN transactions t ON t.id = json_extract(s.value, '$.id')
			AND t.plaid_transaction_id IS json_extract(s.value, '$.plaid_transaction_id')
			AND t.amount_cents = json_extract(s.value, '$.amount_cents')
		WHERE t.category_id IS NOT NULL AND t.category_source = 'jev')`;
	// The categories the moved rows went to, from their actual destinations (names and counts), in id order.
	const destinations = `(SELECT c.id AS id, c.name AS name, COUNT(*) AS n
		FROM json_each(${movedRows}) m JOIN categories c ON c.id = json_extract(m.value, '$.categoryId')
		GROUP BY c.id ORDER BY c.id)`;
	const record = db
		.prepare(
			`INSERT INTO household_settings (key, value)
			SELECT ?3, json_object(
				'runId', json_extract(r.value, '$.id'),
				'categoryId', json_extract(r.value, '$.categoryId'),
				'categoryName', json_extract(r.value, '$.categoryName'),
				'categories', json((SELECT json_group_array(d.name) FROM ${destinations} d)),
				'byCategory', json((SELECT json_group_array(json_object('id', d.id, 'name', d.name, 'count', d.n)) FROM ${destinations} d)),
				'claimedAt', NULL,
				'until', NULL,
				'finalizedAt', ?4,
				'rows', json(${movedRows}),
				'needAnswer', (SELECT COUNT(*) FROM transactions t
					WHERE t.category_id IS NULL AND ${maybeRangeSql()} AND ${sameRunRow("t", SNAPSHOTS)})
			)
			FROM household_settings r WHERE r.key = ?1 AND json_extract(r.value, '$.finishToken') = ?2`,
		)
		.bind(RUN_KEY, token, key, now);

	// Whether this call flipped the run or not, the record holds the answer: this call's, or the one that finished it.
	await db.batch([flip, restore, record]);
	await sweepMovedRecords(db, now);

	const run = await readRun(db);
	if (run && run.id === runId && run.status === "running") {
		// A keyed finish that lost its flip to a joiner: the run stays open for the instances still to finish.
		return {
			moved: 0,
			needAnswer: 0,
			categories: [],
			byCategory: [],
			finished: false,
			pending: Math.max(0, run.instances - run.finishedKeys.length),
		};
	}
	const counts = (await readRecord(db, runId)) ?? {
		moved: 0,
		needAnswer: 0,
		categories: [],
		byCategory: [],
	};
	return { ...counts, finished: true, pending: 0 };
}

/** The moved record's counts and category names, or null when there is none (never finished, or Undo has removed it). */
async function readRecord(
	db: D1Database,
	runId: string,
): Promise<FinishCounts | null> {
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
		byCategory: record.byCategory,
	};
}

/**
 * Removes the moved records that can no longer be used: a claimed one past its Undo, and an unclaimed one STALE_MS past
 * its finish (the toast was never shown). Runs on every new run, every claim and every finalize.
 */
async function sweepMovedRecords(db: D1Database, now: number): Promise<void> {
	await db
		.prepare(
			`DELETE FROM household_settings WHERE substr(key, 1, ?) = ? AND (
				(json_extract(value, '$.claimedAt') IS NOT NULL AND json_extract(value, '$.until') < ?)
				OR (json_extract(value, '$.claimedAt') IS NULL AND json_extract(value, '$.finalizedAt') + ? < ?))`,
		)
		.bind(MOVED_PREFIX.length, MOVED_PREFIX, now, STALE_MS, now)
		.run();
}

/**
 * True for the one call that claims a finished run's closing toast: it sets the claim time and opens Undo for UNDO_MS
 * from `now`. Every later call gets false, and so does a run with no finished record (still running, or never ran). The
 * claim lives in the run's own moved record, so it still works after a newer run has replaced `resort_run`.
 */
export async function closeToastOnce(
	db: D1Database,
	runId: string,
	now: number,
): Promise<boolean> {
	const [claim] = await db.batch([
		db
			.prepare(
				`UPDATE household_settings SET value = json_set(value, '$.claimedAt', ?, '$.until', ? + ?)
				WHERE key = ? AND json_extract(value, '$.claimedAt') IS NULL
					AND json_extract(value, '$.finalizedAt') + ? >= ?`,
			)
			.bind(now, now, UNDO_MS, movedKey(runId), STALE_MS, now),
		db
			.prepare(
				`UPDATE household_settings SET value = json_set(value, '$.toasted', json('true'))
				WHERE key = ? AND json_extract(value, '$.id') = ? AND json_extract(value, '$.status') = 'done'`,
			)
			.bind(RUN_KEY, runId),
	]);
	await sweepMovedRecords(db, now);
	return (claim?.meta.changes ?? 0) > 0;
}

/**
 * Undo: puts back the snapshot of each moved row that still reads as the run left it (its category is the one it moved
 * into, its source is Jev, and it is the same transaction), and only while the record's claimed Undo is open. A row
 * that changed since is left alone and counted in `changedSince`. `expired` is true when no Undo is open for the run
 * (none, not yet claimed, or the ten seconds have passed); then nothing is restored, and an expired record is removed.
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

	// Parameter ?1 is the record's key, ?2 the time. The record's own `until` (null until claimed) is checked in every write.
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
				AND ${sameRunRow("transactions", rows)}
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
