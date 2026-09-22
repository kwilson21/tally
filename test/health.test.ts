import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /healthz", () => {
	it("returns ok as JSON", async () => {
		const response = await exports.default.fetch("http://tally.test/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
