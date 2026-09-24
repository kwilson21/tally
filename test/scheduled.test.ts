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

	it("leaves Jev out when there is no key, so the seed's 12 stay uncategorized", async () => {
		await worker.scheduled({ cron: "0 9 * * *" });

		const untouched = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL AND flag_income = 0 AND excluded = 0",
		).first<{ n: number }>();
		expect(untouched?.n).toBeGreaterThanOrEqual(12);
	});
});
