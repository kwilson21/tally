import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";

const BASE = "http://tally.test";

/** The words an error message might carry: none of them may ever reach the page or the log. */
const SECRET = "access-sandbox-9f3a Whole Foods $42.17";

/** A database that fails on first use, the way a real outage or a bad query would. */
const brokenWorker = () => {
	const DB = new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare" || prop === "batch") {
				return () => {
					throw new Error(SECRET);
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { ...env, DB } as Env;
};

const fail = (path: string, headers: Record<string, string> = {}) =>
	app.request(`${BASE}${path}`, { headers }, brokenWorker());

const text = async (res: Response) => res.text();

afterEach(() => vi.restoreAllMocks());

describe("the 404 page (app.notFound)", () => {
	it("is a page inside the app's shell with the status 404", async () => {
		const res = await exports.default.fetch(`${BASE}/no-such-page`);
		const html = await res.text();
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Page not found · Tally</title>");
		// The navigation and the main region are there, so nobody is stuck.
		expect(html).toContain('aria-label="Main"');
		expect(html).toContain('id="main"');
	});

	it("shows the large ledger drawing, a serif 404, one sentence and the way home", async () => {
		const html = await (
			await exports.default.fetch(`${BASE}/no-such-page`)
		).text();
		expect(html).toContain("[&amp;&gt;svg]:size-44");
		expect(html).toContain('stroke-width="1.75"');
		expect(html).toMatch(
			/<h1 class="[^"]*font-serif[^"]*"><span class="sr-only">Error <\/span>404<\/h1>/,
		);
		expect(html).toContain("This page isn&#39;t here.");
		expect(html).toMatch(/<a href="\/"[^>]*>Go to Home<\/a>/);
		// Only the 500 page offers Try again.
		expect(html).not.toContain("Try again");
	});

	it("is the same page for a missing record that a route reports with c.notFound()", async () => {
		const res = await exports.default.fetch(`${BASE}/budget/999999`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("This page isn&#39;t here.");
	});

	it("gives an htmx request one plain sentence, not a page inside a page", async () => {
		const res = await exports.default.fetch(`${BASE}/no-such-page`, {
			headers: { "HX-Request": "true" },
		});
		const body = await res.text();
		expect(res.status).toBe(404);
		expect(body).not.toContain("<html");
		expect(body).not.toContain("<svg");
		expect(body).toMatch(/<p role="alert">This page isn&#39;t here\.<\/p>/);
	});
});

describe("the 500 page (app.onError)", () => {
	it("is a page inside the app's shell with the status 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await fail("/");
		const html = await text(res);
		expect(res.status).toBe(500);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Something went wrong · Tally</title>");
		expect(html).toContain('aria-label="Main"');
	});

	it("shows the large ledger drawing, a serif 500, its sentence, Try again and Go to Home", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const html = await text(await fail("/"));
		expect(html).toContain("[&amp;&gt;svg]:size-44");
		expect(html).toMatch(
			/<h1 class="[^"]*font-serif[^"]*"><span class="sr-only">Error <\/span>500<\/h1>/,
		);
		expect(html).toContain("Something went wrong on our side.");
		expect(html).toContain("Nothing you did.");
		expect(html).toMatch(/<a href="\/"[^>]*>Try again<\/a>/);
		expect(html).toMatch(/<a href="\/"[^>]*>Go to Home<\/a>/);
	});

	it("loads the same address again with Try again, query and all", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const html = await text(await fail("/?adjust=1"));
		expect(html).toMatch(/<a href="\/\?adjust=1"[^>]*>Try again<\/a>/);
	});

	it("never shows what failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const html = await text(await fail("/"));
		expect(html).not.toContain("access-sandbox");
		expect(html).not.toContain("Whole Foods");
		expect(html).not.toContain("42.17");
		expect(html).not.toMatch(/stack|\bat \w+ \(/i);
	});

	it("never logs the message, a token or a transaction: only the error's name and the route", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await text(await fail("/"));
		expect(logged).toHaveBeenCalledTimes(1);
		const line = JSON.stringify(logged.mock.calls);
		expect(line).not.toContain("access-sandbox");
		expect(line).not.toContain("Whole Foods");
		expect(line).toContain("Error");
		expect(logged.mock.calls[0]?.length).toBe(1);
	});

	it("gives an htmx request one plain sentence, not a page inside a page", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await fail("/", { "HX-Request": "true" });
		const body = await text(res);
		expect(res.status).toBe(500);
		expect(body).not.toContain("<html");
		expect(body).not.toContain("<svg");
		expect(body).toMatch(
			/<p role="alert">Something went wrong on our side\.<\/p>/,
		);
		expect(body).not.toContain("access-sandbox");
	});

	it("keeps the security headers on the error page", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await fail("/");
		expect(res.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
	});

	it("still answers an exception that carries its own response, such as a refused form post, with that response", async () => {
		const res = await exports.default.fetch(`${BASE}/transactions/1`, {
			method: "POST",
			headers: {
				Origin: "https://evil.example",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "note=hi",
		});
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain("Something went wrong");
	});
});
