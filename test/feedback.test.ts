import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	diagnosticsEnabled,
	injectDiagnosticsScript,
	normalizeFeedbackContext,
	replayLinksEnabled,
	screenshotPreviewEnabled,
} from "../src/feedback/diagnostics";
import { sanitizeFeedbackMessage } from "../src/feedback/privacy";
import {
	feedback,
	fileFeedbackIssue,
	retryFeedback,
} from "../src/routes/feedback";

const BASE = "http://tally.test";

function productionApp(
	token?: string,
	options: {
		diagnostics?: boolean;
		replayLinks?: boolean;
		demo?: boolean;
	} = {},
) {
	const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
	app.use("*", async (c, next) => {
		c.set("actor", "person@example.com");
		await next();
	});
	app.route("/", feedback);
	return {
		fetch(path: string, init?: RequestInit, waitUntil = vi.fn()) {
			return app.fetch(
				new Request(BASE + path, init),
				{
					...env,
					DEMO: options.demo ? "true" : "false",
					FEEDBACK_GITHUB_TOKEN: token,
					FEEDBACK_DIAGNOSTICS_ENABLED: options.diagnostics ? "true" : "false",
					FEEDBACK_REPLAY_LINKS_ENABLED: options.replayLinks ? "true" : "false",
				} as unknown as Env,
				{ waitUntil, passThroughOnException() {}, props: {} },
			);
		},
	};
}

function postFields(fields: Record<string, string>, headers = {}) {
	return {
		method: "POST",
		headers: {
			Origin: BASE,
			Cookie:
				"__Host-tally-feedback-limit=123e4567-e89b-12d3-a456-426614174000",
			"content-type": "application/x-www-form-urlencoded",
			"User-Agent":
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
			...headers,
		},
		body: new URLSearchParams({
			device_category: "Mobile browser",
			message_reviewed: sanitizeFeedbackMessage(fields.message ?? "").trim(),
			...fields,
		}),
		redirect: "manual" as const,
	};
}

describe("feedback diagnostic safeguards", () => {
	const userAgent =
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Version/18.2 Mobile Safari/604.1";

	it("keeps only allowlisted metadata and excludes query strings and error text", () => {
		const context = normalizeFeedbackContext(
			{
				deviceCategory: "Mobile browser",
				errorName: "TypeError",
				userAgent,
				message: "PRIVATE MERCHANT AND AMOUNT",
			},
			"/accounts?private=1",
		);
		expect(context).toEqual({
			route: "/accounts",
			deviceCategory: "Mobile browser",
			errorName: "TypeError",
		});
		expect(JSON.stringify(context)).not.toContain("PRIVATE");
		expect(JSON.stringify(context)).not.toContain("Safari/604.1");
		expect(JSON.stringify(context)).not.toContain("private=1");
	});

	it("rejects malformed dimensions while retaining the generic Error category", () => {
		const context = normalizeFeedbackContext(
			{
				userAgent,
				viewport: { width: 90000, height: 0 },
				deviceCategory: "unknown",
				errorName: "Error",
			},
			"/accounts",
		);
		expect(context).toEqual({
			route: "/accounts",
			deviceCategory: "Unknown",
			errorName: "Error",
		});
	});

	it("keeps the generic Error category when diagnostics are enabled", () => {
		expect(
			normalizeFeedbackContext({ errorName: "Error" }, "/settings"),
		).toEqual({
			route: "/settings",
			deviceCategory: "Unknown",
			errorName: "Error",
		});
	});

	it("keeps replay and screenshot capture off pending acceptance", () => {
		expect(diagnosticsEnabled({})).toBe(false);
		expect(
			diagnosticsEnabled({
				DEMO: "true",
				FEEDBACK_DIAGNOSTICS_ENABLED: "true",
			}),
		).toBe(false);
		expect(
			diagnosticsEnabled({
				DEMO: "false",
				FEEDBACK_DIAGNOSTICS_ENABLED: "true",
			}),
		).toBe(true);
		expect(replayLinksEnabled()).toBe(false);
		expect(
			screenshotPreviewEnabled({ FEEDBACK_SCREENSHOT_PREVIEW_ENABLED: "true" }),
		).toBe(false);
	});
});

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM feedback").run();
});

