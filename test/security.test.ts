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

	it("keeps the home page's complete policy unchanged", async () => {
		expect(await cspFor("/")).toBe(
			"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
		);
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
		expect(accounts).toContain("frame-src 'self' https://cdn.plaid.com");
		expect(accounts).toContain(
			"connect-src 'self' https://production.plaid.com",
		);

		for (const path of ["/", "/transactions", "/settings"]) {
			expect(await cspFor(path)).not.toContain("plaid.com");
		}
	});
});
