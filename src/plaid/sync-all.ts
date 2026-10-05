import { enabled } from "../routes/plaid";
import { afterSync } from "./after-sync";
import { type PlaidEnv, PlaidError } from "./client";
import { syncItem } from "./sync";

type SyncAllEnv = PlaidEnv & { DB: D1Database; DEMO?: string };

export type SyncAllResult = {
	added: number;
	synced: number;
	skipped: number;
	/** Of the skipped: banks attempted within the last minute, or locked by a sync already running. */
	busy: number;
	failed: number;
	failedBanks: string[];
	/** Set when the household-wide step after the banks (rules, then bill matching) failed. */
	afterSyncFailed?: true;
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
		busy: 0,
		failed: 0,
		failedBanks: [],
	};
	if (!enabled(env)) {
		logResult(result);
		return result;
	}

	const { results: items } = await env.DB.prepare(
		"SELECT id, institution_name FROM plaid_items WHERE status = 'ok' AND disconnected_at IS NULL ORDER BY id",
	).all<{ id: number; institution_name: string }>();

	for (const [index, item] of items.entries()) {
		if (now() - startedAt >= 12 * 60 * 1000) {
			result.skipped += items.length - index;
			break;
		}

		try {
			// Claiming the attempt is one statement, so two overlapping manual syncs can't both win.
			// The attempt is recorded before syncing, so a failed attempt still counts toward the minute.
			const claim = await env.DB.prepare(
				respectCooldown
					? `UPDATE plaid_items SET last_sync_attempt_at = datetime('now')
						WHERE id = ? AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at <= datetime('now', '-60 seconds'))`
					: "UPDATE plaid_items SET last_sync_attempt_at = datetime('now') WHERE id = ?",
			)
				.bind(item.id)
				.run();
			if (claim.meta.changes !== 1) {
				result.skipped += 1;
				result.busy += 1;
				continue;
			}
			const current = await env.DB.prepare(
				"SELECT status FROM plaid_items WHERE id = ? AND disconnected_at IS NULL",
			)
				.bind(item.id)
				.first<{ status: string }>();
			if (current?.status !== "ok") {
				result.skipped += 1;
				continue;
			}
			const synced = await syncItem(env, item.id, fetchImpl, {
				runAfterSync: false,
			});
			if ("skipped" in synced) {
				result.skipped += 1;
				result.busy += 1;
			} else {
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

	// Rules and bill matching cover the whole household, so they run once after every bank, not per
	// bank. They run even when no bank could sync (busy, failed part-way or needing attention): what
	// is already stored may still have transactions a rule can sort.
	try {
		await afterSync(env.DB);
	} catch (error) {
		result.afterSyncFailed = true;
		console.error(
			`plaid daily sync: after sync failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
	logResult(result);
	return result;
}

function logResult(result: SyncAllResult) {
	console.log(
		`plaid daily sync: synced ${result.synced}, skipped ${result.skipped}, failed ${result.failed}`,
	);
}
