import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// Home once a new family's setup is done (spec §8.8, decision 148): setup is done at the budgets stroke, and from then on Home
// is plain Home. Before that, a family's setup is on its own pages (/setup, setup-route.test.ts), and Home sends them there.
// Home loads no Plaid Link: it has no Link a bank any more.
const family = { ...env, DEMO: "false" } as unknown as Env;
const plaidFamily = {
	...family,
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;
const PLAID_MODULE = 'src="/js/plaid-link.js"';

const page = async (bindings: Env) => {
	const res = await home.request("/", {}, bindings);
	return (await res.text()).replaceAll("&#39;", "'");
};
const writeRecord = (value: unknown) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(JSON.stringify(value))
		.run();

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = 'first_tally'",
	).run();
});

/** Setup done (decision 148): the budgets stroke is drawn, with each step's day. */
const SET_UP = {
	strokes: {
		bank: "2026-10-13",
		pay: "2026-10-13",
		bills: "2026-10-13",
		budgets: "2026-10-13",
	},
	budgets: {},
};

describe("Home once setup is done, and the demo", () => {
	it("with the budgets stroke drawn, Home is plain Home: no setup top and no status line", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = datetime('now'), history_complete_at = datetime('now') WHERE disconnected_at IS NULL",
		).run();
		await writeRecord(SET_UP);
		const html = await page(family);
		expect(html).toContain("Safe to spend");
		expect(html).not.toContain('id="setup-top"');
		expect(html).not.toContain("Four.");
		expect(html).not.toContain("Tomorrow Tally keeps count");
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain('href="/first-page"');
	});

	it("is Home with no Your banks and no Have more accounts? once setup is done", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = datetime('now'), history_complete_at = datetime('now')",
		).run();
		await writeRecord(SET_UP);
		const html = await page(plaidFamily);
		expect(html).toContain("Safe to spend");
		expect(html).not.toContain("Your banks");
		expect(html).not.toContain("Have more accounts?");
		expect(html).not.toContain(PLAID_MODULE);
	});

	it("a bank linked after setup, its history still coming in, brings no setup back", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = NULL, history_complete_at = NULL",
		).run();
		await writeRecord(SET_UP);
		const res = await home.request("/", {}, family);
		expect(res.status).toBe(200);
		expect(res.headers.get("location")).toBeNull();
		const html = (await res.text()).replaceAll("&#39;", "'");
		expect(html).toContain("Safe to spend");
		expect(html).not.toContain('id="setup-top"');
	});

	it("the demo never shows setup, even with no first_tally record", async () => {
		const html = await page({ ...env, DEMO: "true" } as unknown as Env);
		expect(html).not.toContain("Five strokes");
		expect(html).not.toContain("Your first week");
		expect(html).not.toContain('id="setup-top"');
	});

	it("a household with all four strokes drawn and no days shows Home as it is", async () => {
		await writeRecord({
			strokes: { bank: null, pay: null, bills: null, budgets: null },
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain("Safe to spend");
		expect(html).not.toContain('id="setup-top"');
	});
});

describe("Home's sheets and Home itself load no Plaid (#678, decision 148)", () => {
	const answeredHome = async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = datetime('now'), history_complete_at = datetime('now')",
		).run();
		await writeRecord({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: {},
		});
	};
	const firstCategory = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM categories ORDER BY id LIMIT 1",
			).first<{
				id: number;
			}>()
		)?.id ?? 1;

	it.each([
		["/", (_id: number) => "/"],
		["/savings-goal", (_id: number) => "/savings-goal"],
		["/budget/:id", (id: number) => `/budget/${id}`],
	])(
		"a full load of %s loads no Plaid Link, with Plaid on, and links no bank",
		async (_, pathFor) => {
			await answeredHome();
			const path = pathFor(await firstCategory());
			const html = await (await home.request(path, {}, plaidFamily)).text();
			expect(html).not.toContain(PLAID_MODULE);
			expect(html).not.toContain("data-link-bank");
			expect(html).not.toContain("Link a bank");
		},
	);

	it.each([
		["/", (_id: number) => "/"],
		["/savings-goal", (_id: number) => "/savings-goal"],
		["/budget/:id", (id: number) => `/budget/${id}`],
	])(
		"an htmx request for %s draws no Link a bank and no Plaid script",
		async (_, pathFor) => {
			await answeredHome();
			const path = pathFor(await firstCategory());
			const html = await (
				await home.request(
					path,
					{ headers: { "HX-Request": "true" } },
					plaidFamily,
				)
			).text();
			expect(html).not.toContain("Link a bank");
			expect(html).not.toContain(PLAID_MODULE);
		},
	);
});