describe("feedback form", () => {
	it("validates required and 2,000-character messages with an alert", async () => {
		for (const message of ["", "x".repeat(2001)]) {
			const response = await productionApp().fetch(
				"/feedback",
				postFields({ type: "Bug", feeling: "Confused", message, from: "/" }),
			);
			expect(response.status).toBe(422);
			expect(await response.text()).toMatch(/role="alert"/);
		}
	});

	it("saves a valid message and redirects back with thanks", async () => {
		const response = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Idea",
				feeling: "Happy",
				message: "A useful thought",
				from: "/settings?open=3",
			}),
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/settings?open=3");
		expect(response.headers.get("location")).toContain("sent=feedback");
		expect(
			await env.DB.prepare(
				"SELECT actor, type, feeling, message, page, device FROM feedback",
			).first(),
		).toEqual({
			actor: "123e4567-e89b-12d3-a456-426614174000",
			type: "Idea",
			feeling: "Happy",
			message: "A useful thought",
			page: "/settings",
			device: "Mobile browser",
		});
	});

	it("stores allowlisted technical context only after the user opts in", async () => {
		const context = {
			deviceCategory: "Mobile browser",
			errorName: "TypeError",
			secret: "BALANCE 987654",
		};
		const response = await productionApp(undefined, {
			diagnostics: true,
		}).fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Confused",
				message: "A fake diagnostic fixture",
				from: "/accounts?private=1",
				include_diagnostics: "yes",
				client_context: JSON.stringify(context),
			}),
		);
		expect(response.status).toBe(303);
		const row = await env.DB.prepare(
			"SELECT client_context, replay_url FROM feedback",
		).first<{ client_context: string | null; replay_url: string | null }>();
		expect(JSON.parse(row?.client_context ?? "null")).toEqual({
			route: "/accounts",
			deviceCategory: "Mobile browser",
			errorName: "TypeError",
		});
		expect(row?.client_context).not.toContain("987654");
		expect(row?.replay_url).toBeNull();
	});

	it("does not store client context or replay IDs when disabled or not opted in", async () => {
		const context = JSON.stringify({
			userAgent: "fake",
			viewport: { width: 390, height: 844 },
		});
		await productionApp(undefined, {
			diagnostics: false,
			replayLinks: true,
		}).fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Fixture only",
				from: "/accounts",
				include_diagnostics: "yes",
				include_replay: "yes",
				client_context: context,
				posthog_session_id: "fake-session-id",
			}),
		);
		const row = await env.DB.prepare(
			"SELECT client_context, replay_url FROM feedback",
		).first();
		expect(row).toEqual({ client_context: null, replay_url: null });
	});

	it("requires a separate user choice before storing client context", async () => {
		await productionApp(undefined, { diagnostics: true }).fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Fixture only",
				from: "/accounts",
				client_context: JSON.stringify({
					userAgent:
						"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Version/18.2 Safari/604.1",
				}),
			}),
		);
		expect(
			await env.DB.prepare("SELECT client_context FROM feedback").first(),
		).toEqual({ client_context: null });
	});

	it("never stores a replay link or session ID", async () => {
		await productionApp(undefined, {
			diagnostics: true,
			replayLinks: true,
		}).fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Fixture only",
				from: "/accounts",
				include_diagnostics: "yes",
				include_replay: "yes",
				client_context: JSON.stringify({
					userAgent:
						"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) Version/18.2 Mobile Safari/604.1",
				}),
				posthog_session_id: "session_123-abc",
			}),
		);
		expect(
			await env.DB.prepare("SELECT replay_url FROM feedback").first(),
		).toEqual({ replay_url: null });
	});

	it("does not render the diagnostics script or opt-in when disabled", async () => {
		const response = await productionApp().fetch("/feedback");
		const html = await response.text();
		expect(html).not.toContain("feedback-diagnostics.js");
		expect(html).not.toContain("Attach technical details");
	});

	it("does not issue a feedback limiter cookie in the demo", async () => {
		const response = await productionApp(undefined, { demo: true }).fetch(
			"/feedback",
		);
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	it("renews an expired limiter and preserves the cleaned draft for resubmission", async () => {
		const expired = await productionApp().fetch(
			"/feedback",
			postFields(
				{
					type: "Bug",
					feeling: "Okay",
					message: "Email me at person@example.com",
					from: "/accounts/3/disconnect",
				},
				{ Cookie: "" },
			),
		);
		expect(expired.status).toBe(400);
		const html = await expired.text();
		expect(html).toContain("Email me at [email removed]");
		expect(html).not.toContain("person@example.com");
		const token = expired.headers
			.get("set-cookie")
			?.match(/__Host-tally-feedback-limit=([^;]+)/)?.[1];
		expect(token).toMatch(/^[0-9a-f-]{36}$/i);
		const resent = await productionApp().fetch(
			"/feedback",
			postFields(
				{
					type: "Bug",
					feeling: "Okay",
					message: "Email me at [email removed]",
					from: "/accounts/3/disconnect",
				},
				{ Cookie: `__Host-tally-feedback-limit=${token}` },
			),
		);
		expect(resent.status).toBe(303);
		expect(
			await env.DB.prepare("SELECT message, page FROM feedback").first(),
		).toEqual({ message: "Email me at [email removed]", page: "/accounts" });
	});

	it("requires a no-script user to confirm the cleaned text before storage", async () => {
		const first = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Contact person@example.com",
				from: "/",
				message_reviewed: "",
			}),
		);
		expect(first.status).toBe(200);
		const html = await first.text();
		expect(html).toContain("I reviewed the cleaned message above.");
		expect(html).toContain('name="confirm_review"');
		expect(html).toContain("Contact [email removed]");
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS count FROM feedback").first(),
		).toEqual({ count: 0 });
		const edited = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Contact [email removed], new person@example.com",
				from: "/",
				message_reviewed: "Contact [email removed]",
				confirm_review: "yes",
			}),
		);
		expect(edited.status).toBe(200);
		const changedHtml = await edited.text();
		expect(changedHtml).toContain(
			"Contact [email removed], new [email removed]",
		);
		expect(changedHtml).toContain('name="confirm_review"');
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS count FROM feedback").first(),
		).toEqual({ count: 0 });
		const confirmed = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "Contact [email removed], new [email removed]",
				from: "/",
				confirm_review: "yes",
			}),
		);
		expect(confirmed.status).toBe(303);
	});

	it("adds the opt-in diagnostics UI only when enabled", async () => {
		const html = await (
			await productionApp(undefined, {
				diagnostics: true,
			}).fetch("/feedback")
		).text();
		expect(html).toContain("Attach technical details");
		expect(html).toContain("excludes raw");
		expect(html).not.toContain('name="include_replay"');
	});

	it("injects only a first-party diagnostics script when explicitly enabled", () => {
		const html = "<html><body>fixture</body></html>";
		expect(injectDiagnosticsScript(html, false)).toBe(html);
		expect(injectDiagnosticsScript(html, true)).toContain(
			'<script type="module" src="/js/feedback-diagnostics.js"></script>',
		);
		expect(injectDiagnosticsScript("<html><body>fragment", true)).toBe(
			"<html><body>fragment",
		);
	});

	it("limits an actor to ten messages in an hour", async () => {
		for (let i = 0; i < 10; i++) {
			await env.DB.prepare(
				"INSERT INTO feedback (actor, type, feeling, message, page, device) VALUES (?, 'Bug', 'Okay', 'old', '/', 'Desktop browser')",
			)
				.bind("123e4567-e89b-12d3-a456-426614174000")
				.run();
		}
		const response = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Bug",
				feeling: "Okay",
				message: "eleven",
				from: "/",
			}),
		);
		expect(response.status).toBe(429);
		expect(await response.text()).toMatch(/role="alert"/);
	});

	it("reuses the fixed-expiry limiter cookie across feedback reopen and send", async () => {
		const firstGet = await productionApp().fetch("/feedback");
		const setCookie = firstGet.headers.get("set-cookie") ?? "";
		const token = setCookie.match(/__Host-tally-feedback-limit=([^;]+)/)?.[1];
		expect(token).toMatch(/^[0-9a-f-]{36}$/i);
		expect(setCookie).toContain("Max-Age=3600");
		const cookie = `__Host-tally-feedback-limit=${token}`;

		for (let i = 0; i < 10; i++) {
			if (i > 0) {
				const reopened = await productionApp().fetch("/feedback", {
					headers: { Cookie: cookie },
				});
				expect(reopened.headers.get("set-cookie")).toBeNull();
			}
			const response = await productionApp().fetch(
				"/feedback",
				postFields(
					{
						type: "Bug",
						feeling: "Okay",
						message: `fixture ${i}`,
						from: "/",
					},
					{ Cookie: cookie },
				),
			);
			expect(response.status).toBe(303);
		}

		const reopened = await productionApp().fetch("/feedback", {
			headers: { Cookie: cookie },
		});
		expect(reopened.headers.get("set-cookie")).toBeNull();
		const eleventh = await productionApp().fetch(
			"/feedback",
			postFields(
				{ type: "Bug", feeling: "Okay", message: "fixture 11", from: "/" },
				{ Cookie: cookie },
			),
		);
		expect(eleventh.status).toBe(429);
	});

	it("rejects another origin as the return page", async () => {
		const response = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Other",
				feeling: "Okay",
				message: "hello",
				from: "https://evil.example/steal",
			}),
		);
		expect(response.headers.get("location")).toBe("/?sent=feedback");
	});

	it("preserves root-page query parameters when returning after feedback", async () => {
		const response = await productionApp().fetch(
			"/feedback",
			postFields({
				type: "Idea",
				feeling: "Okay",
				message: "Synthetic feedback",
				from: "/",
				return_to: "/?adjust=1",
			}),
		);
		expect(response.headers.get("location")).toBe("/?adjust=1&sent=feedback");
	});
});

