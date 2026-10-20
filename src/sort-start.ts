// Starting a sorting instance from a trigger (spec §8.6, decision 139). Kept apart from the Workflow class
// (sort-workflow.ts), which imports `cloudflare:workers`, so the in-process code and the Node verification run can
// import it too.

/** What one instance sorts: `ids` (none for all waiting), whether a sync started it, and whether its rules already ran. */
export type SortParams = {
	ids?: number[];
	bySync: boolean;
	rulesApplied: boolean;
	/** The night's instance only: the 09:00 run's UTC day (YYYY-MM-DD). After sorting, it makes the night's names and new-category suggestions, and in production keeps the first night's counts for this day. */
	night?: string;
};

/**
 * Starts one sorting instance with these rows, from a sync, Sync now, the webhook, ask again, or the 09:00 run (the
 * night's instance). It returns at once, and never throws: a start that fails is logged by its error name only.
 * Nothing starts with no rows, or with no Jev key unless it is the night's.
 */
export async function startSorting(
	env: { JEV_API_KEY?: string; SORT: Env["SORT"] },
	params: SortParams,
): Promise<void> {
	if (params.ids?.length === 0) return;
	// The night starts without a Jev key too: its names and suggestions don't need one (sorting then asks nothing).
	if (!env.JEV_API_KEY && !params.night) return;
	try {
		await env.SORT.create({ params });
	} catch (error) {
		console.error(
			`sorting: couldn't start ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}
