import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { encryptToken } from "../src/plaid/token-crypto";
import { accounts } from "../src/routes/accounts";
import { home } from "../src/routes/home";
import { setupRoute } from "../src/routes/setup";
import { sameOrigin } from "../src/security";

// Setup on its own pages (P142 A, decision 148, spec §8.8), through the routes: the welcome before a bank, Reading your bank after
// one, the redirects that send a family to them and back to Home, the daily run's wait (decision 150), the Your banks poll and the
// presence check-in (decisions 146 and 151).

const TODAY = "2026-10-14";
/** Noon on TODAY, in UTC: the clock the sort's times are read against, in summer time for the zones below. */
const NOW = Date.parse("2026-10-14T12:00:00Z");
const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;
const plaidFamily = {
	...family,
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;
// RFC 8292's VAPID pair from Appendix A: a valid P-256 pair, so the route's key check passes.
const VAPID = {
	...family,
	VAPID_PUBLIC_KEY:
		"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
} as unknown as Env;
const PERSON = "person@example.com";
/** The presence check-in is a form post behind the same-origin guard and the signed-in member, as src/index.tsx mounts it. */
const seen = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
seen.use("*", sameOrigin);
seen.use("*", async (c, next) => {
	c.set("actor", PERSON);
	await next();
});
seen.route("/", home);
const PLAID_MODULE = 'src="/js/plaid-link.js"';
const PLAID_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

/** The setup page's text, with HTML's entities back as the characters a reader sees. */
const readable = (html: string) =>
	html
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");

const setup = async (bindings: Env, path = "/setup", init?: RequestInit) => {
	const res = await setupRoute.request(path, init ?? {}, bindings);
	return { res, html: readable(await res.text()) };
};
const homePage = async (bindings: Env, path = "/", init?: RequestInit) => {
	const res = await home.request(path, init ?? {}, bindings);
	return { res, html: readable(await res.text()) };
};

const writeRecord = (value: unknown) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(JSON.stringify(value))
		.run();

/** Every connected bank's history is in, and something waits for Jev (rows a bank brought in): the import is sorting. */
const sortingAndHistoryIn = async () => {
	await env.DB.prepare(
		"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = ?, history_complete_at = ?",
	)
		.bind(TODAY, TODAY)
		.run();
	await env.DB.prepare(
		"UPDATE transactions SET plaid_transaction_id = 'plaid-' || id WHERE plaid_transaction_id IS NULL",
	).run();
};

/** Only the first connected bank stays, still reading its history (not yet in). */
const readingOneBank = async () => {
	await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
	await env.DB.prepare(
		"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
	).run();
	await env.DB.prepare(
		"UPDATE plaid_items SET last_synced_at = NULL, history_complete_at = NULL",
	).run();
};

const noBank = () =>
	env.DB.prepare(
		"UPDATE plaid_items SET disconnected_at = datetime('now')",
	).run();

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	await resetDemo(env.DB, TODAY);
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = 'first_tally'",
	).run();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GET /setup: the family app only", () => {
	it("is not found in the demo, which has no setup", async () => {
		const { res } = await setup(demo);
		expect(res.status).toBe(404);
	});
});

describe("GET /setup before a bank: the welcome", () => {
	it("says Welcome to Tally, with the four steps and Link your bank at the foot, pointed at this screen", async () => {
		await noBank();
		const { res, html } = await setup(plaidFamily);
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Setup · Tally</title>");
		expect(html).toContain("Welcome to Tally.");
		expect(html).toContain("Link your bank");
		expect(html).toContain('data-link-bank-refresh="/setup"');
		expect(html).toContain('data-link-bank-target="#setup-screen"');
		expect(html).toContain("Your bills");
		expect(html).toContain("Four steps, about four minutes of your time.");
	});

	it("draws no tab bar and no sidebar, and keeps the Feedback pill in the top line", async () => {
		await noBank();
		const { html } = await setup(plaidFamily);
		expect(html).not.toContain('aria-label="Tabs"');
		expect(html).not.toContain('aria-label="Main"');
		expect(html).not.toContain("<aside");
		expect(html).toMatch(/<div id="top-line"[\s\S]*?href="\/feedback"/);
	});

	it("loads Plaid Link only with Plaid on, and only then does its CSP host come with it", async () => {
		await noBank();
		const on = await setup(plaidFamily);
		expect(on.html).toContain(PLAID_MODULE);
		expect(on.html).toContain(PLAID_SCRIPT);
		const off = await setup(family);
		expect(off.html).not.toContain(PLAID_MODULE);
		expect(off.html).not.toContain(PLAID_SCRIPT);
		expect(off.html).not.toContain("data-link-bank");
	});
});

