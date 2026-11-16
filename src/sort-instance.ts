// What one sorting instance does (spec §7, §8.6, decision 139): it sorts its rows in groups of 25 (sort-groups.ts), and the
// night's instance then clears the daily run's wait mark, makes the night's notes and names, then new-category suggestions.
// Each is a step of its own; one that fails is logged by its error's name and the next still runs.
// SortWorkflow (sort-workflow.ts) runs it with Workflows' steps, and waits out a busy Jev with step.sleep (decision 145);
// the tests run it with a fake step runner.

import {
	categoryCallLimit,
	suggestNewCategories,
} from "./category-suggestions-pending";
import { readAiSwitches } from "./db/ai-switches";
import { clearWaitsForRunStatement } from "./db/first-tally";
import { finishRun } from "./db/resort-run";
import { waitingForJevSql } from "./db/transactions";
import { lookupAsks, lookupEnvOpen } from "./lookup/gate";
import { runPrivacyReask } from "./lookup/privacy-reask";
import { runStoreLookup } from "./lookup/run";
import { runSecondAsk } from "./lookup/second-ask";
import { fillLookupTexts } from "./lookup/texts";
import { runTimeBudgetMs } from "./run-budget";
import {
	type SortEnv,
	type SortOptions,
	type StepConfig,
	type StepRunner,
	sortGroups,
} from "./sort-groups";
import type { SortParams } from "./sort-start";
import { suggestNightlyNames } from "./suggest-names-pending";

type InstanceEnv = SortEnv & { AI?: Ai };

/**
 * The most Jev asks one sorting instance makes (decision 146). Each ask is a step, and each group of 25 adds three, so this
 * stays under Workflows' 10,000 steps an instance on Workers Paid. What is left waits for the next sync or the night.
 */
export const INSTANCE_MAX_CALLS = 5000;

// A step that only writes D1 may run again after a failed save: the re-ask's finish (finishRun is idempotent), the night's
// wait mark, and the lookup texts (whose fill never throws out of its step, see lookupTextsStep).
const D1_STEP = {
	retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
	timeout: "1 minute",
	sensitive: "output",
} satisfies StepConfig;

const NIGHT_STEPS = {
	// Workers AI steps never retry, so no request is made twice. Each starts no request after 13 minutes from its own
	// start (src/run-budget.ts), so it ends inside its 15-minute timeout.
	ai: {
		retries: { limit: 0, delay: 0 },
		timeout: "15 minutes",
		sensitive: "output",
	},
} satisfies Record<string, StepConfig>;

/**
 * The options an instance's sort runs with (decision 146): the rows the params name, and the most Jev asks the instance makes,
 * INSTANCE_MAX_CALLS. Every instance's sort gets its options here, so the cap is set in one place.
 */
export function instanceSortOptions(
	params: SortParams,
	options: {
		runId: string;
		/** The wait before a busy Jev is asked again (decision 145). */
		sleep?: (name: string, ms: number) => Promise<void>;
	},
): SortOptions {
	return {
		rulesApplied: params.rulesApplied,
		onlyIds: params.ids,
		bySync: params.bySync,
		reask: params.reask,
		runId: options.runId,
		waitForTurn: true,
		maxCalls: INSTANCE_MAX_CALLS,
		sleep: options.sleep,
	};
}

/**
 * The store lookup's privacy marks (spec §7), as one step: the fill reads once and saves once. It never throws out of its
 * step, so a failure is logged and the step returns, and a replay does not retry it.
 */
