import { enabled } from "../routes/plaid";
import { type PlaidEnv, PlaidError } from "./client";
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
	now: () => number = Date.now,
): Promise<SyncAllResult> {
	const startedAt = now();
	const result: SyncAllResult = { synced: 0, skipped: 0, failed: 0 };
	if (!enabled(env)) {
		logResult(result);
		return result;
	}

	const { results: items } = await env.DB.prepare(
		"SELECT id FROM plaid_items WHERE status = 'ok' ORDER BY id",
	).all<{ id: number }>();

	for (const [index, item] of items.entries()) {
		if (now() - startedAt >= 12 * 60 * 1000) {
			result.skipped += items.length - index;
			break;
		}

		try {
			const current = await env.DB.prepare(
				"SELECT status FROM plaid_items WHERE id = ?",
			)
				.bind(item.id)
				.first<{ status: string }>();
			if (current?.status !== "ok") {
				result.skipped += 1;
				continue;
			}
			const synced = await syncItem(env, item.id, fetchImpl);
			if ("skipped" in synced) result.skipped += 1;
			else result.synced += 1;
		} catch (error) {
			result.failed += 1;
			const kind =
				error instanceof PlaidError
					? `plaid ${error.request_id ?? "unknown"}`
					: error instanceof Error
						? error.name
						: "unknown";
			console.error(`plaid daily sync: item ${item.id} failed ${kind}`);
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
