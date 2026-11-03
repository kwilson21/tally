// Starting a sorting instance from a trigger (spec §8.6, decision 139). Kept apart from the Workflow class
// (sort-workflow.ts), which imports `cloudflare:workers`, so the in-process code and the Node verification run can
// import it too.

/**
 * A re-ask instance's rows (decision 160): Jev is asked once more about each of these candidate ids, in this order, for
 * the re-sort run `runId`. Only the run's still-waiting rows are asked, and the instance ignores the sync switch.
 */
export type ReaskParams = {
	runId: string;
	ids: number[];
	/**
	 * The re-ask's clusters (decision 158), each `[leaderId, ...followerIds]` as buildClusters gives them. Jev is asked
	 * about each leader only, and a leader's answer applies to its followers. A candidate in no cluster is its own leader.
	 */
	clusters?: number[][];
};

/** What one instance sorts: `ids` (none for all waiting), whether a sync started it, and whether its rules already ran. */
export type SortParams = {
	ids?: number[];
	bySync: boolean;
	rulesApplied: boolean;
	/** A re-sort's re-ask (decision 160): sorts only these candidate rows, and finishes the run after its groups. */
	reask?: ReaskParams;
	/** The night's instance only: the 09:00 run's UTC day (YYYY-MM-DD). After sorting, it clears the daily run's wait mark (production) and makes the night's names and new-category suggestions. */
	night?: string;
};

/**
 * Starts one sorting instance with these rows, from a sync, Sync now, the webhook, ask again, or the 09:00 run (the
 * night's instance). It returns at once, and never throws: a start that fails is logged by its error name only.
 * Nothing starts with no rows, or with no Jev key unless it is the night's. The result is true only when the instance
 * was created, so a caller that is waiting on it (a re-sort's run, decision 160) can finish its own instance when not.
 */
export async function startSorting(
	env: { JEV_API_KEY?: string; SORT: Env["SORT"] },
	params: SortParams,
): Promise<boolean> {
	const rows = params.reask ? params.reask.ids.length : params.ids?.length;
	if (rows === 0) return false;
	// The night starts without a Jev key too: its names and suggestions don't need one (sorting then asks nothing).
	if (!env.JEV_API_KEY && !params.night) return false;
	try {
		await env.SORT.create({ params });
		return true;
	} catch (error) {
		console.error(
			`sorting: couldn't start ${error instanceof Error ? error.name : "unknown"}`,
		);
		return false;
	}
}
