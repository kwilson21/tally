import { describe, expect, it } from "vitest";
import { actor } from "../src/actor";

describe("actor", () => {
	it("records 'demo' in the demo (spec §5)", () => {
		expect(actor({ env: { DEMO: "true" }, get: () => undefined })).toBe("demo");
	});

	it("uses the identity established by the Access middleware", () => {
		expect(
			actor({ env: { DEMO: "false" }, get: () => "family@example.com" }),
		).toBe("family@example.com");
	});

	it("refuses to guess outside the demo", () => {
		expect(() =>
			actor({ env: { DEMO: "false" }, get: () => undefined }),
		).toThrow(/verified Cloudflare Access identity/);
	});
});
