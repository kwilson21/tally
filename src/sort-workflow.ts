// Sorting as a Cloudflare Workflow (spec §8.6, decision 139). Every daytime trigger stops sorting inside its request
// and starts one instance with all its rows (`startSorting`, sort-start.ts); the instance runs the sorting groups
// (sort-groups.ts) as saved steps, so a retry skips the steps that finished and Jev's answers are kept for a few days
// (sensitive steps, so Cloudflare's dashboard and logs never show them).
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { type StepRunner, sortGroups } from "./sort-groups";
import type { SortParams } from "./sort-start";

export class SortWorkflow extends WorkflowEntrypoint<Env, SortParams> {
	async run(
		event: Readonly<WorkflowEvent<SortParams>>,
		step: WorkflowStep,
	): Promise<null> {
		// Each step's result is checked against Workflows' serializable type (StepRunner), so a non-serializable one fails
		// the typecheck here rather than at runtime.
		const runStep: StepRunner = (name, config, fn) => step.do(name, config, fn);
		try {
			await sortGroups(this.env, runStep, undefined, {
				rulesApplied: event.payload.rulesApplied,
				onlyIds: event.payload.ids,
				bySync: event.payload.bySync,
				runId: event.instanceId,
				waitForTurn: true,
			});
		} catch (error) {
			// A step that ran out of retries ends the instance quietly; the rows it didn't save wait for the next sort.
			console.error(
				`sorting: stopped ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
		return null;
	}
}
