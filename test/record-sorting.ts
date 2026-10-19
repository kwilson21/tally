import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import type { SortParams } from "../src/sort-start";

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
						// An instance has no per-run cap: only the day's.
						maxCalls: Number.POSITIVE_INFINITY,
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
	afterEach(() => {
		(env as { SORT: unknown }).SORT = real;
	});
	return create;
}