async function lookupTextsStep(
	env: InstanceEnv,
	runStep: StepRunner,
	name: string,
): Promise<void> {
	try {
		await runStep(name, D1_STEP, async () => {
			const switches = await readAiSwitches(env.DB);

			if (!lookupAsks(env, switches))
				return { keys: 0, private: 0, failed: false };

			try {
				return { ...(await fillLookupTexts(env.DB)), failed: false };
			} catch (error) {
				// Logged by name only: no key or bank text reaches the log. Returning, not throwing, keeps a replay from retrying it.
				console.error(
					`lookup texts: stopped ${error instanceof Error ? error.name : "unknown"}`,
				);

				return { keys: 0, private: 0, failed: true };
			}
		});
	} catch (error) {
		console.error(
			`lookup texts: step failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

/**
 * Runs one sorting instance's steps through `runStep` (see StepRunner). The sort is the same as ever. With `params.night`
 * (the 09:00 run's instance), the daily run's wait mark is cleared in production, and the night's names and new-category
 * suggestions follow.
 */
export async function runSortInstance(
	env: InstanceEnv,
	runStep: StepRunner,
	params: SortParams,
	options: {
		runId: string;
		/** Jev's fetch; the Workflow passes none (the global fetch). */
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		/** Tavily's fetch for the store lookup; the Workflow passes none (the global fetch). */
		searchFetch?: typeof fetch;
		/** The clock the Workers AI steps' deadlines read, inside their steps; the Workflow passes none (Date.now). */
		now?: () => number;
		/** The wait before a busy Jev is asked again (decision 145): the Workflow's step.sleep; the tests pass a fake. */
		sleep?: (name: string, ms: number) => Promise<void>;
	},
): Promise<void> {
	// The store lookup's privacy marks (spec §7), first, so the groups and the rules read them. Registered only while the
	// gate's environment half is open (a Tavily key and a cap above 0), so with the gate closed the step list is as before.
	if (lookupEnvOpen(env)) await lookupTextsStep(env, runStep, "lookup-texts");

	// The privacy re-ask runs only after the groups finished without a busy Jev or a failed group (#1113).
	let sorted = false;

	try {
		const done = await sortGroups(
			env,
			runStep,
			options.fetchImpl,
			instanceSortOptions(params, options),
		);

		sorted = !done.jevBusy && !done.failed;
	} catch (error) {
		// A step that ran out of retries ends the sort quietly; the rows it didn't save wait for the next sort.
		console.error(
			`sorting: stopped ${error instanceof Error ? error.name : "unknown"}`,
		);
	}

	// A re-sort's re-ask finishes its run once its groups are done, even when some rows were never asked (decision 160).
	const reask = params.reask;

	if (reask) {
		try {
			await runStep("reask-finish", D1_STEP, async () => {
				await finishRun(env.DB, {
					runId: reask.runId,
					now: Date.now(),
					instanceKey: options.runId,
				});

				return true;
			});
		} catch (error) {
			console.error(
				`reask: finish step ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}

	// The privacy re-ask (#1113): a failure is logged by its error's name, and the night's steps still run.
	if (sorted && lookupEnvOpen(env) && env.JEV_API_KEY) {
		try {
			await runPrivacyReask(env, runStep, {
				runId: options.runId,
				bySync: params.bySync,
				fetchImpl: options.fetchImpl,
			});
		} catch (error) {
			console.error(
				`privacy re-ask: stopped ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}

	// The store lookup (spec §7): after the re-ask, and only when the groups finished, as the re-ask does. Its privacy marks
	// are one step of their own; the run's failure is logged by its error's name, and the night's steps still run.
	if (sorted && lookupEnvOpen(env) && env.AI && env.TAVILY_API_KEY) {
		await lookupTextsStep(env, runStep, "lookup-run-texts");

		try {
			await runStoreLookup(
				{ ...env, AI: env.AI, TAVILY_API_KEY: env.TAVILY_API_KEY },
				runStep,
				{
					runId: options.runId,
					bySync: params.bySync,
					searchFetch: options.searchFetch,
				},
			);
		} catch (error) {
			console.error(
				`store lookup: stopped ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}

	// The second ask (decision 225): after the store lookup, so a store found in this run is asked about in the same run, and,
	// as the privacy re-ask, only when the groups finished. A failure is logged by its error's name; the night's steps still run.
	if (sorted && lookupEnvOpen(env) && env.JEV_API_KEY) {
		try {
			await runSecondAsk(env, runStep, {
				runId: options.runId,
				bySync: params.bySync,
				fetchImpl: options.fetchImpl,
			});
		} catch (error) {
			console.error(
				`second ask: stopped ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}

	if (!params.night) return;

	// Production only: the demo has no banks, so it has no import waiting for the daily run. Once nothing waits for Jev, the
	// daily run's mark goes (decision 150), so setup's reading screen stops saying the import waits for the run.
	if (env.DEMO === "false") {
		try {
			await runStep("night-run-wait", D1_STEP, async () => {
				const switches = await readAiSwitches(env.DB);
				await clearWaitsForRunStatement(
					env.DB,
					waitingForJevSql(switches),
				).run();

				return true;
			});
		} catch (error) {
			console.error(
				`night: wait mark step failed ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}

	try {
		await runStep("night-names", NIGHT_STEPS.ai, async ({ attempt }) => {
			if (attempt > 1) return false;
			const now = options.now ?? Date.now;
			await suggestNightlyNames(env, {
				deadline: now() + runTimeBudgetMs,
				now,
			});

			return true;
		});
	} catch (error) {
		console.error(
			`workers-ai: names step failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}

	try {
		await runStep("night-suggestions", NIGHT_STEPS.ai, async ({ attempt }) => {
			if (attempt > 1) return false;
			const now = options.now ?? Date.now;
			await suggestNewCategories(env, categoryCallLimit, {
				deadline: now() + runTimeBudgetMs,
				now,
			});

			return true;
		});
	} catch (error) {
		console.error(
			`workers-ai: category suggestions step failed ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}