it("files the expected GitHub issue without logging the token or message", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (actor, type, feeling, message, page, device) VALUES ('person', 'Bug', 'Frustrated', ?, '/accounts', 'iPhone Safari')",
	)
		.bind("This does not work at all")
		.run();
	const row = await env.DB.prepare("SELECT * FROM feedback").first();
	if (!row) throw new Error("feedback fixture was not inserted");
	const fetchStub = vi.fn(
		async () => new Response(JSON.stringify({ number: 136 }), { status: 201 }),
	);
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	await fileFeedbackIssue(env.DB, "secret-token", row, fetchStub);
	const [url, init] = fetchStub.mock.calls[0] as unknown as [
		string,
		RequestInit,
	];
	expect(url).toBe(
		"https://api.github.com/repos/kwilson21/tally-feedback/issues",
	);
	expect(init?.headers).toMatchObject({
		Authorization: "Bearer secret-token",
		Accept: "application/vnd.github+json",
		"User-Agent": "Tally feedback worker",
	});
	expect(init?.redirect).toBe("manual");
	expect(JSON.parse(String(init?.body))).toEqual({
		title: "Bug: This does not work at all",
		body: "Type: Bug\nFeeling: Frustrated\nPage: ` /accounts `\nDevice category: Unknown\n\n```\nThis does not work at all\n```",
		labels: ["Bug"],
	});
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token");
	expect(JSON.stringify(log.mock.calls)).not.toContain("This does not work");
	expect(
		await env.DB.prepare("SELECT github_issue_number FROM feedback").first(),
	).toEqual({ github_issue_number: 136 });
	log.mockRestore();
});

