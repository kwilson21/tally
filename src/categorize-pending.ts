// The nightly categorization step (spec §7): merchant rules first, then Jev for the rest. Production
// makes it twice a morning, in two runs of their own (src/index.tsx); the demo makes it once.
import { askJev, JEV_THRESHOLD } from "./ai/categorize";
import { decide } from "./ai/decide";
import { householdTimeZone, todayIn } from "./dates";
import { asksJev, readAiSwitches } from "./db/ai-switches";
import { giveBackJevCalls, reserveJevCalls } from "./db/jev-calls";
import {
	applyMerchantRules,
	markJevFailed,
	pendingForJev,
	saveJevResult,
} from "./db/transactions";
import { type Deadline, pastDeadline } from "./run-budget";

/**
 * How many transactions Jev is asked about in a day (decisions 56 and 68). The demo's reset needs few.
 * Production sorts a new bank's backfill in a day; each answer is saved as it arrives,
 * so a run cut short keeps its work, and the rest wait for the next run. The count is the household's
 * whole day, midnight to midnight in its time zone, shared by the runs right after a sync and the
 * nightly runs (db/jev-calls.ts).
 */
export const jevCallLimit = (env: { DEMO?: string }) =>
	env.DEMO === "false" ? 500 : 40;

/**
 * The most calls one run makes, whatever the day's cap still allows; what's left waits for the next
 * run. D1 allows 1,000 queries in one invocation, and a call costs three of them (the switches read
 * before it and after it, and saving its answer), plus a few for the run's setup: 300 calls is about 900
 * queries. So production's 09:40 run does nothing else, and the sync (09:00) and the names with the first
 * pass (09:20, where 100 names and 200 calls are about the same) are runs of their own.
 */
export const MAX_CALLS_PER_RUN = 300;

/**
 * The most transactions the run right after a sync asks about, newest first among that sync's own.
 * A sync that imports a lot of rows has already spent most of its invocation's 1,000 queries saving
 * them, so this run stays small (50 calls is about 150 queries); the rest wait for the nightly runs.
 */
export const AFTER_SYNC_BATCH = 50;

/** Failures in a row that point at every call (say, a changed API) rather than one transaction. */
const MAX_FAILURES_IN_A_ROW = 3;

type CategorizeEnv = { DB: D1Database; JEV_API_KEY?: string; DEMO?: string };

/** What a run is asked to do, beyond the default of a nightly run. */
export type PassOptions = {
	// The demo's one run may have just applied merchant rules after a sync; without banks (the demo)
	// or when that step failed, this run applies them itself. Production's sorting runs always do.
	rulesApplied?: boolean;
	/**
	 * Ask only about these transaction rows (their ids), and only the ones still unsorted once the
	 * rules have run: what one sync just brought in, or the one transaction a person added a note to.
	 * Everything else waits for the nightly runs, which have no list.
	 */
	onlyIds?: number[];
	/** The run was started by a sync, so it also stops when "sort as they arrive" is turned off. */
	bySync?: boolean;
	/** Ask about at most this many (newest first), fewer than the most a run may; the rest wait. */
	maxCalls?: number;
	/**
	 * Start no new call once this deadline has passed (src/run-budget.ts), so a slow Jev can't use up the
	 * rest of the run. What it didn't ask is given back to the day, and waits for the next run. The syncs'
	 * runs and the re-ask have none.
	 */
	time?: Deadline;
};

/**
 * Merchant rules, then Jev for what they left, honoring the household's saved AI switches (spec
 * §8.6, decision 73), so the nightly runs and a run after a sync agree: with categories and income
 * both off Jev isn't asked at all, with categories off its category and its transfer and
 * reimbursement flags are dropped, and with income off its income answer is. The switches can be
 * saved while a run is going, so each transaction reads them again before it's sent and before its
 * answer is saved; an answer that comes back after both went off is thrown away, and a run started
 * by a sync stops once "sort as they arrive" is off.
 *
 * Every call counts against the household's day (decisions 56, 68 and 79). The run reserves the calls
 * it wants in one step before it starts, gives back what it didn't use when it ends (db/jev-calls.ts),
 * and stops when the household's date changes under it, so nothing after midnight is charged to the
 * day before. One run asks about at most `MAX_CALLS_PER_RUN`, and the one after a sync about at most
 * `AFTER_SYNC_BATCH`, so it stays inside D1's query limit; what's left waits for the next run.
 */
