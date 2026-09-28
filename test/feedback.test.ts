import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	feedback,
	fileFeedbackIssue,
	retryFeedback,
} from "../src/routes/feedback";

const BASE = "http://tally.test";

function productionApp(token?: string) {
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
					DEMO: "false",
					FEEDBACK_GITHUB_TOKEN: token,
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
			"content-type": "application/x-www-form-urlencoded",
			"User-Agent":
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
			...headers,
		},
		body: new URLSearchParams(fields),
		redirect: "manual" as const,
	};
}

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
		expect(response.headers.get("location")).toContain("toast=Thanks.+Sent.");
		expect(
			await env.DB.prepare(
				"SELECT actor, type, feeling, message, page, device FROM feedback",
			).first(),
		).toEqual({
			actor: "person@example.com",
			type: "Idea",
			feeling: "Happy",
			message: "A useful thought",
			page: "/settings?open=3",
			device: "iPhone Safari",
		});
	});

	it("limits an actor to ten messages in an hour", async () => {
		for (let i = 0; i < 10; i++) {
			await env.DB.prepare(
				"INSERT INTO feedback (actor, type, feeling, message, page, device) VALUES (?, 'Bug', 'Okay', 'old', '/', 'Desktop browser')",
			)
				.bind("person@example.com")
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
		expect(response.headers.get("location")).toMatch(/^\/\?toast=/);
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
	expect(JSON.parse(String(init?.body))).toEqual({
		title: "Bug: This does not work at all",
		body: "Type: Bug\nFeeling: Frustrated\nPage: /accounts\nDevice: iPhone Safari\n\nThis does not work at all",
		labels: ["Bug"],
	});
	expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token");
	expect(JSON.stringify(log.mock.calls)).not.toContain("This does not work");
	expect(
		await env.DB.prepare("SELECT github_issue_number FROM feedback").first(),
	).toEqual({ github_issue_number: 136 });
	log.mockRestore();
});

it("retries unfiled feedback in the nightly job", async () => {
	await env.DB.prepare(
		"INSERT INTO feedback (actor, type, feeling, message, page, device) VALUES ('person', 'Question', 'Okay', 'Why?', '/', 'Desktop Chrome')",
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

it("puts a feedback link to the current path on every app page", async () => {
	for (const path of [
		"/",
		"/transactions?uncategorized=1",
		"/settings",
		"/feedback?from=/",
	]) {
		const response = await exports.default.fetch(BASE + path);
		const html = await response.text();
		expect(html).toContain(
			`href="/feedback?from=${encodeURIComponent(new URL(BASE + path).pathname + new URL(BASE + path).search)}"`,
		);
	}
});