it("adds only approved coarse technical fields and no replay link to the private issue", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (actor, type, feeling, message, page, device, client_context, replay_url) VALUES ('fixture', 'Bug', 'Confused', 'Synthetic report', '/accounts', 'iPhone Safari', ?, ?)",
	)
		.bind(
			JSON.stringify({
				route: "/accounts",
				deviceCategory: "Mobile browser",
				errorName: "TypeError",
				browser: "Safari",
				browserVersion: "18.2",
				os: "iOS",
				osVersion: "18.2",
				viewport: { width: 390, height: 844 },
				screen: { width: 393, height: 852 },
				pixelRatio: 3,
				build: "fixture-build",
				error: "TypeError",
			}),
			"https://us.i.posthog.com/replay/fake-session-123",
		)
		.run();
	const row = await env.DB.prepare("SELECT * FROM feedback").first();
	if (!row) throw new Error("feedback fixture was not inserted");
	const fetchStub = vi.fn(
		async () => new Response(JSON.stringify({ number: 147 }), { status: 201 }),
	);
	await fileFeedbackIssue(env.DB, "fixture-token", row, fetchStub);
	const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
	const body = JSON.parse(String(init?.body)).body as string;
	expect(body).toContain("Device category: Unknown");
	expect(body).toContain("Recent error category: TypeError");
	expect(body).not.toContain("replay");
	expect(body).not.toContain("Safari 18.2");
	expect(body).not.toContain("390x844");
	expect(body).not.toContain("fixture-build");
	expect(body).not.toContain("userAgent");
	expect(body).not.toContain("stack");
});

it("retries unfiled feedback in the nightly job", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), 'person', 'Question', 'Okay', 'Why?', '/', 'Desktop Chrome')",
	).run();
	const fetchStub = vi.fn(
		async () => new Response(JSON.stringify({ number: 22 }), { status: 201 }),
	);
	await retryFeedback(
		{ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "token" },
		fetchStub,
	);
	expect(fetchStub).toHaveBeenCalledOnce();
	expect(
		await env.DB.prepare("SELECT github_issue_number FROM feedback").first(),
	).toEqual({ github_issue_number: 22 });
});

