import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { fileFeedbackIssue } from "../src/routes/feedback";

vi.mock("../src/access", () => ({
	verifiedEmail: async () => "fixture@example.test",
}));
vi.mock("../src/routes/feedback", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../src/routes/feedback")>();
	return original;
});
const base = "http://fixture.test";
it("keeps Worker discovery out of the separate Node verification suite", async () => {
	const config = await readFile(
		new URL("../vitest.config.ts", import.meta.url),
		"utf8",
	);
	expect(config).toContain(
		'include: ["test/**/*.test.ts", "test/**/*.test.tsx"]',
	);
	expect(config).toContain("verification tests use the separate Node config");
});
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
			expect(html).toContain("deterministic pattern redaction");
			expect(html).toContain("cannot reliably identify arbitrary names");
			expect(html).toContain("GitHub filing receives");
			expect(html).toContain("without the sign-in email");
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
	const statements: string[] = [];
	const db = {
		prepare: (_sql: string) => {
			statements.push(_sql);
			return {
				bind: (...args: unknown[]) => {
					binds.push(args);
					return {
						run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
					};
				},
			};
		},
	};
	return { db: db as unknown as D1Database, binds, statements };
}
describe("feedback route privacy", () => {
	it("issues an opaque hourly feedback limiter cookie", async () => {
		const response = await app.fetch(
			new Request(`${base}/feedback`),
			bindings(),
		);
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/__Host-tally-feedback-limit=[0-9a-f-]{36}/i);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Max-Age=3600");
		expect(cookie).not.toContain("fixture@example.test");
	});
	it("stores sanitized text, route and coarse device under the random limiter ID", async () => {
		const { db, binds, statements } = fakeDb();
		const limiter = "123e4567-e89b-12d3-a456-426614174000";
		const response = await app.fetch(
			new Request(`${base}/feedback`, {
				method: "POST",
				headers: {
					Origin: base,
					Cookie: `__Host-tally-feedback-limit=${limiter}`,
					"User-Agent": "Riley Example riley@example.test account 123456789",
				},
				body: new URLSearchParams({
					type: "Bug",
					feeling: "Okay",
					message:
						"Contact riley@example.test at 42 Oak Street, account 123456789, charge $842.19. Riley Example saw it.",
					from: "/transactions/tx_123?merchant=Riley#secret",
					device_category: "phone",
					client_context: JSON.stringify({ userAgent: "riley@example.test" }),
					posthog_session_id: "fake-session",
				}),
			}),
			{
				...bindings({
					FEEDBACK_DIAGNOSTICS_ENABLED: "true",
					FEEDBACK_REPLAY_LINKS_ENABLED: "true",
				}),
				DB: db,
			},
		);
		expect(response.status).toBe(303);
		expect(statements[0]).not.toContain("replay_url");
		expect(binds[0]?.[0]).toBe(limiter);
		expect(binds[0]?.[3]).toContain("[email removed]");
		expect(binds[0]?.[3]).toContain("[address removed]");
		expect(binds[0]?.[3]).toContain("[account detail removed]");
		expect(binds[0]?.[3]).toContain("[amount removed]");
		expect(binds[0]?.[3]).not.toContain("Riley Example");
		expect(binds[0]?.[4]).toBe("/transactions");
		expect(binds[0]?.[5]).toBe("Unknown");
		expect(JSON.stringify(binds)).not.toContain("riley@example.test");
		expect(JSON.stringify(binds)).not.toContain("123456789");
		expect(JSON.stringify(binds)).not.toContain("fake-session");
	});
	it("sanitizes legacy D1 feedback again before GitHub retry/file", async () => {
		const { db } = fakeDb();
		let body = "";
		await fileFeedbackIssue(
			db,
			"fixture-token",
			{
				id: 2,
				type: "Bug",
				feeling: "Okay",
				message:
					"Riley Example riley@example.test +1 (415) 555-0137, 42 Oak Street, account 123456789, charge $842.19 https://private.test/?token=secret",
				page: "/transactions/record-123?merchant=Riley#secret",
				device: "Riley Example riley@example.test",
				client_context: JSON.stringify({
					error: "riley@example.test",
					browserVersion: "Riley Example",
				}),
				replay_url: "https://replay.example/replay/private-session",
				attempts: 0,
			},
			(async (_url, init) => {
				body = String(init?.body);
				return new Response(JSON.stringify({ number: 2 }), { status: 201 });
			}) as typeof fetch,
		);
		for (const secret of [
			"Riley",
			"riley@example.test",
			"555-0137",
			"Oak Street",
			"123456789",
			"842.19",
			"record-123",
			"token=secret",
			"private-session",
		])
			expect(body).not.toContain(secret);
	});
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
		expect(html).toContain(
			'name="return_to" value="/transactions?q=SECRET-merchant&amp;amount=12345"',
		);
		expect(html).not.toContain("#SECRET-note");
	});
	it("preserves the root route query for return navigation", async () => {
		const response = await app.fetch(
			new Request(`${base}/feedback`, {
				headers: { Referer: `${base}/?adjust=1` },
			}),
			bindings(),
		);
		const html = await response.text();
		expect(html).toContain('name="from" value="/"');
		expect(html).toContain('name="return_to" value="/?adjust=1"');
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
					headers: {
						Origin: base,
						Cookie:
							"__Host-tally-feedback-limit=123e4567-e89b-12d3-a456-426614174000",
					},
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
				from.startsWith("/transactions") ? "/transactions" : "/other",
			);
			expect(JSON.stringify(binds)).not.toContain("SECRET");
			expect(response.headers.get("location")).not.toContain("#SECRET");
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

it("uses only legacy columns when diagnostics are disabled", async () => {
	const { db, statements } = fakeDb();
	await app.fetch(
		new Request(`${base}/feedback`, {
			method: "POST",
			headers: {
				Origin: base,
				Cookie:
					"__Host-tally-feedback-limit=123e4567-e89b-12d3-a456-426614174000",
			},
			body: new URLSearchParams({
				type: "Bug",
				feeling: "Okay",
				message: "Fixture",
				from: "/",
			}),
		}),
		{ ...bindings(), DB: db },
	);
	expect(statements[0]).not.toContain("client_context");
	expect(statements[0]).not.toContain("replay_url");
});
for (const consent of [false, true])
	it(`ignores replay identifiers regardless of checkbox: ${consent}`, async () => {
		const { db, binds, statements } = fakeDb();
		await app.fetch(
			new Request(`${base}/feedback`, {
				method: "POST",
				headers: {
					Origin: base,
					Cookie:
						"__Host-tally-feedback-limit=123e4567-e89b-12d3-a456-426614174000",
				},
				body: new URLSearchParams({
					type: "Bug",
					feeling: "Okay",
					message: "Fixture",
					from: "/",
					include_diagnostics: "yes",
					include_replay: consent ? "yes" : "",
					posthog_session_id: "fake-session",
				}),
			}),
			{
				...bindings({
					FEEDBACK_DIAGNOSTICS_ENABLED: "true",
					FEEDBACK_REPLAY_LINKS_ENABLED: "true",
					POSTHOG_HOST: "https://replay.example.test",
					FEEDBACK_APPROVED_REPLAY_ORIGIN: "https://replay.example.test",
				}),
				DB: db,
			},
		);
		expect(statements[0]).not.toContain("replay_url");
		expect(JSON.stringify(binds)).not.toContain("fake-session");
	});
it("does not offer replay while no pinned SDK and payload proof exist", async () => {
	const response = await app.fetch(
		new Request(`${base}/feedback`),
		bindings({
			FEEDBACK_DIAGNOSTICS_ENABLED: "true",
			FEEDBACK_REPLAY_LINKS_ENABLED: "true",
			POSTHOG_HOST: "https://other.example.test",
			FEEDBACK_APPROVED_REPLAY_ORIGIN: "https://replay.example.test",
		}),
	);
	expect(await response.text()).not.toContain('name="include_replay"');
});
it("keeps recorder consent and session identifiers out of the form", async () => {
	const response = await app.fetch(
		new Request(`${base}/feedback`),
		bindings({
			FEEDBACK_DIAGNOSTICS_ENABLED: "true",
			FEEDBACK_REPLAY_LINKS_ENABLED: "true",
			POSTHOG_HOST: "https://replay.example.test",
			FEEDBACK_APPROVED_REPLAY_ORIGIN: "https://replay.example.test",
		}),
	);
	const html = await response.text();
	expect(html).not.toContain('name="include_replay"');
	expect(html).not.toContain('name="posthog_session_id"');
	expect(html).not.toContain("replay.example.test");
});
