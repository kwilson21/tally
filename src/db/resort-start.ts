// Starting the re-check after a Create that makes a category (decisions 157, 159, 160; #821). Every path that creates a
// category from Tally's suggestion calls startResortFor once its filing has succeeded: the Maybe card's "Create and
// next", the Suggestions page's new-category card, Settings' categories card and Organize's card. The run it starts
// asks Jev only about the rows that could now belong to the new category (resortCandidates), in the one sorting
// instance startSorting makes; the progress line and the closing toast read the run (runningRecheck, resort-run.ts).
//
// Nothing starts without the Jev key and the categories switch (the demo has neither, so nothing shows there). A
// "N more look like this" Add is not a trigger: it moves rows the person chose, with no AI.
//
// The re-check is an extra: the Create has already filed its category when this runs, so no failure here fails the
// Create (#842 review). Every error is logged by its name only, and the answer is null, as for "nothing to show".

import { buildClusters } from "../resort-clusters";
import { startSorting } from "../sort-start";
import type { RecheckRun } from "../views/recheck-line";
import { readAiSwitches } from "./ai-switches";
import { resortCandidates } from "./resort-candidates";
import {
	finishRun,
	type ResortRun,
	readRun,
	STALE_MS,
	startOrJoinRun,
} from "./resort-run";
import { suggestionQueue } from "./suggestions-queue";

/**
 * The transaction ids in the review queue, in queue order: a Maybe's own row, and the rows a new-category card shows.
 * A name suggestion has no transaction, so it gives none.
 */
export async function queueTransactionIds(db: D1Database): Promise<number[]> {
	const queue = await suggestionQueue(db);

	return queue.flatMap((item) => {
		if (item.kind === "name") return [];

		if (item.kind === "new_category")
			return item.rows.map((row) => row.transactionId);

		return [item.transactionId];
	});
}

/** A run that is still going: running, and started within STALE_MS (an older one is closed by the next run). */
export const isRunning = (run: ResortRun, now: number): boolean =>
	run.status === "running" && now - run.startedAt <= STALE_MS;

/** The line's run: the current one while it is going, or null. One read. */
export async function runningRecheck(
	db: D1Database,
	now: number = Date.now(),
): Promise<RecheckRun | null> {
	const run = await readRun(db);

	if (!run || !isRunning(run, now)) return null;

	return { id: run.id, done: run.done, total: run.total };
}

/** A error's name for the log: never its message, which could carry row text. */
const errorName = (error: unknown): string =>
	error instanceof Error ? error.name : "unknown";

/**
 * Ends a run that this call wrote but whose instance never started, so the line never sticks. Best effort: a failure is
 * logged by its name, and the run is then left to the next run, which closes a stale one (decision 160).
 */
async function endUnstarted(db: D1Database, runId: string): Promise<void> {
	try {
		await finishRun(db, {
			runId,
			now: Date.now(),
			instanceKey: crypto.randomUUID(),
		});
	} catch (error) {
		console.error(`resort: couldn't end its run ${errorName(error)}`);
	}
}

/**
 * The run this call wrote and whose start is still owed, if the call failed before its instance started. A
 * startOrJoinRun that throws after writing a new run gives back no id, so the run is found by its start time: the one
 * this call stamped with `now`, still running.
 */
async function orphanRun(
	db: D1Database,
	now: number,
	owed: string | null,
): Promise<string | null> {
	if (owed !== null) return owed;

	try {
		const run = await readRun(db);

		return run?.status === "running" && run.startedAt === now ? run.id : null;
	} catch {
		return null;
	}
}

/**
 * Starts the re-check for the category the row `filedId` was just filed in. Returns the run's id when there is one to
 * show (a new run, or a join: a join with nothing new shows the line without starting an instance), or null when
 * nothing starts. `excludeIds` are rows another path already asks (the left-out rows of a create) and the filed rows,
 * so Jev is never asked twice for the same row. A run whose instance could not be created is finished at once, with a
 * fresh instance key, so the line never sticks (decision 160). Never throws (#842 review).
 */
export async function startResortFor(
	env: { JEV_API_KEY?: string; SORT: Env["SORT"] },
	db: D1Database,
	{
		filedId,
		excludeIds = [],
		now = Date.now(),
	}: { filedId: number; excludeIds?: readonly number[]; now?: number },
): Promise<string | null> {
	// The run this call added instances to, while its own instance is still owed.
	const owed: { runId: string | null } = { runId: null };

	try {
		return await startFor(env, db, { filedId, excludeIds, now }, owed);
	} catch (error) {
		console.error(`resort: couldn't start ${errorName(error)}`);
		const runId = await orphanRun(db, now, owed.runId);

		if (runId !== null) await endUnstarted(db, runId);

		return null;
	}
}

/** The work of startResortFor, which reports the run it owes through `owed` until its instance starts. */
async function startFor(
	env: { JEV_API_KEY?: string; SORT: Env["SORT"] },
	db: D1Database,
	{
		filedId,
		excludeIds,
		now,
	}: { filedId: number; excludeIds: readonly number[]; now: number },
	owed: { runId: string | null },
): Promise<string | null> {
	if (!env.JEV_API_KEY) return null;

	if (!(await readAiSwitches(db)).categories) return null;

	const filed = await db
		.prepare(
			"SELECT category_id AS categoryId, jev_category_id AS cameFrom FROM transactions WHERE id = ?",
		)
		.bind(filedId)
		.first<{ categoryId: number | null; cameFrom: number | null }>();

	if (!filed || filed.categoryId === null) return null;

	const category = await db
		.prepare("SELECT id, name FROM categories WHERE id = ?")
		.bind(filed.categoryId)
		.first<{ id: number; name: string }>();

	if (!category) return null;

	const skip = new Set<number>([...excludeIds, filedId]);

	const candidates = (
		await resortCandidates(db, {
			filedId,
			newCategoryId: category.id,
			cameFromCategoryId: filed.cameFrom,
			queueIds: await queueTransactionIds(db),
		})
	).filter((candidate) => !skip.has(candidate.id));

	if (candidates.length === 0) return null;

	const started = await startOrJoinRun(db, {
		candidates,
		categoryId: category.id,
		categoryName: category.name,
		now,
	});

	if (started.runId === null) return null;

	if (started.newIds.length === 0) return started.runId;

	// Owed from here until the instance is created: a failure now, or a refused start, ends the run.
	owed.runId = started.runId;
	const fresh = new Set(started.newIds);

	const ok = await startSorting(env, {
		bySync: false,
		rulesApplied: true,
		reask: {
			runId: started.runId,
			ids: started.newIds,
			clusters: buildClusters(candidates.filter((c) => fresh.has(c.id))),
		},
	});

	owed.runId = null;

	if (ok) return started.runId;
	// A refused start: no instance is coming for the rows this call added, so the run is ended here.
	await endUnstarted(db, started.runId);

	return null;
}
