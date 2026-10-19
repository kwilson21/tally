// The Workers runtime's `cloudflare:workers` module, for the Node-only feedback checks (vitest.feedback.config.ts).
// The app's entry module exports the Workflow class (src/sort-workflow.ts), which extends this base class; these
// checks never run a Workflow, so only the class has to exist.
export class WorkflowEntrypoint<Env = unknown> {
	ctx: unknown;
	env: Env;
	constructor(ctx: unknown, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
