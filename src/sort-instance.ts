// What one sorting instance does (spec §7, §8.6, decision 139): it sorts its rows in groups of 25 (sort-groups.ts), and the
// night's instance then makes the night's notes and names, then new-category suggestions, then, in production, keeps the
// first night's counts. Each is a step of its own; one that fails is logged by its error's name and the next still runs.
// SortWorkflow (sort-workflow.ts) runs it with Workflows' steps; the tests run it with a fake step runner.

import {
	categoryCallLimit,
	suggestNewCategories,
} from "./category-suggestions-pending";
import { keepNightCounts } from "./first-tally/night";
import { runTimeBudgetMs } from "./run-budget";
import {
	type SortEnv,
	type StepConfig,
	type StepRunner,
	sortGroups,
} from "./sort-groups";
import type { SortParams } from "./sort-start";
import { suggestNightlyNames } from "./suggest-names-pending";

type InstanceEnv = SortEnv & { AI?: Ai };

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
	},
): Promise<void> {
	try {
		await sortGroups(env, runStep, options.fetchImpl, {
			rulesApplied: params.rulesApplied,
			onlyIds: params.ids,
			bySync: params.bySync,
			runId: options.runId,
			waitForTurn: true,
		});
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
