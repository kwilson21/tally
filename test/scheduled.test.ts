import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The Workers runtime supports scheduled() on the Worker's own export, but the
// generated Fetcher type only declares fetch() and connect().
const worker = exports.default as unknown as {
	scheduled(options: { cron?: string }): Promise<unknown>;
};

const count = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{
			n: number;
		}>()
	)?.n ?? 0;

describe("scheduled handler", () => {
	it("restores the demo seed through the Worker entry point when the guard allows it", async () => {
		await env.DB.prepare("DELETE FROM transactions").run();
		expect(await count()).toBe(0);

		await worker.scheduled({ cron: "0 8 * * *" });

		expect(await count()).toBeGreaterThan(0);
	});
});
