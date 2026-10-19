// Starting a sorting instance from a daytime trigger (spec §8.6, decision 132). Kept apart from the Workflow class
// (sort-workflow.ts), which imports `cloudflare:workers`, so the in-process code and the Node verification run can
// import it too.

/** What one instance sorts: `ids` (none for all waiting), whether a sync started it, and whether its rules already ran. */
export type SortParams = {
	ids?: number[];
	bySync: boolean;
	rulesApplied: boolean;
};

/**
 * Starts one sorting instance with these rows, from a daytime trigger (a sync, Sync now, the webhook, ask again).
 * It returns at once, and never throws: a start that fails is logged by its error name only. Nothing starts with no
 * Jev key or no rows.
 */
export async function startSorting(
	env: { JEV_API_KEY?: string; SORT: Env["SORT"] },
	params: SortParams,
): Promise<void> {
	if (!env.JEV_API_KEY || params.ids?.length === 0) return;
	try {
		await env.SORT.create({ params });
	} catch (error) {
		console.error(
			`sorting: couldn't start ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}
