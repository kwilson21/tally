import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { accountsByBank, netWorthCents } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";

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

	it("leaves out a linked bank that has no accounts yet", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (X'00', 'Empty Bank', 'demo')",
		).run();
		const banks = await accountsByBank(env.DB);
		expect(banks.map((b) => b.name)).not.toContain("Empty Bank");
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

	it("says no bank is linked yet when there are no accounts", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
		]);
		const text = textOf((await get("/accounts")).html);
		expect(text).toContain("$0");
		expect(text).toContain("No banks linked yet.");
	});

	it("marks Accounts as the current page", async () => {
		const { html } = await get("/accounts");
		expect(html).toMatch(/href="\/accounts"[^>]*aria-current="page"/);
	});
});