describe("demo", () => {
	it("shows that feedback is off and returns 404 on POST without GitHub", async () => {
		const get = await exports.default.fetch(`${BASE}/feedback?from=/settings`);
		expect(await get.text()).toContain("Feedback is off in the demo");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const post = await exports.default.fetch(
			`${BASE}/feedback`,
			postFields({ type: "Bug", feeling: "Okay", message: "No", from: "/" }),
		);
		expect(post.status).toBe(404);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});

it("uses the Referer for the return page and omits the button on feedback", async () => {
	const response = await productionApp().fetch("/feedback", {
		headers: { Referer: `${BASE}/transactions?uncategorized=1` },
	});
	const html = await response.text();
	expect(html).toContain('name="from" value="/transactions"');
	expect(html).not.toContain(
		"fixed bottom-[calc(6.5rem+var(--safe-area-bottom))]",
	);
});

it("renders a plain feedback link on app pages", async () => {
	const html = await (await exports.default.fetch(`${BASE}/settings`)).text();
	expect(html).toContain('href="/feedback"');
	expect(html).not.toContain("/feedback?from=");
});

it("normalizes browser newlines before enforcing the message limit", async () => {
	const response = await productionApp().fetch(
		"/feedback",
		postFields({
			type: "Bug",
			feeling: "Okay",
			message: `${"x".repeat(1998)}\r\n`,
			from: "/",
		}),
	);
	expect(response.status).toBe(303);
});

it("accepts a same-origin POST without an Origin header", async () => {
	const init = postFields({
		type: "Bug",
		feeling: "Okay",
		message: "hello",
		from: "/",
	});
	delete (init.headers as Record<string, string>).Origin;
	expect((await productionApp().fetch("/feedback", init)).status).toBe(303);
});

it("rejects paths that normalize to a protocol-relative URL", async () => {
	const response = await productionApp().fetch(
		"/feedback",
		postFields({
			type: "Bug",
			feeling: "Okay",
			message: "hello",
			from: "/.//evil.com",
		}),
	);
	expect(response.headers.get("location")).toBe("/?sent=feedback");
});

it("atomically limits concurrent submissions", async () => {
	const responses = await Promise.all(
		Array.from({ length: 11 }, (_, i) =>
			productionApp().fetch(
				"/feedback",
				postFields({
					type: "Bug",
					feeling: "Okay",
					message: `message ${i}`,
					from: "/",
				}),
			),
		),
	);
	expect(responses.filter((r) => r.status === 303)).toHaveLength(10);
	expect(responses.filter((r) => r.status === 429)).toHaveLength(1);
});

describe("feedback filing safeguards", () => {
	async function insertOld(count: number) {
		for (let i = 0; i < count; i++) {
			await env.DB.prepare(
				"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), ?, 'Bug', 'Okay', ?, '/', 'Desktop Chrome')",
			)
				.bind(`person-${i}`, `message-${i}`)
				.run();
		}
	}

	it("claims a row once and builds a Unicode-safe, collapsed title", async () => {
		const message = `${"x".repeat(59)}😀\n second line`;
		await insertOld(1);
		await env.DB.prepare("UPDATE feedback SET message = ?").bind(message).run();
		const row = await env.DB.prepare("SELECT * FROM feedback").first();
		if (!row) throw new Error("missing fixture");
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
		);
		await Promise.all([
			fileFeedbackIssue(env.DB, "token", row, fetchStub),
			fileFeedbackIssue(env.DB, "token", row, fetchStub),
		]);
		expect(fetchStub).toHaveBeenCalledOnce();
		const calls = fetchStub.mock.calls as unknown as [string, RequestInit][];
		const body = JSON.parse(String(calls[0]?.[1].body));
		expect(body.title).toBe(`Bug: ${"x".repeat(59)}😀`);
		expect(body.body).toMatch(/```\n[^`]*\n```$/);
	});

	it("processes at most 20 eligible rows", async () => {
		await insertOld(21);
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ number: 1 }), { status: 201 }),
		);
		await retryFeedback(
			{ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "token" },
			fetchStub,
		);
		expect(fetchStub).toHaveBeenCalledTimes(20);
	});

	it.each([401, 403])("stops after a %i token failure", async (status) => {
		await insertOld(2);
		const fetchStub = vi.fn(async () => new Response(null, { status }));
		await retryFeedback(
			{ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "token" },
			fetchStub,
		);
		expect(fetchStub).toHaveBeenCalledOnce();
	});

	it("makes 422 terminal and does not retry five-attempt rows", async () => {
		await insertOld(2);
		await env.DB.prepare(
			"UPDATE feedback SET attempts = 4 WHERE id = (SELECT MAX(id) FROM feedback)",
		).run();
		const fetchStub = vi.fn(async () => new Response(null, { status: 422 }));
		await retryFeedback(
			{ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "token" },
			fetchStub,
		);
		await retryFeedback(
			{ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "token" },
			fetchStub,
		);
		expect(fetchStub).toHaveBeenCalledTimes(2);
	});
});

async function insertFeedback(message = "Why?", extra = "") {
	await env.DB.prepare(
		`INSERT INTO feedback (created_at, actor, type, feeling, message, page, device${extra ? ", filing_at, attempts" : ""}) VALUES (datetime('now', '-11 minutes'), 'person', 'Question', 'Okay', ?, '/', 'Desktop Chrome'${extra})`,
	)
		.bind(message)
		.run();
}

const filed = (number: number) =>
	vi.fn(async () => new Response(JSON.stringify({ number }), { status: 201 }));

it("keeps #123, @someone and backticks in feedback from becoming links or breaking out", async () => {
	await insertFeedback("See #123 and @someone ``` done");
	const fetchStub = filed(7);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, fetchStub);
	const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
	const { body } = JSON.parse(String(init.body));
	expect(body).toContain("````\nSee #123 and @someone ``` done\n````");
});

it("files a row again when an earlier claim was left behind", async () => {
	await insertFeedback("Stuck", ", datetime('now', '-11 minutes'), 1");
	const fetchStub = filed(8);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, fetchStub);
	expect(fetchStub).toHaveBeenCalledOnce();
});

it("doesn't file a row another run claimed a moment ago", async () => {
	await insertFeedback("Busy", ", datetime('now'), 1");
	const fetchStub = filed(9);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, fetchStub);
	expect(fetchStub).not.toHaveBeenCalled();
});

