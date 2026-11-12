// The Workers runtime's `cloudflare:workers` module, for the Node-only feedback checks (vitest.feedback.config.ts).
// The app's entry module exports the Workflow class (src/sort-workflow.ts), which extends this base class; these
// checks never run a Workflow, so only the class has to exist.
/** The members of the runtime's ExecutionContext that a Workflow reaches for; nothing here calls them. */
type ExecutionContext = {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
};

export class WorkflowEntrypoint<Env = unknown> {
	ctx: ExecutionContext;
	env: Env;
	constructor(ctx: ExecutionContext, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}
