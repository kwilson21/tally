import { categorizePending } from "../categorize-pending";
import { asksJev, readAiSwitches } from "../db/ai-switches";
import { type SyncResult, syncItem } from "./sync";

type SortEnv = { DB: D1Database; JEV_API_KEY?: string; DEMO?: string };

/**
 * Right after a sync that brought in or changed transactions, asks Jev about the ones still
 * unsorted (spec §8.6, decision 68): the same pass as overnight, within the same day's cap, when the
 * household's "Sort new transactions as they arrive" switch is on and Jev is asked at all.
 *
 * It never fails the sync it follows: any failure is logged by its name alone (never a transaction or
 * a token) and left for the nightly run. It's slow, so a request runs it in `waitUntil`.
 */
export async function sortAfterSync(
	env: SortEnv,
	synced: { added: number; modified: number },
	fetchImpl?: typeof fetch,
	// Every sync's last step already applied merchant rules; pass false when that step failed.
	{ rulesApplied = true }: { rulesApplied?: boolean } = {},
): Promise<void> {
	if (synced.added + synced.modified === 0 || !env.JEV_API_KEY) return;
	try {
		const switches = await readAiSwitches(env.DB);
		if (!switches.sortOnArrival || !asksJev(switches)) return;
		await categorizePending(env, fetchImpl, { rulesApplied });
	} catch (error) {
		console.error(
			`sort after sync failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/** Syncs one bank, then sorts what it brought in. The sort adds nothing to what the sync reports or throws. */
export async function syncItemAndSort(
	env: Parameters<typeof syncItem>[0] & SortEnv,
	itemRowId: number,
	fetchImpl?: typeof fetch,
): Promise<SyncResult> {
	const synced = await syncItem(env, itemRowId, fetchImpl);
	if (!("skipped" in synced)) await sortAfterSync(env, synced, fetchImpl);
	return synced;
}