describe("GET /setup after a bank: Reading your bank", () => {
	beforeEach(async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
	});

	it("reads Reading your bank, with the step bar's words and the status", async () => {
		const { html } = await setup(plaidFamily);
		expect(html).toContain("<title>Setup · Tally</title>");
		expect(html).toContain("Step 1 of 4 done · Reading your bank");
		expect(html).toContain("Tally's reading your last 90 days from ");
		expect(html).toContain("Your banks");
		expect(html).toContain("Link another bank");
	});

	it("polls the Your banks list at /setup/banks, and checks in with its step", async () => {
		const { html } = await setup(plaidFamily);
		expect(html).toContain('hx-get="/setup/banks?in=');
		expect(html).toContain('id="home-seen"');
		expect(html).toContain('"step":"reading"');
	});

	it("draws Notify me and loads push.js only with the Web Push keys", async () => {
		const withKeys = await setup(VAPID);
		expect(withKeys.html).toContain("/js/push.js");
		const without = await setup(family);
		expect(without.html).not.toContain("/js/push.js");
	});

	it("draws the questions for a family whose questions are open, and sends one with them answered Home", async () => {
		await sortingAndHistoryIn();
		await env.DB.prepare(
			"UPDATE transactions SET category_confidence = 0.95, category_source = 'jev' WHERE plaid_transaction_id IS NOT NULL",
		).run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const ready = await setup(family);
		expect(ready.res.status).toBe(200);
		expect(ready.html).toContain('id="setup-screen"');
		expect(ready.html).toMatch(/Step \d of 4/);
		await writeRecord({
			strokes: {
				bank: TODAY,
				pay: TODAY,
				bills: TODAY,
				budgets: TODAY,
			},
			budgets: {},
		});
		const answered = await setup(family);
		expect(answered.res.status).toBe(303);
		expect(answered.res.headers.get("location")).toBe("/");
	});
});

describe("the daily run's wait (decision 150) on the reading screen", () => {
	beforeEach(async () => {
		await sortingAndHistoryIn();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		await saveAiSwitches(env.DB, { sortOnArrival: false });
	});

	it("says the daily run's hour in New York's summer time, with no bar and no count", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('time_zone', 'America/New_York') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run();
		const { html } = await setup(family);
		expect(html).toContain(
			"Tally sorts your last 90 days in its daily run, at about 5 AM, as set in Settings.",
		);
		expect(html).not.toContain("taking longer than usual");
		expect(html).not.toContain('id="setup-progress"><svg');
		expect(html).toContain("Your three questions open once they're sorted.");
	});

	it("says 10 AM in London in summer, and checks in with the run's step", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('time_zone', 'Europe/London') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		).run();
		const { html } = await setup(family);
		expect(html).toContain("at about 10 AM, as set in Settings.");
		expect(html).toContain('"step":"run"');
	});

	it("never says taking longer than usual, even with the history two hours old", async () => {
		// Two hours before the pinned NOW (SQLite's clock is not the faked Date, so the time is written out).
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = '2026-10-14 10:00:00'",
		).run();
		const { html } = await setup(family);
		expect(html).toContain("in its daily run");
		expect(html).not.toContain("taking longer than usual");
	});

	it("keeps the run's words with the switch back on, while the record's mark is set", async () => {
		await saveAiSwitches(env.DB, { sortOnArrival: true });
		expect(readable((await setup(family)).html)).not.toContain(
			"in its daily run",
		);
		await env.DB.prepare(
			"UPDATE household_settings SET value = json_set(value, '$.waitsForRun', json('true')) WHERE key = 'first_tally'",
		).run();
		const { html } = await setup(family);
		expect(html).toContain("in its daily run, at about 5 AM");
	});
});

