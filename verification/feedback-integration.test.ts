import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { fileFeedbackIssue } from "../src/routes/feedback";

vi.mock("../src/access", () => ({
	verifiedEmail: async () => "fixture@example.test",
}));
const base = "http://fixture.test";
app.get("/__feedback-fragment-fixture", (c) =>
	c.html("<p>synthetic fragment</p>", 202),
);
function bindings(flags: Record<string, string> = {}) {
	return { DEMO: "false", ...flags } as Env;
}
describe("actual app diagnostics middleware", () => {
	for (const enabled of [false, true])
		it(`preserves a readable complete HTML response with diagnostics ${enabled}`, async () => {
			const response = await app.fetch(
				new Request(`${base}/feedback`),
				bindings({ FEEDBACK_DIAGNOSTICS_ENABLED: String(enabled) }),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Security-Policy")).toContain(
				"script-src 'self'",
			);
			const html = await response.text();
			expect(html).toContain("Send feedback");
			expect(html).toContain("</body>");
			expect(html.includes("/js/feedback-diagnostics.js")).toBe(enabled);
		});
	it("preserves fragment body, status and headers", async () => {
		const response = await app.fetch(
			new Request(`${base}/__feedback-fragment-fixture`),
			bindings({ FEEDBACK_DIAGNOSTICS_ENABLED: "true" }),
		);
		expect(response.status).toBe(202);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toBe("<p>synthetic fragment</p>");
	});
	it("does not enable capture in demo even with all flags on", async () => {
		const response = await app.fetch(
			new Request(`${base}/feedback`),
			bindings({
				DEMO: "true",
				FEEDBACK_DIAGNOSTICS_ENABLED: "true",
				FEEDBACK_SCREENSHOT_PREVIEW_ENABLED: "true",
			}),
		);
		expect(await response.text()).not.toContain("/js/feedback-diagnostics.js");
	});
});
function fakeDb() {
	const binds: unknown[][] = [];
	const db = {
		prepare: (_sql: string) => ({
			bind: (...args: unknown[]) => {
				binds.push(args);
				return { run: async () => ({ meta: { changes: 1, last_row_id: 1 } }) };
			},
		}),
	};
	return { db: db as unknown as D1Database, binds };
}
describe("feedback route privacy", () => {
	it("drops sensitive Referer query and fragment before rendering", async () => {
		const response = await app.fetch(
			new Request(`${base}/feedback`, {
				headers: {
					Referer: `${base}/transactions?q=SECRET-merchant&amount=12345#SECRET-note`,
				},
			}),
			bindings(),
		);
		const html = await response.text();
		expect(html).toContain('name="from" value="/transactions"');
		expect(html).not.toContain("SECRET");
		expect(html).not.toContain("12345");
	});
	it("rejects cross-origin Referer", async () => {
		const response = await app.fetch(
			new Request(`${base}/feedback`, {
				headers: { Referer: "https://other.test/transactions?q=SECRET" },
			}),
			bindings(),
		);
		expect(await response.text()).toContain('name="from" value="/"');
	});
	for (const from of [
		"/transactions?q=SECRET#SECRET",
		"https://other.test/SECRET",
		"//other.test/SECRET",
	])
		it(`sanitizes stored page with diagnostics off: ${from}`, async () => {
			const { db, binds } = fakeDb();
			const response = await app.fetch(
				new Request(`${base}/feedback`, {
					method: "POST",
					headers: { Origin: base },
					body: new URLSearchParams({
						type: "Bug",
						feeling: "Okay",
						message: "Fixture",
						from,
					}),
				}),
				{ ...bindings(), DB: db },
			);
			expect(response.status).toBe(303);
			expect(binds[0]?.[4]).toBe(
				from.startsWith("/transactions") ? "/transactions" : "/",
			);
			expect(JSON.stringify(binds)).not.toContain("SECRET");
			expect(response.headers.get("location")).not.toContain("SECRET");
		});
	it("scrubs legacy page queries before filing the issue", async () => {
		const { db } = fakeDb();
		let body = "";
		await fileFeedbackIssue(
			db,
			"fake-token",
			{
				id: 1,
				type: "Bug",
				feeling: "Okay",
				message: "Fixture",
				page: "/transactions?q=SECRET-merchant#SECRET-note",
				device: "Fixture",
			},
			(async (_url, init) => {
				body = String(init?.body);
				return new Response(JSON.stringify({ number: 1 }), { status: 201 });
			}) as typeof fetch,
		);
		expect(body).toContain("transactions");
		expect(body).not.toContain("SECRET");
	});
});
