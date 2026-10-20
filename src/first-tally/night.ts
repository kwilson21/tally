// The first night after stroke four (P125 E, spec §5, §8.8, #586): its counts, kept across the runs. Nothing carries
// state between the runs except the first_tally record. The 09:00 run keeps its sync result (recordNightSync); the
// night's Workflow keeps the counts as its last step, once the night's sorting and names have all finished
// (keepNightCounts).

import { type AiSwitches, readAiSwitches } from "../db/ai-switches";
import { COUNTED_JOINS, INCLUDED } from "../db/counted-month";
import {
	keepNightStatement,
	nightSyncStatement,
	readFirstTally,
} from "../db/first-tally";
import { namesStillAsked } from "../db/merchant-names";
import {
	categoryAskedSql,
	incomeAskedSql,
	suggestionQueue,
	transferAskedSql,
} from "../db/suggestions-queue";
import {
	countWaitingForJev,
	HELD_FOR_REVIEW_SQL,
	NEEDS_CATEGORY,
} from "../db/transactions";
import type { SyncAllResult } from "../plaid/sync-all";

/** The UTC date a run's clock reads: the night's identity, the cron's own day (not a household day). */
export const utcDay = (ms: number): string =>
	new Date(ms).toISOString().slice(0, 10);

/**
 * The 09:00 run's sync result, kept for the night's Workflow to decide (#586). The run is clean when nothing failed or was
 * skipped, Plaid was on, and the household-wide step after the banks ran; nightSyncStatement adds that no connected bank
 * needs signing in, since a bank that needs it is never synced and the counts can't see it.
 */
export async function recordNightSync(
	db: D1Database,
	synced: SyncAllResult,
	on: string,
): Promise<void> {
	const clean =
		synced.failed === 0 &&
		synced.skipped === 0 &&
		!synced.afterSyncFailed &&
		!synced.disabled;
	await nightSyncStatement(db, { brought: synced.added, on, ok: clean }).run();
}

/**
 * The night's Workflow's last step (#586): keeps the night's counts when the 09:00 sync for `on` was ok and nothing waits: no
 * transaction is waiting for Jev's answer, and (with Workers AI bound and the names switch on) no bank text is waiting for
 * its name. A name that failed counts as done (namesStillAsked). Nothing is kept on a night that didn't finish, and the
 * next 09:00 run replaces the sync.
 */
export async function keepNightCounts(
	db: D1Database,
	env: { AI?: unknown },
	on: string,
): Promise<void> {
	const record = await readFirstTally(db);
	if (record?.nightSync?.on !== on || !record.nightSync.ok) return;
	const switches = await readAiSwitches(db);
	const waiting = await countWaitingForJev(db, {
		categories: switches.categories,
		income: switches.income,
	});
	if (waiting > 0) return;
	if (env.AI && switches.names && (await namesStillAsked(db)) > 0) return;
	await keepNightStatement(db, on, await needsYouCount(db, switches)).run();
}

/**
 * What asks a person something now, the same things Home asks about (#586), counted once each: a transaction that needs
 * a category, a credit held for review, or an income, transfer or category Maybe (the switch that asks it on), plus the
 * name and new-category suggestions the suggestions queue offers. A transaction counts once though it matches several.
 */
export async function needsYouCount(
	db: D1Database,
	switches: AiSwitches,
): Promise<number> {
	const maybe = [
		switches.income ? incomeAskedSql("t") : null,
		switches.categories ? transferAskedSql("t") : null,
		switches.categories ? categoryAskedSql("t") : null,
	].filter((sql): sql is string => sql !== null);
	const row = await db
		.prepare(
			`SELECT COUNT(DISTINCT t.id) AS n FROM transactions t ${COUNTED_JOINS}
			WHERE t.is_split = 0 AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.type = 'cash')
				AND (${NEEDS_CATEGORY} OR (${INCLUDED} AND ${HELD_FOR_REVIEW_SQL})
					${maybe.map((sql) => `OR ${sql}`).join("\n")})`,
		)
		.first<{ n: number }>();
	const suggestions = (await suggestionQueue(db, switches)).filter(
		(item) => item.kind === "name" || item.kind === "new_category",
	).length;
	return (row?.n ?? 0) + suggestions;
}
