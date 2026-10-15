import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { encryptToken } from "../src/plaid/token-crypto";
import { accounts } from "../src/routes/accounts";
import { home } from "../src/routes/home";

// Home during a new family's first week (P125 E, spec §8.8), through the route: the family app only, Link a bank with
// Plaid Link on Home, and the reading line once a bank is linked.
const family = { ...env, DEMO: "false" } as unknown as Env;
const plaidFamily = {
	...family,
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
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

describe("Home during setup", () => {
	it("before a bank, with Plaid on: the headline, Link a bank with its redraw targets, and Plaid Link on Home", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const html = await page(plaidFamily);
		expect(html).toContain("Five strokes, and you're set up.");
		expect(html).toContain("Link a bank");
		expect(html).toContain(">About a minute<");
		expect(html).not.toContain(">Next<");
		expect(html).toContain('data-link-bank-refresh="/"');
		expect(html).toContain('data-link-bank-target="#page"');
		expect(html).toContain(PLAID_MODULE);
		expect(html).toContain(
			"https://cdn.plaid.com/link/v2/stable/link-initialize.js",
		);
		expect(html).not.toContain("Safe to spend");
	});

	it("before a bank, with Plaid off: no button and no Plaid Link", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const html = await page(family);
		expect(html).toContain("Five strokes, and you're set up.");
		expect(html).not.toContain("Link a bank");
		expect(html).not.toContain(PLAID_MODULE);
	});

	it("loads Plaid Link on Home only while no bank is linked", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await writeRecord({ strokes: { bank: "2026-10-13" }, budgets: {} });
		expect(await page(plaidFamily)).not.toContain(PLAID_MODULE);
	});

	it("the demo never shows setup, even with no first_tally record", async () => {
		const html = await page({ ...env, DEMO: "true" } as unknown as Env);
		expect(html).not.toContain("Five strokes");
		expect(html).not.toContain("Your first week");
	});

	it("a household with all five strokes drawn shows Home as it is", async () => {
		await writeRecord({
			strokes: {
				bank: null,
				pay: null,
				bills: null,
				budgets: null,
				count: null,
			},
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain("Safe to spend");
		expect(html).not.toContain("Five strokes");
	});

	it("once a bank is linked, reads the import while the questions are shut, and names the bank", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
		).run();
		const bank = await env.DB.prepare(
			"SELECT institution_name AS name FROM plaid_items WHERE disconnected_at IS NULL",
		).first<{ name: string }>();
		// Stroke one drawn today: the questions open tomorrow at the earliest.
		const today = todayIn(DEFAULT_TIME_ZONE);
		await writeRecord({ strokes: { bank: today }, budgets: {} });
		const html = await page(family);
		expect(html).toContain("Your first week");
		expect(html).toContain(`from ${bank?.name}. Your questions will be ready`);
		expect(html).toContain("Nothing for you to do until then.");
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain("Link a bank");
	});

	it("with two connected banks, reads the import and names neither", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await writeRecord({
			strokes: { bank: todayIn(DEFAULT_TIME_ZONE) },
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain("Tally's reading your last 90 days.");
		expect(html).not.toContain("from First Harbor Bank");
		expect(html).not.toContain("from Northline Card Services");
	});

	it("with one bank's history in, says the questions come by the morning", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id != (SELECT MIN(id) FROM plaid_items)",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		await writeRecord({
			strokes: { bank: todayIn(DEFAULT_TIME_ZONE) },
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain(
			"Your questions will usually be ready by the morning.",
		);
		expect(html).not.toContain("When it's done");
	});

	it("four strokes drawn: the ruled total, and no three things to check", async () => {
		await writeRecord({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
			},
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain('href="/first-page"');
	});

	it("a connected bank with no stroke one gets it today, and Home reads the import", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		const html = await page(family);
		expect(html).toContain("Your first week");
		expect(html).toContain("Nothing for you to do until then.");
		const stored = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(JSON.parse(stored?.value ?? "null")?.strokes.bank).toBe(
			todayIn(DEFAULT_TIME_ZONE),
		);
	});

	it("a bank that stopped updating during setup shows its line under the status", async () => {
		await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = datetime('now', '-10 days')",
		).run();
		await writeRecord({
			strokes: { bank: todayIn(DEFAULT_TIME_ZONE) },
			budgets: {},
		});
		const html = await page(family);
		expect(html).toContain("Your first week");
		expect(html).toContain("stopped updating");
	});

	it("disconnecting the last connected bank before setup is done takes strokes one to four back, and Home offers Link a bank again", async () => {
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

		const html = await page(plaidFamily);
		expect(html).toContain("Five strokes, and you're set up.");
		expect(html).toContain("Link a bank");
		expect(html).toContain(PLAID_MODULE);
	});
});
