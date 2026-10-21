// What one sorting instance does (spec §7, §8.6, decision 139): it sorts its rows in groups of 25 (sort-groups.ts), and the
// night's instance then makes the night's notes and names, then new-category suggestions, then, in production, keeps the
// first night's counts. Each is a step of its own; one that fails is logged by its error's name and the next still runs.
// SortWorkflow (sort-workflow.ts) runs it with Workflows' steps, and waits out a busy Jev with step.sleep (decision 145);
// the tests run it with a fake step runner.

import {
	categoryCallLimit,
	suggestNewCategories,
} from "./category-suggestions-pending";
import { keepNightCounts } from "./first-tally/night";
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

const NIGHT_STEPS = {
	// Workers AI steps never retry, so no request is made twice. Each starts no request after 13 minutes from its own
	// start (src/run-budget.ts), so it ends inside its 15-minute timeout.
	ai: {
		retries: { limit: 0, delay: 0 },
		timeout: "15 minutes",
		sensitive: "output",
	},
	// D1 only, so a failed save may run again.
	counts: {
		retries: { limit: 4, delay: "10 seconds", backoff: "constant" },
		timeout: "1 minute",
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
		runId: options.runId,
		waitForTurn: true,
		maxCalls: INSTANCE_MAX_CALLS,
		sleep: options.sleep,
	};
}

/**
 * Runs one sorting instance's steps through `runStep` (see StepRunner). The sort is the same as ever. With `params.night`
 * (the 09:00 run's instance), the night's names, new-category suggestions and, in production, first-night counts follow.
 */
export async function runSortInstance(
	env: InstanceEnv,
	runStep: StepRunner,
	params: SortParams,
	options: {
		runId: string;
		/** Jev's fetch; the Workflow passes none (the global fetch). */
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		/** The clock the Workers AI steps' deadlines read, inside their steps; the Workflow passes none (Date.now). */
		now?: () => number;
		/** The wait before a busy Jev is asked again (decision 145): the Workflow's step.sleep; the tests pass a fake. */
		sleep?: (name: string, ms: number) => Promise<void>;
	},
): Promise<void> {
	try {
		await sortGroups(
			env,
			runStep,
			options.fetchImpl,
			instanceSortOptions(params, options),
		);
	} catch (error) {
		// A step that ran out of retries ends the sort quietly; the rows it didn't save wait for the next sort.
		console.error(
			`sorting: stopped ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
	const night = params.night;
	if (!night) return;

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

	// Production only: the demo has no banks, so it has no first night to count.
	if (env.DEMO === "false") {
		try {
			await runStep("night-counts", NIGHT_STEPS.counts, async () => {
				await keepNightCounts(env.DB, env, night);
				return true;
			});
		} catch (error) {
			console.error(
				`first night: counts step failed ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}
}