// Home's own routes are setup's until the questions are answered (decision 148, #772): a stale Home page's save or sheet sends
// the family to /setup, with no write, toast or 422 of its own. Set-up households and the demo are Home's.
describe("Home's routes are setup's until setup is done (decision 148, #772)", () => {
	const today = () => todayIn(DEFAULT_TIME_ZONE);
	const ORIGIN = "http://localhost";

	/** One bank connected, its history not in: the reading phase. */
	const readingOneBank = async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = NULL, history_complete_at = NULL",
		).run();
	};
	/** Every connected bank's history is in and nothing waits for Jev: the questions are open (the ready phase). */
	const historyInAndSorted = async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = datetime('now'), history_complete_at = datetime('now')",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET plaid_transaction_id = 'plaid-' || id WHERE plaid_transaction_id IS NULL",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET category_confidence = 0.95, category_source = 'jev' WHERE plaid_transaction_id IS NOT NULL",
		).run();
	};
	/** Every bank disconnected: the before phase. */
	const noBank = async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
	};
	/** The first category's id: the budget routes' :id. */
	const firstCategory = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM categories ORDER BY id LIMIT 1",
			).first<{
				id: number;
			}>()
		)?.id ?? 1;
	/** The rows a save writes, so a save that goes to setup can be seen to write nothing. */
	const savedRows = async () =>
		JSON.stringify([
			(
				await env.DB.prepare(
					"SELECT * FROM budget_amounts ORDER BY category_id, effective_month",
				).all()
			).results,
			(
				await env.DB.prepare(
					"SELECT * FROM savings_goal_amounts ORDER BY effective_month",
				).all()
			).results,
		]);
	/** A save as the Home sheets and the nudge send it: htmx, form-encoded, from this origin. */
	const save = (
		path: string,
		fields: Record<string, string>,
		bindings: Env = family,
	) =>
		home.request(
			path,
			{
				method: "POST",
				headers: {
					Origin: ORIGIN,
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
				body: new URLSearchParams(fields).toString(),
			},
			bindings,
		);
	/** Setup done on `day`: all four strokes drawn, with no budget answers kept. */
	const answeredOn = (day: string) => ({
		strokes: { bank: day, pay: day, bills: day, budgets: day },
		budgets: {},
	});

	describe("while reading (the bank's history is coming in)", () => {
		beforeEach(async () => {
			await readingOneBank();
			await writeRecord({ strokes: { bank: today() }, budgets: {} });
		});

		it("GET /budget/:id is 303 to /setup", async () => {
			const res = await home.request(
				`/budget/${await firstCategory()}`,
				{},
				family,
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/setup");
		});

		it("an htmx GET /budget/:id answers 204 with HX-Redirect to /setup", async () => {
			const res = await home.request(
				`/budget/${await firstCategory()}`,
				{ headers: { "HX-Request": "true" } },
				family,
			);
			expect(res.status).toBe(204);
			expect(res.headers.get("HX-Redirect")).toBe("/setup");
		});

		it("GET /savings-goal is 303 to /setup", async () => {
			const res = await home.request("/savings-goal", {}, family);
			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/setup");
		});

		it.each([
			["a budget", (id: number) => `/budget/${id}`, { budget: "650" }],
			["the savings goal", () => "/savings-goal", { goal: "500" }],
			["a nudge up", (id: number) => `/budget/${id}/nudge/up`, {}],
		])(
			"a stale page's save of %s writes nothing and answers HX-Redirect to /setup",
			async (_, pathFor, fields) => {
				const before = await savedRows();
				const res = await save(pathFor(await firstCategory()), fields);
				expect(res.status).toBe(204);
				expect(res.headers.get("HX-Redirect")).toBe("/setup");
				expect(await savedRows()).toBe(before);
			},
		);

		it("a refused amount is never answered 422 while reading", async () => {
			const res = await save(`/budget/${await firstCategory()}`, {
				budget: "12.345",
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("HX-Redirect")).toBe("/setup");
		});
	});

	it("GET /budget/:id before a bank is 303 to /setup", async () => {
		await noBank();
		await writeRecord({ strokes: {}, budgets: {} });
		const res = await home.request(
			`/budget/${await firstCategory()}`,
			{},
			family,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/setup");
	});

	it("GET /budget/:id once the questions are open is 303 to /setup", async () => {
		await historyInAndSorted();
		await writeRecord({ strokes: { bank: today() }, budgets: {} });
		const res = await home.request(
			`/budget/${await firstCategory()}`,
			{},
			family,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/setup");
	});

	describe("not redirected: set up, and the demo", () => {
		it("GET /budget/:id once setup is done draws the sheet as today", async () => {
			await historyInAndSorted();
			await writeRecord(answeredOn(today()));
			const res = await home.request(
				`/budget/${await firstCategory()}`,
				{},
				family,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Location")).toBeNull();
			expect(await res.text()).toContain('role="dialog"');
		});

		it("GET /budget/:id in the demo draws the sheet, whatever the record says", async () => {
			await readingOneBank();
			await writeRecord({ strokes: { bank: today() }, budgets: {} });
			const res = await home.request(`/budget/${await firstCategory()}`, {}, {
				...env,
				DEMO: "true",
			} as unknown as Env);
			expect(res.status).toBe(200);
			expect(res.headers.get("Location")).toBeNull();
			expect(await res.text()).toContain('role="dialog"');
		});

		it("a save once setup is done still saves, and says so", async () => {
			await historyInAndSorted();
			await writeRecord(answeredOn(today()));
			const res = await save(`/budget/${await firstCategory()}`, {
				budget: "650",
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toContain("Saved the");
		});
	});
});
