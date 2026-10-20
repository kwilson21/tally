// Sorting as a Cloudflare Workflow (spec §8.6, decision 139). Every trigger stops sorting inside its request and starts
// one instance with its rows (`startSorting`, sort-start.ts); the instance runs the sorting groups (sort-groups.ts) as
// saved steps, so a retry skips the steps that finished and Jev's answers are kept for a few days (sensitive steps, so
// Cloudflare's dashboard and logs never show them). The 09:00 run's instance (with `night`) also makes the night's names
// and suggestions and keeps the first night's counts (sort-instance.ts).
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import type { StepRunner } from "./sort-groups";
import { runSortInstance } from "./sort-instance";
import type { SortParams } from "./sort-start";

export class SortWorkflow extends WorkflowEntrypoint<Env, SortParams> {
	async run(
		event: Readonly<WorkflowEvent<SortParams>>,
		step: WorkflowStep,
	): Promise<null> {
		// Each step's result is checked against Workflows' serializable type (StepRunner), so a non-serializable one fails
		// the typecheck here rather than at runtime.
		const runStep: StepRunner = (name, config, fn) => step.do(name, config, fn);
		await runSortInstance(this.env, runStep, event.payload, {
			runId: event.instanceId,
		});
		return null;
	}
}
