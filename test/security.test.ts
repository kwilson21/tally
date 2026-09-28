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

const cspFor = async (path: string) => {
	const response = await exports.default.fetch(`http://tally.test${path}`);
	return response.headers.get("content-security-policy") ?? "";
};

describe("Plaid Content Security Policy", () => {
	it("allows Plaid's documented hosts on Accounts only", async () => {
		const accounts = await cspFor("/accounts");
		expect(accounts).toContain("script-src 'self' https://cdn.plaid.com");
		expect(accounts).toContain("frame-src https://cdn.plaid.com");
		expect(accounts).toContain("connect-src 'self' https://*.plaid.com");

		for (const path of ["/", "/transactions", "/settings"]) {
			expect(await cspFor(path)).not.toContain("plaid.com");
		}
	});
});