export async function categorizePending(
	env: CategorizeEnv,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
	{
		rulesApplied = false,
		onlyIds,
		bySync = false,
		maxCalls = MAX_CALLS_PER_RUN,
		time,
	}: PassOptions = {},
): Promise<{ asked: number; applied: number }> {
	const done = { asked: 0, applied: 0 };
	if (!env.JEV_API_KEY || onlyIds?.length === 0) return done;

	// Merchant rules are the household's own, so they apply whatever the AI switches say.
	if (!rulesApplied) await applyMerchantRules(env.DB);

	const start = await readAiSwitches(env.DB);
	if (!asksJev(start) || (bySync && !start.sortOnArrival)) return done;

	const { results: categories } = await env.DB.prepare(
		"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order",
	).all<{ id: number; name: string }>();
	// With nothing to offer, Jev could only say "none fit", which would mark every row as looked at.
	if (categories.length === 0) return done;
	// Sent even when only income is on: the one call asks everything together (spec §7), and a row is
	// marked as asked by the category confidence the answer carries (decision 27).
	const names = categories.map((c) => c.name);

	// The household's zone is read once; each call then works out the date from it, with no query.
	const timeZone = await householdTimeZone(env.DB);
	const day = todayIn(timeZone);
	const cap = jevCallLimit(env);
	// The run asks about no more than the query limit allows, and reserves no more than that.
	const waiting = await pendingForJev(env.DB, Math.min(cap, maxCalls), {
		categories: start.categories,
		ids: onlyIds,
	});
	if (waiting.length === 0 || pastDeadline(time)) return done;
	// The day's cap is shared with every other run: take what's wanted and left in one step.
	const granted = await reserveJevCalls(env.DB, day, cap, waiting.length);
	if (granted === 0) return done;

	let failuresInARow = 0;
	try {
		for (const tx of waiting.slice(0, granted)) {
			// Past the household's midnight the calls belong to the next day, which this run didn't reserve.
			if (todayIn(timeZone) !== day) return done;
			// Out of time: the calls not asked are given back below, and the next run asks about them.
			if (pastDeadline(time)) {
				console.log("jev: stopped at the time budget");
				return done;
			}
			// One small read per transaction: someone may have turned a switch off since the last one.
			const before = await readAiSwitches(env.DB);
			if (!asksJev(before) || (bySync && !before.sortOnArrival)) return done;
			// A credit a person reviewed, or an excluded payment that pays a bill, is asked about only for its category.
			if (tx.categoryOnly && !before.categories) continue;
			done.asked += 1;
			const result = await askJev(tx, names, env.JEV_API_KEY, fetchImpl);
			if (!result.ok) {
				// Status and request id only: never the key or anything about the transaction.
				console.error(
					`jev: ${result.status ?? "no response"} ${result.requestId ?? ""}`.trim(),
				);
				// Jev down, rate-limited, or a bad key would fail every call: stop, and retry next night.
				// Anything else is about this one transaction: skip it (it stays pending) and carry on,
				// unless it keeps happening, which means it isn't about one transaction after all.
				if (serviceWide(result.status)) return done;
				// Asked last from now on, so it can't hold up the others.
				await markJevFailed(env.DB, tx.id);
				failuresInARow += 1;
				if (failuresInARow >= MAX_FAILURES_IN_A_ROW) return done;
				continue;
			}
			failuresInARow = 0;
			// Read again, since the request took a while: an answer is used only as the switches stand now.
			const now = await readAiSwitches(env.DB);
			if (!asksJev(now)) return done;
			if (tx.categoryOnly && !now.categories) continue;
			const decision = decide(result.answer, categories, JEV_THRESHOLD, {
				categories: now.categories,
			});
			const written = await saveJevResult(env.DB, tx.id, decision, {
				categoryOnly: tx.categoryOnly,
				switches: { income: now.income },
			});
			if (written && decision.categoryId !== null) done.applied += 1;
		}
	} finally {
		// What was reserved and not asked goes back to the day it came from. Should this fail, or the run
		// be cut off before it gets here, those calls are only lost for the day, never over-spent.
		try {
			await giveBackJevCalls(env.DB, day, granted - done.asked);
		} catch {
			console.error("jev: couldn't give back unused calls");
		}
	}

	console.log(`jev: asked ${done.asked}, applied ${done.applied}`);
	return done;
}

/**
 * A person added a clearer name or a note to a transaction that still needs a category (spec §7,
 * decision 79): ask Jev about it again, right away. Its stored confidence, which means "Jev looked and
 * wasn't sure" (decision 27), would keep it from being asked, so that mark is cleared first; should the
 * call then not happen (Jev down, the day's cap used, the switches off), the transaction is simply
 * asked about at night. A merchant rule is applied first, as in every run: if one matches, its
 * category is used and Jev isn't asked.
 *
 * It runs after the page has answered, in `waitUntil`, so a save never waits for it, and it never
 * fails the save: any failure is logged by its name alone. It honors the same switches and the same
 * daily cap as every other run, but not the sync-only "sort as they arrive" switch.
 */
export async function askAgain(
	env: CategorizeEnv,
	id: number,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
	if (!env.JEV_API_KEY) return;
	try {
		await env.DB.prepare(
			`UPDATE transactions SET category_confidence = NULL
			 WHERE id = ? AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NOT NULL`,
		)
			.bind(id)
			.run();
		// Merchant rules come first, as in every run (spec §7): a rule that matches gives its category,
		// and Jev is asked only if the transaction is still unsorted after it.
		await categorizePending(env, fetchImpl, { onlyIds: [id] });
	} catch (error) {
		console.error(
			`ask again failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/** Failures that would hit every call, not just this transaction's. */
function serviceWide(status: number | null): boolean {
	return (
		status === null ||
		status === 401 ||
		status === 403 ||
		status === 429 ||
		status >= 500
	);
}
