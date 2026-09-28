import { enabled } from "../routes/plaid";
import { type PlaidEnv, PlaidError } from "./client";
import { syncItem } from "./sync";

type SyncAllEnv = PlaidEnv & { DB: D1Database; DEMO?: string };

export type SyncAllResult = {
	added: number;
	synced: number;
	skipped: number;
	failed: number;
	failedBanks: string[];
};

/** Syncs each healthy Plaid Item in turn so one failure cannot stop the daily catch-up. */
export async function syncAllItems(
	env: SyncAllEnv,
	fetchImpl?: typeof fetch,
	now: () => number = Date.now,
	respectCooldown = false,
): Promise<SyncAllResult> {
	const startedAt = now();
	const result: SyncAllResult = {
		added: 0,
		synced: 0,
		skipped: 0,
		failed: 0,
		failedBanks: [],
	};
	if (!enabled(env)) {
		logResult(result);
		return result;
	}

	const { results: items } = await env.DB.prepare(
		"SELECT id, institution_name, last_sync_attempt_at FROM plaid_items WHERE status = 'ok' ORDER BY id",
	).all<{
		id: number;
		institution_name: string;
		last_sync_attempt_at: string | null;
	}>();

	for (const [index, item] of items.entries()) {
		if (
			respectCooldown &&
			item.last_sync_attempt_at &&
			Date.now() -
				new Date(`${item.last_sync_attempt_at.replace(" ", "T")}Z`).getTime() <
				60_000
		) {
			result.skipped += 1;
			continue;
		}
		if (now() - startedAt >= 12 * 60 * 1000) {
			result.skipped += items.length - index;
			break;
		}

		try {
			await env.DB.prepare(
				"UPDATE plaid_items SET last_sync_attempt_at = datetime('now') WHERE id = ?",
			)
				.bind(item.id)
				.run();
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
			else {
				result.synced += 1;
				result.added += synced.added;
			}
		} catch (error) {
			result.failed += 1;
			result.failedBanks.push(item.institution_name);
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
