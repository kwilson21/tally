import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { destinations } from "../src/routes/destinations";

// More as a contents page (P122 A, decision 111): the live folios come from the same reads Accounts
// and Settings make, so the three pages can't disagree.
const BASE = "http://tally.test";
const family = { ...env, DEMO: "false" };
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
/** More with the family app's bindings, or with `overrides` on top of them. */
const moreIn = async (overrides: Record<string, unknown> = {}) =>
	(
		await destinations.request("/more", {}, {
			...family,
			...overrides,
		} as unknown as Env)
	).text();

/** The ruled list of places, without the rest of the page. */
const listOf = (html: string) =>
	html.match(/<ul class="mt-6 divide-y[\s\S]*?<\/ul>/)?.[0] ?? "";
/** Each place's accessible name, in the order the page lists them (apostrophes unescaped). */
const namesOf = (html: string) =>
	[...listOf(html).matchAll(/<a [^>]*aria-label="([^"]*)"/g)].map((m) =>
		(m[1] ?? "").replaceAll("&#39;", "'"),
	);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("GET /more in the demo", () => {
	it("lists Accounts, Settings and How Tally works in that order, with the demo's words for How Tally works", async () => {
		const names = namesOf((await get("/more")).html);
		expect(names).toHaveLength(3);
		expect(names[0]).toMatch(/^Accounts, \d+ accounts?, Balances/);
		expect(names[1]).toMatch(/^Settings, /);
		expect(names[2]).toBe(
			"How Tally works, What each number means, with the Riveras' numbers",
		);
	});

	it("counts the demo's accounts as Accounts lists them: 3 in two banks", async () => {
		expect(namesOf((await get("/more")).html)[0]).toBe(
			"Accounts, 3 accounts, Balances, net worth and your banks",
		);
	});

	it("shows Settings' count of suggestions to check, the same number as Settings' Band", async () => {
		const settings = (await get("/settings")).html;
		const band = settings.match(/(\d+) suggestions? to check/)?.[1];
		expect(band).toBeDefined();
		expect(namesOf((await get("/more")).html)[1]).toBe(
			`Settings, ${band} to check, Categories, rules, your household and your data`,
		);
	});

	it("shows no to-check count when Settings has no Band", async () => {
		// Every suggestion is about a transaction, so with none left the queue is empty.
		await env.DB.prepare("DELETE FROM transactions").run();
		const settings = (await get("/settings")).html;
		expect(settings).not.toMatch(/suggestions? to check/);
		expect(namesOf((await get("/more")).html)[1]).toBe(
			"Settings, Categories, rules, your household and your data",
		);
	});

	it("draws the demo's colophon, whatever the version", async () => {
		const html = await moreIn({ DEMO: "true", APP_VERSION: "demo 9e5e14d" });
		expect(html).toContain("Tally demo · resets every night");
		expect(html).not.toContain("9e5e14d");
	});
});

describe("GET /more in the family app", () => {
	it("counts only the connected banks' accounts, so a disconnected bank is left out, in the singular", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE institution_name = 'First Harbor Bank'",
		).run();
		expect(namesOf(await moreIn())[0]).toBe(
			"Accounts, 1 account, Balances, net worth and your banks",
		);
	});

	it("says Needs attention when a bank needs signing in, in place of the count", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE institution_name = 'Northline Card Services'",
		).run();
		const html = await moreIn();
		expect(namesOf(html)[0]).toBe(
			"Accounts, Needs attention, Balances, net worth and your banks",
		);
		expect(listOf(html)).toContain('data-icon="alert"');
	});

	it("says None linked yet before any bank is linked", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		expect(namesOf(await moreIn())[0]).toBe(
			"Accounts, None linked yet, Balances, net worth and your banks",
		);
	});

	it("names the deploy's release and commit in the colophon", async () => {
		const html = await moreIn({ APP_VERSION: "v2026.10.12 9e5e14d" });
		expect(html).toContain("Tally v2026.10.12 · 9e5e14d");
		expect(namesOf(html)[2]).toBe(
			"How Tally works, What each number means, with your numbers",
		);
	});

	it("leaves the colophon out when no version is set", async () => {
		const html = await moreIn({ APP_VERSION: undefined });
		expect(html).not.toContain("resets every night");
		expect(html).not.toContain("Tally v");
	});
});