describe("GET /setup/banks: the Your banks poll", () => {
	beforeEach(async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
	});

	it("answers 204 with no body in the demo, which draws no setup to poll for", async () => {
		const res = await setupRoute.request("/setup/banks", {}, demo);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	});

	it("announces a bank that came in once, and not again on the next poll that names it", async () => {
		// The history is in and something still waits, so the phase is still reading (not the questions).
		await sortingAndHistoryIn();
		const first = await setup(family, "/setup/banks?in=");
		// The announce is in the HX-Trigger header, not the body: the list is the body.
		expect(first.res.headers.get("HX-Trigger")).toContain("is in:");
		const shown = await setup(family, "/setup/banks?in=1,2,3");
		expect(shown.res.headers.get("HX-Trigger")).toBeNull();
	});

	it("announces a step change once, with the new status: sorting to the daily run's wait", async () => {
		await sortingAndHistoryIn();
		await saveAiSwitches(env.DB, { sortOnArrival: false });
		const { res, html } = await setup(family, "/setup/banks?step=sorting");
		expect(res.status).toBe(200);
		expect(html).toContain("in its daily run, at about 5 AM");
		expect(res.headers.get("HX-Trigger")).toContain("in its daily run");
		expect(html).toContain('id="home-seen"');
		expect(html).toContain('"step":"run"');
	});

	it("draws the first question in place once they open, and sends Home once they are answered", async () => {
		await sortingAndHistoryIn();
		await env.DB.prepare(
			"UPDATE transactions SET category_confidence = 0.95, category_source = 'jev' WHERE plaid_transaction_id IS NOT NULL",
		).run();
		const ready = await setupRoute.request(
			"/setup/banks?step=reading",
			{},
			family,
		);
		expect(ready.status).toBe(200);
		expect(ready.headers.get("HX-Retarget")).toBe("#setup-screen");
		expect(ready.headers.get("HX-Reswap")).toBe("outerHTML");
		expect(ready.headers.get("HX-Trigger")).toContain(
			"Your questions are ready.",
		);
		const drawn = await ready.text();
		expect(drawn).toContain('id="setup-screen"');
		expect(drawn).toMatch(/<h1\b[^>]*\sautofocus/);
		await writeRecord({
			strokes: { bank: TODAY, pay: TODAY, bills: TODAY, budgets: TODAY },
			budgets: {},
		});
		const answered = await setupRoute.request("/setup/banks", {}, family);
		expect(answered.headers.get("HX-Redirect")).toBe("/");
	});

	it("redraws #setup-screen with the welcome once the last bank goes before setup is done", async () => {
		await noBank();
		const { res, html } = await setup(plaidFamily, "/setup/banks?step=reading");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Retarget")).toBe("#setup-screen");
		expect(res.headers.get("HX-Reswap")).toBe("outerHTML");
		expect(html).toContain("Welcome to Tally.");
		expect(html).toContain('id="setup-screen"');
		expect(html).toContain('data-link-bank-refresh="/setup"');
	});
});

describe("POST /home/seen with a step (the presence check-in, decisions 146 and 151)", () => {
	const checkIn = async (bindings: Env, step?: string) => {
		const res = await seen.request(
			"/home/seen",
			{
				method: "POST",
				headers: {
					Origin: "http://localhost",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: step === undefined ? "" : new URLSearchParams({ step }),
			},
			bindings,
		);
		return { res };
	};

	beforeEach(async () => {
		await sortingAndHistoryIn();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		await saveAiSwitches(env.DB, { sortOnArrival: false });
	});

	it("answers 204 while the daily run's wait holds, at the step the page shows", async () => {
		const { res } = await checkIn(family, "run");
		expect(res.status).toBe(204);
	});

	it("draws the first question in place once the run has sorted them", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_confidence = 0.95, category_source = 'jev' WHERE plaid_transaction_id IS NOT NULL",
		).run();
		const { res } = await checkIn(family, "run");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Retarget")).toBe("#setup-screen");
		expect(await res.text()).toContain('id="setup-screen"');
	});

	it("answers 204 for no step at all, whatever the setup", async () => {
		expect((await checkIn(family)).res.status).toBe(204);
		expect((await checkIn(demo, "run")).res.status).toBe(204);
	});
});

