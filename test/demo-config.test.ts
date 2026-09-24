import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

// Every comment in wrangler.jsonc is on its own line, so dropping those lines leaves plain JSON.
const config = JSON.parse(
	raw
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n"),
);
const demo = config.env.demo;

describe("demo environment config", () => {
	it("runs as the demo", () => {
		expect(demo.vars).toEqual({ DEMO: "true" });
	});

	it("never mentions Plaid, so it can't hold Plaid settings", () => {
		expect(JSON.stringify(demo)).not.toMatch(/plaid/i);
	});

	it("binds only the demo database", () => {
		expect(demo.d1_databases).toHaveLength(1);
		expect(demo.d1_databases[0]).toMatchObject({
			binding: "DB",
			database_name: "tally-demo",
		});
	});

	it("is served only at its custom domain", () => {
		expect(demo.routes).toEqual([
			{ pattern: "tally-demo.thesuperhuman.us", custom_domain: true },
		]);
		expect(demo.workers_dev).toBe(false);
		expect(demo.preview_urls).toBe(false);
	});

	it("resets nightly at 09:00 UTC", () => {
		expect(demo.triggers).toEqual({ crons: ["0 9 * * *"] });
	});

	it("keeps crons out of local dev and other environments", () => {
		expect(config.triggers).toBeUndefined();
	});
});