it("gives up on a row GitHub rejects with 422", async () => {
	await insertFeedback("Bad");
	const reject = vi.fn(async () => new Response("{}", { status: 422 }));
	vi.spyOn(console, "info").mockImplementation(() => {});
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, reject);
	await env.DB.prepare(
		"UPDATE feedback SET filing_at = datetime('now', '-1 day')",
	).run();
	const again = filed(10);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, again);
	expect(again).not.toHaveBeenCalled();
	expect(
		await env.DB.prepare("SELECT last_status FROM feedback").first(),
	).toEqual({ last_status: 422 });
});

it("stops the run on a bad token without using up the rows' attempts", async () => {
	await insertFeedback("One");
	await insertFeedback("Two");
	const denied = vi.fn(async () => new Response("{}", { status: 401 }));
	vi.spyOn(console, "info").mockImplementation(() => {});
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, denied);
	expect(denied).toHaveBeenCalledOnce();
	expect(
		(
			await env.DB.prepare(
				"SELECT attempts, filing_at FROM feedback ORDER BY id",
			).all()
		).results,
	).toEqual([
		{ attempts: 0, filing_at: null },
		{ attempts: 0, filing_at: null },
	]);
});

it("lets browsers send the page to /feedback as a same-origin Referer", async () => {
	const res = await exports.default.fetch(`${BASE}/transactions`);
	expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
});

it("strips legacy query strings before filing feedback", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), 'person', 'Bug', 'Okay', 'Hi', ?, 'Desktop Chrome')",
	)
		.bind("/accounts?x=`@someone")
		.run();
	const fetchStub = vi.fn(
		async () => new Response(JSON.stringify({ number: 3 }), { status: 201 }),
	);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, fetchStub);
	const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
	expect(JSON.parse(String(init.body)).body).toContain("Page: ` /accounts `");
});

it("files a report whose page has a huge number of backtick runs", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), 'person', 'Bug', 'Okay', 'Hi', ?, 'Desktop Chrome')",
	)
		.bind(`/accounts?x=${"`a".repeat(200_000)}`)
		.run();
	const fetchStub = vi.fn(
		async () => new Response(JSON.stringify({ number: 4 }), { status: 201 }),
	);
	await retryFeedback({ DB: env.DB, FEEDBACK_GITHUB_TOKEN: "t" }, fetchStub);
	expect(fetchStub).toHaveBeenCalledOnce();
});
