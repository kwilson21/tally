// The in-process sorting run (spec §7): merchant rules first, then Jev for what they left, in the same groups of
// 25 as the Workflow (src/sort-groups.ts, decision 139). The nightly runs (09:20, 09:40) and the tests call it;
// every daytime trigger starts a Workflow instance instead (startSorting, src/sort-workflow.ts).
import { readAiSwitches } from "./db/ai-switches";
import type { Deadline } from "./run-budget";
import { type SortEnv, type StepRunner, sortGroups } from "./sort-groups";
import { startSorting } from "./sort-start";

/**
 * The most calls one nightly run makes, whatever the day's cap still allows; what's left waits for the next run. D1
 * allows 1,000 queries in one invocation, and a call costs three of them (the switches read before it, and the answer
 * saved with its log row in one batch), plus a few for setup and one merchant-history read: 300 calls is about 901
 * queries. So production's 09:40 run does nothing else, and the sync (09:00) and the names with the first pass (09:20,
 * where 100 names and 200 calls are about the same) are runs of their own.
 */
export const MAX_CALLS_PER_RUN = 300;

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
	 * rest of the run. What it didn't ask is given back to the day, and waits for the next run.
	 */
	time?: Deadline;
};

/**
 * Merchant rules, then Jev for what they leave, honoring the household's saved AI switches (spec §8.6,
 * decision 73). The sorting groups run here, in this process: each step simply runs (sortGroups), and the
 * groups keep the rules of decision 139 (the switches read once a group and checked by its save, one group
 * at a time through the sorting turn, every answer saved in one batch or none). Every call counts against the
 * household's day (decisions 56, 68 and 79), and the run stops when the household's date changes under it.
 */
export async function categorizePending(
	env: SortEnv,
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
	{
		rulesApplied = false,
		onlyIds,
		bySync = false,
		maxCalls = MAX_CALLS_PER_RUN,
		time,
	}: PassOptions = {},
): Promise<{ asked: number; applied: number }> {
	const done = await sortGroups(env, inProcess, fetchImpl, {
		rulesApplied,
		onlyIds,
		bySync,
		maxCalls,
		time,
		runId: crypto.randomUUID(),
	});
	if (done.asked > 0)
		console.log(`jev: asked ${done.asked}, applied ${done.applied}`);
	return done;
}

/** The step runner in-process: a step just runs, since nothing retries it here. */
const inProcess: StepRunner = (_name, _config, fn) => fn({ attempt: 1 });

type CategorizeEnv = SortEnv & { SORT: Env["SORT"] };

/**
 * A person added a clearer name or a note to a transaction that still needs a category (spec §7,
 * decision 79), or unticked a suggested category: ask Jev about it again, right away, as a sorting instance of its
 * own. Its stored confidence, which means "Jev looked and wasn't sure" (decision 27), would keep it from being
 * asked, so that mark is cleared first (askAgainMany). It never fails the save: any failure is logged by its name.
 * As before, it ignores the sync-only "sort as they arrive" switch, and honors the others.
 */
export async function askAgain(env: CategorizeEnv, id: number): Promise<void> {
	return askAgainMany(env, [id]);
}

/**
 * Clears the left-out marks of these rows, then starts one sorting instance with all of them (no cap). The instance
 * applies merchant rules first, as every run does.
 */
export async function askAgainMany(
	env: CategorizeEnv,
	ids: number[],
): Promise<void> {
	if (!env.JEV_API_KEY || !ids.length) return;
	try {
		await env.DB.prepare(
			`UPDATE transactions SET category_confidence = NULL, jev_mixed = NULL, jev_also_category_id = NULL
			 WHERE id IN (SELECT value FROM json_each(?)) AND category_id IS NULL AND category_source IS NULL AND category_confidence IS NOT NULL`,
		)
			.bind(JSON.stringify(ids))
			.run();
		await startSorting(env, { ids, bySync: false, rulesApplied: false });
	} catch (error) {
		console.error(
			`ask again failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/**
 * Asks Jev again about the transactions a create left out (decision 79), right after the page has answered, so
 * the save never waits for it. Nothing is asked without a Jev key or while Guess categories is off; then they wait
 * for the night. `waitUntil` is the request's, passed in so a request that asks nothing never reads it.
 */
export async function askAgainLeftOut(
	env: CategorizeEnv,
	ids: number[],
	waitUntil: (work: Promise<void>) => void,
): Promise<void> {
	if (!ids.length || !env.JEV_API_KEY) return;
	if (!(await readAiSwitches(env.DB)).categories) return;
	// waitUntil starts a promise at once; yield this turn so the page can answer first.
	waitUntil(
		new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
			askAgainMany(env, ids),
		),
	);
}

/** "The 2 you left out go back to Tally to sort again.", or nothing when none were left out. */
export function leftOutSentence(count: number): string {
	return count
		? `The ${count} you left out ${count === 1 ? "goes" : "go"} back to Tally to sort again.`
		: "";
}
