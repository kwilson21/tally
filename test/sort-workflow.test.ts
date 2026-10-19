import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The real SortWorkflow class, run by the Workflows binding from wrangler.jsonc (the step behaviour is in
// sort-groups.test.ts). The test worker has no Jev key, so the instance has nothing to sort and ends at once.
describe("SortWorkflow", () => {
	it("runs as a Workflow instance to completion, with its retry delays disabled", async () => {
		const introspector = await introspectWorkflow(env.SORT);
		try {
			await introspector.modifyAll(async (m) => {
				await m.disableRetryDelays();
			});
			const instance = await env.SORT.create({
				params: { ids: [1], bySync: false, rulesApplied: false },
			});
			let status = await instance.status();
			for (
				let i = 0;
				i < 100 && status.status !== "complete" && status.status !== "errored";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await instance.status();
			}
			expect(status.status).toBe("complete");
		} finally {
			await introspector.dispose();
		}
	});
});
