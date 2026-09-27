import { enabled } from "../routes/plaid";
import type { PlaidEnv } from "./client";
import { syncItem } from "./sync";

type SyncAllEnv = PlaidEnv & { DB: D1Database; DEMO?: string };

export type SyncAllResult = {
	synced: number;
	skipped: number;
	failed: number;
};

/** Syncs each healthy Plaid Item in turn so one failure cannot stop the daily catch-up. */
export async function syncAllItems(
	env: SyncAllEnv,
	fetchImpl?: typeof fetch,
): Promise<SyncAllResult> {
	const result: SyncAllResult = { synced: 0, skipped: 0, failed: 0 };
	if (!enabled(env)) {
		logResult(result);
		return result;
	}

	const { results: items } = await env.DB.prepare(
		"SELECT id FROM plaid_items WHERE status = 'ok' ORDER BY id",
	).all<{ id: number }>();

	for (const item of items) {
		try {
			const synced = await syncItem(env, item.id, fetchImpl);
			if ("skipped" in synced) result.skipped += 1;
			else result.synced += 1;
		} catch {
			// syncItem logs a Plaid request ID, when present; no Item data is safe to log here.
			result.failed += 1;
		}
	}

	logResult(result);
	return result;
}

function logResult(result: SyncAllResult) {
	console.log(
		`plaid daily sync: synced ${result.synced}, skipped ${result.skipped}, failed ${result.failed}`,
	);
}