describe("GET / in the family app: setup sends a new family to /setup (decision 148)", () => {
	const ANSWERED = {
		strokes: { bank: TODAY, pay: TODAY, bills: TODAY, budgets: TODAY },
		budgets: {},
	};

	it("sends a family before a bank to /setup, with 303", async () => {
		await noBank();
		await writeRecord({ strokes: {}, budgets: {} });
		const { res } = await homePage(family, "/");
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/setup");
	});

	it("sends a family whose import is being read to /setup", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { res } = await homePage(family, "/");
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/setup");
	});

	it("sends a family whose questions are open to /setup, which moves on to the questions", async () => {
		await sortingAndHistoryIn();
		await env.DB.prepare(
			"UPDATE transactions SET category_confidence = 0.95, category_source = 'jev' WHERE plaid_transaction_id IS NOT NULL",
		).run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { res } = await homePage(family, "/");
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/setup");
	});

	it("answers an htmx request with HX-Redirect to /setup, not a 303", async () => {
		await noBank();
		await writeRecord({ strokes: {}, budgets: {} });
		const { res } = await homePage(family, "/", {
			headers: { "HX-Request": "true" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Redirect")).toBe("/setup");
	});

	it("does not send an earlier month, which is Home's own", async () => {
		await noBank();
		await writeRecord({ strokes: {}, budgets: {} });
		const { res } = await homePage(family, "/?month=2026-09");
		expect(res.status).toBe(200);
		expect(res.headers.get("location")).toBeNull();
	});

	it("draws today's answered top, with the status and no redirect, once the questions are answered", async () => {
		await sortingAndHistoryIn();
		await writeRecord(ANSWERED);
		const { res, html } = await homePage(family, "/");
		expect(res.status).toBe(200);
		expect(html).toContain('id="setup-top"');
		expect(html).toContain("Four.");
	});

	it("is Home in the demo, with no redirect and no setup", async () => {
		const { res, html } = await homePage(demo, "/");
		expect(res.status).toBe(200);
		expect(res.headers.get("location")).toBeNull();
		expect(html).not.toContain('id="setup-top"');
		expect(html).not.toContain("Welcome to Tally.");
	});
});

describe("the reading screen, moved from Home's setup (#772, decision 148)", () => {
	const EMAIL_LINE =
		"You can close this page. Tally emails you the moment your questions are ready.";
	const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

	it("loads Plaid Link with Link another bank at the foot, with Plaid on, and never Have more accounts? on Home", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { html } = await setup(plaidFamily);
		expect(html).toContain(PLAID_MODULE);
		expect(html).toContain('data-link-bank-target="#setup-screen"');
		expect(html).toContain('data-link-bank-refresh="/setup"');
		expect(html).not.toContain("Have more accounts?");
		const at = (text: string) => html.indexOf(text);
		expect(at("Your banks")).toBeLessThan(at("Link another bank"));
	});

	it("with Plaid off, lists Your banks and has no link button and no Plaid Link", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { html } = await setup(family);
		expect(html).toContain("Your banks");
		expect(html).not.toContain("Link another bank");
		expect(html).not.toContain(PLAID_MODULE);
	});

	it("marks the Your banks poll and the check-in, so a Plaid Link window pauses them (decision 146)", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { html } = await setup(plaidFamily);
		expect(openingTag(html, "your-banks")).toContain("data-waits-for-link");
		expect(openingTag(html, "home-seen")).toContain("data-waits-for-link");
	});

	it("says Tally emails you once the reading screen shows, until the ready email has reached someone", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		expect((await setup(family)).html).toContain(EMAIL_LINE);
		await writeRecord({
			strokes: { bank: TODAY },
			budgets: {},
			readyEmailedTo: ["dana@example.com"],
		});
		expect((await setup(family)).html).not.toContain(EMAIL_LINE);
	});

	it("names the bank once, and with two connected banks names neither", async () => {
		await readingOneBank();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const one = await setup(family);
		expect(one.html).toContain("Tally's reading your last 90 days from ");
		expect(one.html).not.toContain("from 2 banks");
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const two = await setup(family);
		expect(two.html).toContain(
			"Tally's reading your last 90 days from 2 banks.",
		);
		expect(two.html).not.toContain("from First Harbor Bank");
		expect(two.html).not.toContain("from Northline Card Services");
	});

	it("says the sort is under way and counts it, once one bank's history is in and transactions wait", async () => {
		await readingOneBank();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-route', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = '2026-10-14 11:59:00', last_synced_at = ?",
		)
			.bind(TODAY)
			.run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const { html } = await setup(family);
		expect(html).toContain("Sorting your last 90 days:");
		expect(html).toContain(
			"Your three questions open the moment it's done, usually in a few minutes.",
		);
		expect(html).not.toContain("by the morning");
	});

	it("gives a connected bank with no stroke one its stroke one today, and reads the import", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const { html } = await setup(family);
		expect(html).toContain("Reading your bank");
		const stored = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(JSON.parse(stored?.value ?? "null")?.strokes.bank).toBe(TODAY);
	});

	it("puts a bank that stopped updating on its line under the status", async () => {
		await readingOneBank();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = '2026-10-04' WHERE disconnected_at IS NULL",
		).run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		expect((await setup(family)).html).toContain("stopped updating");
	});

	/**
	 * Every bank's history came in two hours before the pinned NOW, all banks are synced, and one transaction still waits for Jev.
	 * With `signIn`, the first bank needs signing in.
	 */
	const slowHousehold = async ({ signIn }: { signIn: boolean }) => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'ok', last_synced_at = ?, history_complete_at = '2026-10-14 10:00:00'",
		)
			.bind(TODAY)
			.run();
		if (signIn)
			await env.DB.prepare(
				"UPDATE plaid_items SET status = 'needs_attention' WHERE id = (SELECT MIN(id) FROM plaid_items)",
			).run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-slow', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
	};

	it("a bank that needs signing in while Tally sorts shows its line and Fix, and the slow line leaves out 'Nothing for you to do'", async () => {
		await slowHousehold({ signIn: true });
		const { html } = await setup(family);
		expect(html).toContain("Sorting is taking longer than usual:");
		expect(html).toContain("Tally keeps trying on its own.");
		expect(html).toContain("needs signing in");
		expect(html).toContain('href="/accounts"');
		expect(html).not.toContain("Nothing for you to do.");
	});

	it("the slow line says 'Nothing for you to do.' when no bank needs a fix", async () => {
		await slowHousehold({ signIn: false });
		const { html } = await setup(family);
		expect(html).toContain("Sorting is taking longer than usual:");
		expect(html).toContain(
			"Tally keeps trying on its own. Nothing for you to do.",
		);
		expect(html).not.toContain("needs signing in");
	});

	it("a recent bank still loading that needs signing in does not poll Your banks, and the page does not say it updates (decision 146)", async () => {
		await readingOneBank();
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = NULL, status = 'needs_attention', created_at = '2026-10-14 11:50:00'",
		).run();
		await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
		const flagged = (await setup(family)).html;
		expect(flagged).toContain("needs signing in");
		expect(flagged).toContain("Tally's reading your last 90 days from");
		expect(flagged).not.toContain('hx-get="/setup/banks');
		expect(flagged).not.toContain("This page updates as it goes");
		// The control: the same bank, healthy, polls and says so.
		await env.DB.prepare("UPDATE plaid_items SET status = 'ok'").run();
		const healthy = (await setup(family)).html;
		expect(healthy).toContain('hx-get="/setup/banks');
		expect(healthy).toContain("This page updates as it goes");
	});

	it("disconnecting the last connected bank before setup is done takes strokes one to four back, and /setup shows the welcome again", async () => {
		const bank = await env.DB.prepare(
			"SELECT MIN(id) AS id FROM plaid_items",
		).first<{ id: number }>();
		const id = bank?.id ?? 0;
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL WHERE id = ?",
		)
			.bind(id)
			.run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != ?",
		)
			.bind(id)
			.run();
		await env.DB.prepare(
			"UPDATE plaid_items SET access_token_encrypted = ? WHERE id = ?",
		)
			.bind(await encryptToken("route-access-token", KEY), id)
			.run();
		await writeRecord({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: {},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const response = await accounts.request(
			`/accounts/${id}/disconnect`,
			{
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
				body: "",
			},
			plaidFamily,
		);
		vi.unstubAllGlobals();
		expect(response.status).toBeLessThan(400);
		const stored = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(JSON.parse(stored?.value ?? "null")).toEqual({
			strokes: {},
			budgets: {},
		});
		const { html } = await setup(plaidFamily);
		expect(html).toContain("Welcome to Tally.");
		expect(html).toContain("Link your bank");
		expect(html).toContain(PLAID_MODULE);
	});
});

/** The first tag with this id, as the page draws it. */
function openingTag(html: string, id: string) {
	return html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`))?.[0] ?? "";
}
