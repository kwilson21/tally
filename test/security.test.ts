import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import decisions from "../docs/decisions.md?raw";
import spec from "../docs/superpowers/specs/2026-09-22-tally-design.md?raw";

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
	beforeEach(() =>
		Object.assign(env, {
			DEMO: "false",
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		}),
	);
	afterEach(() =>
		Object.assign(env, {
			DEMO: "true",
			PLAID_CLIENT_ID: undefined,
			PLAID_SECRET: undefined,
			TOKEN_ENCRYPTION_KEY: undefined,
		}),
	);

	it("allows Plaid's documented hosts on Accounts, and on setup in the family app; Home and the demo keep 'self'", async () => {
		const accounts = await cspFor("/accounts");
		expect(accounts).toContain(
			"script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js",
		);
		expect(accounts).toContain("frame-src 'self' https://cdn.plaid.com");
		expect(accounts).toContain(
			"connect-src 'self' https://production.plaid.com",
		);

		// The disconnect page swaps Accounts in, so Link a bank must still load there.
		expect(await cspFor("/accounts/1/disconnect")).toContain(
			"script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js",
		);

		for (const path of ["/", "/transactions", "/settings", "/accountsx"]) {
			expect(await cspFor(path)).not.toContain("plaid.com");
		}
		Object.assign(env, { DEMO: "true" });
		expect(await cspFor("/accounts")).not.toContain("plaid.com");
	});

	it("allows inline styles on Accounts, and on setup in the family app; Home and the demo keep 'self'", async () => {
		expect(await cspFor("/accounts")).toContain(
			"style-src 'self' 'unsafe-inline'",
		);
		expect(await cspFor("/accounts/1/disconnect")).toContain(
			"style-src 'self' 'unsafe-inline'",
		);
		for (const path of ["/", "/transactions", "/settings", "/accountsx"]) {
			expect(await cspFor(path)).not.toContain("unsafe-inline");
		}
	});
});

describe("setup in the family app", () => {
	beforeEach(() =>
		Object.assign(env, {
			DEMO: "false",
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		}),
	);
	afterEach(() =>
		Object.assign(env, {
			DEMO: "true",
			PLAID_CLIENT_ID: undefined,
			PLAID_SECRET: undefined,
			TOKEN_ENCRYPTION_KEY: undefined,
		}),
	);

	it("allows Plaid Link's hosts and inline styles, as Accounts does", async () => {
		// No Access JWT, so the page is refused; the headers are still set on that refusal.
		const csp = await cspFor("/setup");
		expect(csp).toContain(
			"script-src 'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js",
		);
		expect(csp).toContain("frame-src 'self' https://cdn.plaid.com");
		expect(csp).toContain("connect-src 'self' https://production.plaid.com");
		expect(csp).toContain("style-src 'self' 'unsafe-inline'");
	});

	it("keeps Plaid off Home, which has no Link a bank any more, and off the family app's other pages", async () => {
		for (const path of ["/", "/transactions", "/settings"]) {
			const csp = await cspFor(path);
			expect(csp).not.toContain("plaid.com");
			expect(csp).not.toContain("unsafe-inline");
		}
	});
});

describe("decision and spec records for the Home Plaid allowances", () => {
	const decisionRows = () =>
		decisions.split("\n").filter((line) => /^\| \d+ \|/.test(line));

	it("numbers each decision row once, in ascending order", () => {
		const numbers = decisionRows().map((line) => Number(line.split("|")[1]));
		expect(numbers.length).toBeGreaterThan(100);
		expect(new Set(numbers).size).toBe(numbers.length);
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
	});

	it("records the Home Plaid allowances as decision 124, with inline styles and decision 63", () => {
		const row = decisionRows().find((line) => line.startsWith("| 124 |")) ?? "";
		expect(row.startsWith("| 124 | 2026-10-16 | Home in the family app")).toBe(
			true,
		);
		expect(row).toContain("'unsafe-inline'");
		expect(row).toContain("decision 63");
	});

	it("cites decisions 63 and 124 in the spec's Security headers row for Plaid Link's inline styles", () => {
		const row =
			spec
				.split("\n")
				.find((line) => line.startsWith("| Security headers |")) ?? "";
		expect(row).toContain("decisions 63 and 124");
		expect(row).toContain("Plaid Link's inline styles");
		expect(row).not.toContain("decisions 63 and 123");
	});
});
