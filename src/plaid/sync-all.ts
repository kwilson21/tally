import * as Effect from "effect/Effect";
import { enabled } from "../routes/plaid";
import { afterSync } from "./after-sync";
import { type PlaidEnv, PlaidError } from "./client";
import { merchantTurns, syncItem } from "./sync";
import {
	SYNC_BANKS_AT_ONCE,
	SYNC_COOLDOWN_SECONDS,
	SYNC_RUN_BUDGET_MS,
} from "./timing";

type SyncAllEnv = PlaidEnv & { DB: D1Database; DEMO?: string };

export type SyncAllResult = {
	added: number;
	/** Transactions the banks changed (a pending one posting, a corrected amount); `added` doesn't count them. */
	modified: number;
	/** The ids of the transaction rows the banks added or modified, for the run that sorts them (spec §8.6). */
	changedIds: number[];
	synced: number;
	skipped: number;
	/** Of the skipped: banks attempted within the last minute, or locked by a sync already running. */
	busy: number;
	failed: number;
	failedBanks: string[];
	/** Set when the household-wide step after the banks (rules, then bill matching) failed. */
	afterSyncFailed?: true;
};

type Bank = { id: number; institution_name: string };

/** How one bank's turn ended. A busy bank was attempted within the last minute, or is locked by a sync already running. */
type BankOutcome =
	| { kind: "skipped" }
	| { kind: "busy" }
	| { kind: "failed"; bank: string }
	| { kind: "synced"; added: number; modified: number; changedIds: number[] };

/** Adds one bank's outcome to the run's totals. */
function count(result: SyncAllResult, outcome: BankOutcome) {
	if (outcome.kind === "synced") {
		result.synced += 1;
		result.added += outcome.added;
		result.modified += outcome.modified;

		for (const id of outcome.changedIds) result.changedIds.push(id);
	} else if (outcome.kind === "failed") {
		result.failed += 1;
		result.failedBanks.push(outcome.bank);
	} else {
		result.skipped += 1;

		if (outcome.kind === "busy") result.busy += 1;
	}
}

/**
 * Syncs every healthy Plaid Item, a few at once, so one failure cannot stop the daily catch-up.
 * `retryFlagged` (the daily run only) also syncs a bank that needs attention (decision 173). Manual Sync now
 * leaves it out, so a flagged bank still answers "Fix the connection first.".
 */
export async function syncAllItems(
	env: SyncAllEnv,
	fetchImpl?: typeof fetch,
	now: () => number = Date.now,
	respectCooldown = false,
	{ retryFlagged = false }: { retryFlagged?: boolean } = {},
): Promise<SyncAllResult> {
	const startedAt = now();

	const result: SyncAllResult = {
		added: 0,
		modified: 0,
		changedIds: [],
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

	// The daily run also retries a bank that needs attention (decision 173): a sync that gets every page clears its
	// flag. A bank that still fails stays flagged, and its reminder is not touched here.
	const liveStatuses = retryFlagged ? "('ok', 'needs_attention')" : "('ok')";

	const { results: items } = await env.DB.prepare(
		`SELECT id, institution_name FROM plaid_items WHERE status IN ${liveStatuses} AND disconnected_at IS NULL ORDER BY id`,
	).all<Bank>();

	// The one step the banks do not do side by side: starting a merchant two of them name for the first time.
	const merchantTurn = merchantTurns();

	// One bank's turn. It never throws: a failure is counted and logged here, so one bank cannot stop the others.
	const syncBank = async (item: Bank): Promise<BankOutcome> => {
		// The budget is checked as each bank starts, so a bank that has not started when it runs out waits for the next run.
		if (now() - startedAt >= SYNC_RUN_BUDGET_MS) return { kind: "skipped" };

		try {
			// Claiming the attempt is one statement, so two overlapping manual syncs can't both win.
			// The attempt is recorded before syncing, so a failed attempt still counts toward the minute.
			const claim = await env.DB.prepare(
				respectCooldown
					? `UPDATE plaid_items SET last_sync_attempt_at = datetime('now')
						WHERE id = ? AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at <= datetime('now', '-${SYNC_COOLDOWN_SECONDS} seconds'))`
					: "UPDATE plaid_items SET last_sync_attempt_at = datetime('now') WHERE id = ?",
			)
				.bind(item.id)
				.run();

			if (claim.meta.changes !== 1) return { kind: "busy" };

			const current = await env.DB.prepare(
				"SELECT status FROM plaid_items WHERE id = ? AND disconnected_at IS NULL",
			)
				.bind(item.id)
				.first<{ status: string }>();

			// Gone, disconnected, or (for a manual run) flagged since the list was read: skip.
			if (!current || (!retryFlagged && current.status !== "ok"))
				return { kind: "skipped" };

			const synced = await syncItem(env, item.id, fetchImpl, {
				runAfterSync: false,
				merchantTurn,
			});

			return "skipped" in synced
				? { kind: "busy" }
				: {
						kind: "synced",
						added: synced.added,
						modified: synced.modified,
						changedIds: synced.changedIds,
					};
		} catch (error) {
			const kind =
				error instanceof PlaidError
					? `plaid ${error.request_id ?? "unknown"}`
					: error instanceof Error
						? error.name
						: "unknown";

			console.error(`plaid daily sync: item ${item.id} failed ${kind}`);

			return { kind: "failed", bank: item.institution_name };
		}
	};

	// The banks sync side by side, a few at once (SYNC_BANKS_AT_ONCE): each claims itself and holds its own lease, so
	// they share nothing but this run's totals, which are added up in bank order once every bank has answered.
	const outcomes = await Effect.runPromise(
		Effect.forEach(items, (item) => Effect.promise(() => syncBank(item)), {
			concurrency: SYNC_BANKS_AT_ONCE,
		}),
	);

	for (const outcome of outcomes) count(result, outcome);

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
