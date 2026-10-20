import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import { runSortInstance } from "../src/sort-instance";
import type { SortParams } from "../src/sort-start";
import { fakeSteps } from "./fake-sort-steps";

/**
 * Swaps the Workflows binding (`env.SORT`) for a recorder, so no real instance runs in a test, and returns the
 * `create` mock: each daytime trigger's one `create`, with its params. The binding is put back after each test.
 *
 * With `sort`, the recorder also sorts the instance's rows in this process, as the instance would (the same loop, with
 * a step runner that just runs each step), before `create` resolves. Tests that check what Jev's answers did then keep
 * their meaning; the global `fetch` is Jev, as it was. Without it, the recorder only records.
 */
export function recordSorting(options: { sort?: boolean } = {}) {
	const real = env.SORT;
	// Instances run one after another, as a waiting group would (the sorting turn lets one group sort at a time).
	let queue: Promise<unknown> = Promise.resolve();
	const create = vi.fn((input: { params: SortParams }) => {
		const run = queue.then(async () => {
			if (options.sort)
				await categorizePending(
					{ DB: env.DB, JEV_API_KEY: "test-key", DEMO: env.DEMO },
					undefined,
					{
						onlyIds: input.params.ids,
						bySync: input.params.bySync,
						rulesApplied: input.params.rulesApplied,
					},
				);
			return { id: "fake" };
		});
		queue = run.catch(() => {});
		return run;
	});
	beforeEach(() => {
		create.mockClear();
		(env as { SORT: unknown }).SORT = { create };
	});
	afterEach(async () => {
		// Let the queued instances finish first, so none of them runs after the real binding is back.
		await queue.catch(() => {});
		(env as { SORT: unknown }).SORT = real;
	});
	return create;
}

/**
 * The night's instances run in this process, as the Workflow runs them: `create` runs `runSortInstance`
 * (src/sort-instance.ts) over a fake step runner, and resolves once that instance is done, so a test reads what it did
 * as soon as the trigger returns. `runs` holds each instance's fake steps (names, configs, attempts). `instanceEnv` is
 * the env the Workflow would get, so its DB, Workers AI fake and DEMO reach the instance; `options` give Jev's fetch
 * and the instance's clock. Use it as `runScheduled({ ...env, SORT: night.SORT }, ...)`.
 */
export function sortInProcess(
	instanceEnv: Parameters<typeof runSortInstance>[0],
	options: {
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
	} = {},
) {
	const runs: ReturnType<typeof fakeSteps>[] = [];
	const create = vi.fn(async ({ params }: { params: SortParams }) => {
		const steps = fakeSteps();
		runs.push(steps);
		await runSortInstance(instanceEnv, steps.runStep, params, {
			runId: crypto.randomUUID(),
			...options,
		});
		return { id: "fake" };
	});
	return { SORT: { create } as unknown as Env["SORT"], create, runs };
}
