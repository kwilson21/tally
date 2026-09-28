import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { accountsByBank, netWorthCents } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";

const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
/** The page's text, without markup. */
const textOf = (html: string) =>
	html.replace(/<[^>]+>/g, "").replaceAll("&#39;", "'");

describe("netWorthCents", () => {
	it("adds what you have and subtracts what you owe", () => {
		expect(
			netWorthCents([
				{ balanceCents: 1000, isLiability: false },
				{ balanceCents: 250, isLiability: true },
			]),
		).toBe(750);
	});

	it("is zero with no accounts", () => {
		expect(netWorthCents([])).toBe(0);
	});
});

describe("accountsByBank", () => {
	beforeEach(() => resetDemo(env.DB, todayUtc()));

	it("groups the demo's accounts under their banks, in the order they were linked", async () => {
		const banks = await accountsByBank(env.DB);
		expect(banks.map((b) => b.name)).toEqual([
			"First Harbor Bank",
			"Northline Card Services",
		]);
		expect(banks[0]?.accounts.map((a) => a.name)).toEqual([
			"Checking",
			"Savings",
		]);
		expect(banks[1]?.accounts).toEqual([
			{
				id: 3,
				name: "Credit card",
				mask: "9012",
				type: "credit",
				balanceCents: 84217,
				isLiability: true,
			},
		]);
		expect(banks.every((b) => !b.needsAttention)).toBe(true);
	});

	it("marks a bank whose login needs fixing", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE institution_name = 'Northline Card Services'",
		).run();
		const banks = await accountsByBank(env.DB);
		expect(banks.map((b) => b.needsAttention)).toEqual([false, true]);
	});

	it("keeps a just-linked bank whose accounts haven't synced yet, so it can still be fixed", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (X'00', 'New Bank', 'demo', 'needs_attention')",
		).run();
		const banks = await accountsByBank(env.DB);
		expect(banks.at(-1)).toEqual({
			id: expect.any(Number),
			name: "New Bank",
			needsAttention: true,
			accounts: [],
		});
	});
});

describe("GET /accounts", () => {
	beforeEach(() => resetDemo(env.DB, todayUtc()));

	it("shows net worth in whole dollars, then each bank's accounts with debt negative", async () => {
		const { res, html } = await get("/accounts");
		expect(res.status).toBe(200);
		const text = textOf(html);
		expect(html).toMatch(/<h1[^>]*>Accounts<\/h1>/);
		// $4,210.55 + $12,400.00 − $842.17
		expect(text).toContain("$15,768");
		expect(text).not.toContain("$15,768.38");
		expect(text.indexOf("First Harbor Bank")).toBeLessThan(
			text.indexOf("Northline Card Services"),
		);
		expect(text).toContain("$4,210.55");
		expect(text).toContain("-$842.17");
		expect(html).toContain('<span class="sr-only">ending in </span>');
		expect(text).not.toContain("isn't built yet");
	});

	it("says in words when a bank's login needs fixing", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE institution_name = 'Northline Card Services'",
		).run();
		const text = textOf((await get("/accounts")).html);
		expect(text).toContain("Needs attention: sign in again");
		expect(text.indexOf("Needs attention")).toBeGreaterThan(
			text.indexOf("Northline Card Services"),
		);
	});

	it("shows a linked bank before its first sync, not the no-banks message", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
		]);
		const text = textOf((await get("/accounts")).html);
		expect(text).toContain("First Harbor Bank");
		expect(text).toContain("Accounts appear after the first sync.");
		expect(text).not.toContain("No banks linked yet.");
	});

	it("says no bank is linked yet when there are none", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		const { html } = await get("/accounts");
		const text = textOf(html);
		// Decision 55: no $0 headline before there's anything to add up; the add drawing instead.
		expect(html).toMatch(/<h1[^>]*>Accounts<\/h1>/);
		expect(text).not.toContain("Net worth");
		expect(text).not.toContain("$0");
		expect(text).toContain("No banks linked yet.");
		expect(text).toContain(
			"Link your bank to see balances and net worth here. Tally can only read them; it can't move money.",
		);
		expect(html).toContain('<circle cx="45" cy="44" r="10"');
	});

	it("marks Accounts as the current page", async () => {
		const { html } = await get("/accounts");
		expect(html).toMatch(/href="\/accounts"[^>]*aria-current="page"/);
	});
});

