import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("security headers", () => {
	it("denies framing and restricts scripts to our origin", async () => {
		const res = await exports.default.fetch("http://tally.test/");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
	});
});
