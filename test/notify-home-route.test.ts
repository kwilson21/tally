import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";
import { sameOrigin } from "../src/security";

// Home's notify control and its script (decision 149), through the routes: Home's full load (GET /) and the check-in's redraw
// (POST /home/seen) draw the control while the first week is reading and the server has VAPID keys. The control's script loads
// on a full load in the before and reading phases, so Plaid's success, which swaps #page in place, still finds it. Neither
// shows anything in the demo.

const PERSON = "person@example.com";
const ORIGIN = "http://localhost";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
// RFC 8292's VAPID pair from Appendix A: a valid P-256 pair, so the route's key check passes.
const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";

const family = { ...env, DEMO: "false" } as unknown as Env;
const pushing = {
	...family,
	VAPID_PUBLIC_KEY: AS_PUBLIC,
	VAPID_PRIVATE_KEY: AS_PRIVATE,
} as unknown as Env;
const demo = {
	...env,
	DEMO: "true",
	VAPID_PUBLIC_KEY: AS_PUBLIC,
	VAPID_PRIVATE_KEY: AS_PRIVATE,
} as unknown as Env;

const CONTROL = 'data-notify="true"';
const PUSH_MODULE = 'src="/js/push.js"';

const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
router.use("*", sameOrigin);
router.use("*", async (c, next) => {
	c.set("actor", PERSON);
	await next();
});
router.route("/", home);

const page = async (bindings: Env) =>
	(await home.request("/", {}, bindings)).text();

const writeRecord = (value: unknown) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(JSON.stringify(value))
		.run();

/** The check-in's form post for the step the page shows, as Home's page sends it. */
const checkIn = (bindings: Env, step: string) =>
	router.request(
		"/home/seen",
		{
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ step }).toString(),
		},
		bindings,
	);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = 'first_tally'",
	).run();
	await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
});

describe("Home's full load: the control and its script", () => {
	it("while the import is read, with the keys: the control and push.js", async () => {
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const html = await page(pushing);
		expect(html).toContain(CONTROL);
		expect(html).toContain(`data-vapid-key="${AS_PUBLIC}"`);
		expect(html).toContain(PUSH_MODULE);
	});

	it("while the import is read, with no keys: no control and no push.js", async () => {
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const html = await page(family);
		expect(html).not.toContain("data-notify");
		expect(html).not.toContain(PUSH_MODULE);
	});

	it("before a bank, with the keys: push.js loads for a bank linked on this page, but no control yet", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const html = await page(pushing);
		expect(html).toContain(PUSH_MODULE);
		expect(html).not.toContain(CONTROL);
	});

	it("once the questions are open, with the keys: neither the control nor push.js", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		await writeRecord({
			strokes: { bank: todayIn(DEFAULT_TIME_ZONE) },
			budgets: {},
		});
		const html = await page(pushing);
		expect(html).toContain("Set up your budget");
		expect(html).not.toContain("data-notify");
		expect(html).not.toContain(PUSH_MODULE);
	});

	it("in the demo, never: no control and no push.js", async () => {
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const html = await page(demo);
		expect(html).not.toContain("data-notify");
		expect(html).not.toContain(PUSH_MODULE);
	});

	it("keeps Plaid Link's module alongside push.js on a page that loads both (before a bank, Plaid on)", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const html = await page({
			...pushing,
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		} as unknown as Env);
		expect(html).toContain('src="/js/plaid-link.js"');
		expect(html).toContain(PUSH_MODULE);
	});
});

describe("the check-in's redraw draws the control too", () => {
	it("draws it when the page asks for the questions and the server is still reading, with the keys", async () => {
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const response = await checkIn(pushing, "ready");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(CONTROL);
	});

	it("draws none with no keys", async () => {
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const response = await checkIn(family, "ready");
		expect(await response.text()).not.toContain("data-notify");
	});
});