const PLAID_LINK_SCRIPT =
	"https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const plaidEnabled = {
	...env,
	DEMO: "false",
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;

describe("Link a bank", () => {
	it("adds repair hooks and a busy label only when Plaid is enabled", async () => {
		await resetDemo(env.DB, todayUtc());
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE institution_name = 'Northline Card Services'",
		).run();

		const enabledResponse = await accounts.request(
			"/accounts",
			{},
			plaidEnabled,
		);
		const enabledHtml = await enabledResponse.text();
		expect(enabledHtml).toContain("data-fix-connection");
		expect(enabledHtml).toMatch(/data-item-id="\d+"/);
		expect(enabledHtml).toContain("Fix connection");
		expect(enabledHtml).toContain("Fixing…");

		const demoResponse = await accounts.request(
			"/accounts",
			{},
			{ ...plaidEnabled, DEMO: "true" },
		);
		const demoHtml = await demoResponse.text();
		expect(demoHtml).toContain("Fix connection");
		expect(demoHtml).toContain("Fixing…");
		expect(demoHtml).not.toContain("data-fix-connection");
		expect(demoHtml).not.toContain("data-item-id");
	});

	it("shows the button and Plaid scripts only when Plaid is enabled", async () => {
		const enabled = await accounts.request("/accounts", {}, plaidEnabled);
		const enabledHtml = await enabled.text();
		expect(enabledHtml).toContain('type="button"');
		expect(enabledHtml).toContain("Link a bank");
		expect(enabledHtml).toContain(`src="${PLAID_LINK_SCRIPT}"`);
		expect(enabledHtml).toContain('src="/js/plaid-link.js"');

		for (const bindings of [
			{ ...plaidEnabled, DEMO: "true" },
			{ ...plaidEnabled, PLAID_SECRET: undefined },
		]) {
			const response = await accounts.request("/accounts", {}, bindings);
			const html = await response.text();
			expect(html).not.toContain("Link a bank");
			expect(html).not.toContain(PLAID_LINK_SCRIPT);
			expect(html).not.toContain("/js/plaid-link.js");
		}
	});

	it("keeps Link a bank inside the refreshed summary, after the banks", async () => {
		await resetDemo(env.DB, todayUtc());
		const response = await accounts.request("/accounts", {}, plaidEnabled);
		const html = await response.text();
		const summaryStart = html.indexOf('<div id="accounts-summary">');
		const heading = html.indexOf("Net worth");
		const banks = html.indexOf('<div id="accounts-banks">');
		const button = html.indexOf("data-link-bank");
		const errorRegion = html.indexOf("data-link-bank-error");

		expect(summaryStart).toBeGreaterThan(-1);
		expect(heading).toBeGreaterThan(summaryStart);
		expect(banks).toBeGreaterThan(heading);
		expect(button).toBeGreaterThan(banks);
		expect(errorRegion).toBeGreaterThan(button);
		// Both sit inside the summary, so a refresh redraws them where they belong.
		const summaryEnd = html.indexOf("</main>");
		expect(html.slice(summaryStart, summaryEnd)).toMatch(
			/data-link-bank-error[^>]*><\/div><\/div>\s*$/,
		);
	});

	it("puts Link a bank inside the add empty state when no bank is linked (decision 55)", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		const response = await accounts.request("/accounts", {}, plaidEnabled);
		const html = await response.text();
		const summaryStart = html.indexOf('<div id="accounts-summary">');
		const sentence = html.indexOf("No banks linked yet.");
		const button = html.indexOf("data-link-bank");
		expect(summaryStart).toBeGreaterThan(-1);
		expect(sentence).toBeGreaterThan(summaryStart);
		expect(button).toBeGreaterThan(sentence);
		expect(html).toMatch(
			/<div class="mt-6"><button[^>]*data-link-bank[^>]*>[\s\S]*?Link a bank[\s\S]*?<\/button><div data-link-bank-error/,
		);
		expect(html).not.toContain("Net worth");
	});
});
