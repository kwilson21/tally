// Starting the re-check after a Create that makes a category (decisions 157, 159, 160; #821). Every path that creates a
// category from Tally's suggestion calls startResortFor once its filing has succeeded: the Maybe card's "Create and
// next", the Suggestions page's new-category card, Settings' categories card and Organize's card. The run it starts
// asks Jev only about the rows that could now belong to the new category (resortCandidates), in the one sorting
// instance startSorting makes; the progress line and the closing toast read the run (runningRecheck, resort-run.ts).
//
// Nothing starts without the Jev key and the categories switch (the demo has neither, so nothing shows there). A
// "N more look like this" Add is not a trigger: it moves rows the person chose, with no AI.

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

/**
 * Starts the re-check for the category the row `filedId` was just filed in. Returns the run's id when there is one to
 * show (a new run, or a join: a join with nothing new shows the line without starting an instance), or null when
 * nothing starts. `excludeIds` are rows another path already asks (the left-out rows of a create) and the filed rows,
 * so Jev is never asked twice for the same row. A run whose instance could not be created is finished at once, with a
 * fresh instance key, so the line never sticks (decision 160).
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
	if (ok) return started.runId;
	// No instance is coming for the rows this call added, so this call's own instance is finished here.
	await finishRun(db, {
		runId: started.runId,
		now: Date.now(),
		instanceKey: crypto.randomUUID(),
	});
	return null;
}
