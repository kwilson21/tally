import { type SortParams, startSorting } from "../sort-start";
import { type SyncResult, syncItem } from "./sync";

type SortEnv = {
	DB: D1Database;
	JEV_API_KEY?: string;
	DEMO?: string;
	SORT: Env["SORT"];
};

/**
 * Right after a sync that brought in or changed transactions, starts one sorting instance with those rows and no others
 * (spec §8.6, decisions 68 and 136). Every row the sync added or changed goes to it, with no per-sync cap: Cloudflare
 * Workflows sorts them in groups of 25 (src/sort-workflow.ts). It follows "Sort new transactions as they arrive": the
 * instance stops sending once that switch is off, as every sync's run does. The instance applies merchant rules first,
 * unless the sync's last step already did (`rulesApplied`).
 *
 * It never fails the sync it follows: starting the instance never throws (startSorting logs the error's name only),
 * and the rows of a sync that failed part-way wait for the nightly run.
 */
export async function sortAfterSync(
	env: SortEnv,
	synced: { changedIds: number[] },
	// Every sync's last step already applied merchant rules; pass false when that step failed.
	{ rulesApplied = true }: { rulesApplied?: boolean } = {},
): Promise<void> {
	const params: SortParams = {
		ids: synced.changedIds,
		bySync: true,
		rulesApplied,
	};
	await startSorting(env, params);
}

/**
 * Syncs one bank, then sorts what it brought in. The sort adds nothing to what the sync reports or throws. `historyComplete`
 * is the webhook's historical_update_complete (#581), passed to the sync.
 */
export async function syncItemAndSort(
	env: Parameters<typeof syncItem>[0] & SortEnv,
	itemRowId: number,
	fetchImpl?: typeof fetch,
	{ historyComplete = false }: { historyComplete?: boolean } = {},
): Promise<SyncResult> {
	const synced = await syncItem(env, itemRowId, fetchImpl, { historyComplete });
	if (!("skipped" in synced)) await sortAfterSync(env, synced);
	return synced;
}
