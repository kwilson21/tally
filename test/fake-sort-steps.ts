import type { StepConfig, StepRunner } from "../src/sort-groups";

export type RecordedStep = {
	name: string;
	config: StepConfig;
	attempts: number;
	cached: boolean;
};

/**
 * A stand-in for Workflows' `step.do` (src/sort-workflow.ts), for `sortGroups` in tests. It records every step's
 * name and config, passes the attempt number to the callback, and returns a finished step's cached result for its
 * name, as Workflows does ("step names act as the cache key"). A step named in `throws` fails that many attempts
 * and is retried up to its config's `retries.limit`. `beforeAttempt` runs before each attempt, so a test can change
 * the database between attempts.
 */
export function fakeSteps(
	options: {
		throws?: Record<string, number>;
		beforeAttempt?: (name: string, attempt: number) => Promise<void>;
		/** Steps whose callback runs once more after it succeeded, as when Workflows loses the result of a committed step. */
		replayAfter?: string[];
	} = {},
) {
	const cache = new Map<string, unknown>();
	const steps: RecordedStep[] = [];
	const runStep: StepRunner = async (name, config, fn) => {
		if (cache.has(name)) {
			steps.push({ name, config, attempts: 0, cached: true });
			return cache.get(name) as never;
		}
		const record: RecordedStep = { name, config, attempts: 0, cached: false };
		steps.push(record);
		// A step that throws is retried up to its limit, and at least as often as it was made to throw (a re-run after a
		// crash, which Workflows does even for a step with no retries).
		const limit = Math.max(
			config.retries?.limit ?? 5,
			options.throws?.[name] ?? 0,
		);
		for (let attempt = 1; ; attempt++) {
			record.attempts = attempt;
			try {
				await options.beforeAttempt?.(name, attempt);
				if ((options.throws?.[name] ?? 0) >= attempt)
					throw new Error(`fake failure in ${name}`);
				const result = await fn({ attempt });
				cache.set(name, result);
				if (options.replayAfter?.includes(name))
					await fn({ attempt: attempt + 1 });
				return result as never;
			} catch (error) {
				if (attempt > limit) throw error;
			}
		}
	};
	return { runStep, steps, names: () => steps.map((step) => step.name) };
}
