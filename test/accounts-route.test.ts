import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JEV_URL } from "../src/ai/categorize";
import { DEFAULT_TIME_ZONE, monthName, todayIn } from "../src/dates";
import { accountsByBank, netWorthCents } from "../src/db/accounts";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { chartStart } from "../src/net-worth";
import { encryptToken } from "../src/plaid/token-crypto";
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
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

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
			lastSyncedAt: null,
			accounts: [],
		});
	});
});

describe("GET /accounts", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

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

	it("draws the last six months of net worth as a line under the headline, with the change in words (P25 A)", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const since = monthName(chartStart(today).slice(0, 7));
		const { html } = await get("/accounts");
		const text = textOf(html);
		expect(text).toMatch(new RegExp(`Up \\$[\\d,]+ since ${since}\\.`));
		// The picture has a text alternative with the same sentence.
		expect(html).toMatch(
			new RegExp(
				`<svg[^>]*role="img"[^>]*aria-label="Net worth over time\\. Up \\$[\\d,]+ since ${since}\\.`,
			),
		);
		expect(text).toContain(`${since}Today`);
		// Under the headline, above the banks, and nothing else drawn: account rows keep today's balance (P26 A).
		expect(html.indexOf("$15,768")).toBeLessThan(html.indexOf("<polyline"));
		expect(html.indexOf("<polyline")).toBeLessThan(
			html.indexOf("First Harbor Bank"),
		);
		expect(html.match(/<polyline/g)).toHaveLength(1);
		expect(html).not.toContain("arrives later");
	});

	it("redraws the chart with the rest of Accounts, since it sits inside the summary a sync swaps", async () => {
		const response = await accounts.request("/accounts", {}, plaidEnabled);
		const summary =
			(await response.text()).split('id="accounts-summary"')[1] ?? "";
		expect(summary).toContain('data-chart="line"');
	});

	it("before two days of balances, says when the chart starts instead of drawing it (P31)", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		await env.DB.prepare("DELETE FROM balance_history WHERE date != ?")
			.bind(today)
			.run();
		const { html } = await get("/accounts");
		const text = textOf(html);
		expect(text).toContain("Tally started following your balances today.");
		expect(text).toContain(
			"The chart starts tomorrow, with a second day of balances.",
		);
		expect(html).not.toContain("<polyline");
		// The headline is still there.
		expect(text).toContain("$15,768");
	});

	it("withholds the line while a connected account has no balance recorded, and says what it waits for", async () => {
		// The headline counts this account's balance already; a line without it would disagree.
		await env.DB.prepare(
			"INSERT INTO accounts (plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (2, 'Store card', '3333', 'credit', 'credit card', 1, 25000)",
		).run();
		const { html } = await get("/accounts");
		const text = textOf(html);
		expect(html).not.toContain("<polyline");
		expect(html).not.toContain('data-chart="line"');
		expect(text).toContain(
			"The chart starts once every account has a balance.",
		);
		// $4,210.55 + $12,400.00 − $842.17 − $250.00
		expect(text).toContain("$15,518");
		expect(text).toContain("Store card");
	});

	it("with no balance recorded yet, says the chart starts with the next sync", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		const { html } = await get("/accounts");
		expect(textOf(html)).toContain("The chart starts with the next sync.");
		expect(html).not.toContain("<polyline");
		expect(textOf(html)).not.toContain("Tally started following");
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

describe("POST /accounts/sync", () => {
	it("returns 404 in the demo", async () => {
		const response = await exports.default.fetch(
			new Request(`${BASE}/accounts/sync`, {
				method: "POST",
				headers: { Origin: BASE },
			}),
		);
		expect(response.status).toBe(404);
	});

	it("does not sync again within a minute and preserves the focus target", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await accounts.request(
			"/accounts/sync",
			{ method: "POST", headers: { "HX-Request": "true" } },
			plaidEnabled,
		);
		expect(response.status).toBe(200);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Already synced a moment ago.", type: "info" },
			announce: "Already synced a moment ago.",
		});
		const html = await response.text();
		expect(html).toContain('id="accounts-summary"');
		expect(html).toContain('id="sync-now"');
		fetchSpy.mockRestore();
	});

	it("redirects a native form submission back to Accounts", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const response = await accounts.request(
			"/accounts/sync",
			{ method: "POST" },
			plaidEnabled,
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/accounts");
	});

	it("omits drifting sync times from the demo", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const response = await accounts.request(
			"/accounts",
			{},
			{ ...plaidEnabled, DEMO: "true" },
		);
		const html = await response.text();
		expect(html).not.toMatch(/synced/i);
	});
});

describe("POST /accounts/sync feedback", () => {
	const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
	let waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
	const ctx = () => ({ waitUntil, passThroughOnException() {}, props: {} });

	beforeEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		waitUntil = vi.fn<(promise: Promise<unknown>) => void>((promise) => {
			void promise.catch(() => {});
		});
		// The demo's categories and merchants, but none of its banks.
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	async function addBank(
		name: string,
		{ status = "ok", attemptedNow = false } = {},
	) {
		await env.DB.prepare(
			`INSERT INTO plaid_items
				(access_token_encrypted, institution_name, linked_by, plaid_item_id, status, last_sync_attempt_at)
			 VALUES (?, ?, 'person@example.com', ?, ?, ${attemptedNow ? "datetime('now')" : "NULL"})`,
		)
			.bind(await encryptToken(`token-${name}`, KEY), name, name, status)
			.run();
	}

	/** A fake Plaid: each bank's token gets these transaction names, or fails. */
	function stubPlaid(
		added: Record<string, string[]>,
		failing: string[] = [],
		// Jev is down unless a test says how it answers.
		jev: () => Response | Promise<Response> = () =>
			new Response("{}", { status: 503 }),
	) {
		const fetchImpl = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url) === JEV_URL) return jev();
				const { access_token } = JSON.parse(String(init?.body)) as {
					access_token: string;
				};
				const bank = access_token.replace("token-", "");
				if (failing.includes(bank))
					return Response.json(
						{ error_type: "API_ERROR", request_id: "request-safe" },
						{ status: 500 },
					);
				if (String(url).endsWith("/accounts/get"))
					return Response.json({
						accounts: [
							{
								account_id: `account-${bank}`,
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					});
				return Response.json({
					added: (added[bank] ?? []).map((name, i) => ({
						transaction_id: `tx-${bank}-${i}`,
						account_id: `account-${bank}`,
						date: "2026-09-27",
						amount: 1,
						name,
						pending: false,
					})),
					modified: [],
					removed: [],
					next_cursor: "next",
					has_more: false,
				});
			},
		);
		vi.stubGlobal("fetch", fetchImpl);
		return fetchImpl;
	}

	async function sync(bindings: Record<string, unknown> = {}) {
		const response = await accounts.request(
			"/accounts/sync",
			{ method: "POST", headers: { "HX-Request": "true" } },
			{ ...plaidEnabled, ...bindings },
			ctx(),
		);
		const trigger = response.headers.get("HX-Trigger");
		return {
			response,
			trigger: trigger ? JSON.parse(trigger) : null,
			html: await response.text(),
		};
	}

	const said = (message: string, type = "success") => ({
		toast: { message, type },
		announce: message,
	});

	it.each([
		[{ Chase: [] }, "Nothing new"],
		[{ Chase: ["SHOP"] }, "1 new transaction"],
		[{ Chase: ["SHOP", "CAFE"], Ally: ["GAS"] }, "3 new transactions"],
	])("counts what arrived: %j", async (added, message) => {
		for (const bank of Object.keys(added)) await addBank(bank);
		stubPlaid(added);
		const { response, trigger, html } = await sync();
		expect(response.status).toBe(200);
		expect(trigger).toEqual(said(message));
		expect(html).not.toContain('role="alert"');
	});

	it("names the bank that failed once, in an alert, with no toast", async () => {
		await addBank("Chase");
		await addBank("Ally");
		stubPlaid({ Ally: ["SHOP"] }, ["Chase"]);
		const { response, trigger, html } = await sync();
		expect(response.status).toBe(200);
		expect(trigger).toBeNull();
		expect(html.match(/role="alert"/g)).toHaveLength(1);
		expect(html).toContain("Couldn&#39;t sync Chase. Try again later.");
	});

	it("says so in an alert when sorting what arrived fails after the banks synced", async () => {
		await addBank("Chase");
		stubPlaid({ Chase: ["SHOP"] });
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('SHOP', (SELECT id FROM categories ORDER BY id LIMIT 1))",
			),
			// Makes the merchant rule's update fail, standing in for any failure in the after-sync step.
			env.DB.prepare(
				"CREATE TRIGGER fail_rules BEFORE UPDATE OF category_id ON transactions BEGIN SELECT RAISE(ABORT, 'nope'); END",
			),
		]);
		try {
			const { response, trigger, html } = await sync();
			expect(response.status).toBe(200);
			expect(trigger).toBeNull();
			expect(html.match(/role="alert"/g)).toHaveLength(1);
			expect(html).toContain("Couldn&#39;t sync accounts. Try again later.");
		} finally {
			await env.DB.prepare("DROP TRIGGER fail_rules").run();
		}
	});

	it("still sorts with merchant rules when every bank is busy", async () => {
		await addBank("Chase", { attemptedNow: true });
		stubPlaid({});
		const category = await env.DB.prepare(
			"SELECT id FROM categories ORDER BY id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (900, 'Checking', 'depository', 0)",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (900, '2026-09-27', 100, 'SHOP')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('SHOP', ?)",
			).bind(category?.id),
		]);
		const { trigger } = await sync();
		expect(trigger).toEqual(said("Already synced a moment ago.", "info"));
		const row = await env.DB.prepare(
			"SELECT category_id, category_source FROM transactions WHERE raw_name = 'SHOP'",
		).first<{ category_id: number; category_source: string }>();
		expect(row).toEqual({
			category_id: category?.id,
			category_source: "merchant_rule",
		});
	});

	it("still sorts with merchant rules when every bank needs attention", async () => {
		await addBank("Chase", { status: "needs_attention" });
		stubPlaid({});
		const category = await env.DB.prepare(
			"SELECT id FROM categories ORDER BY id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO accounts (id, name, type, balance_cents) VALUES (901, 'Checking', 'depository', 0)",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (901, '2026-09-27', 100, 'CAFE')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('CAFE', ?)",
			).bind(category?.id),
		]);
		await sync();
		const row = await env.DB.prepare(
			"SELECT category_source FROM transactions WHERE raw_name = 'CAFE'",
		).first<{ category_source: string }>();
		expect(row?.category_source).toBe("merchant_rule");
	});

	it("shows the failure on the Accounts page when the form posts without htmx", async () => {
		await addBank("Chase");
		stubPlaid({}, ["Chase"]);
		const response = await accounts.request(
			"/accounts/sync",
			{ method: "POST" },
			plaidEnabled,
			ctx(),
		);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<html");
		expect(html.match(/role="alert"/g)).toHaveLength(1);
		expect(html).toContain("Couldn&#39;t sync Chase. Try again later.");
	});

	it("says it already synced when every bank was just tried", async () => {
		await addBank("Chase", { attemptedNow: true });
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] });
		const { trigger } = await sync();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(trigger).toEqual(said("Already synced a moment ago.", "info"));
	});

	it("reports only what synced when other banks were just tried", async () => {
		await addBank("Chase", { attemptedNow: true });
		await addBank("Ally");
		stubPlaid({ Ally: ["SHOP"] });
		const { trigger } = await sync();
		expect(trigger).toEqual(said("1 new transaction"));
	});

	it("asks for the connection to be fixed when every bank needs it", async () => {
		await addBank("Chase", { status: "needs_attention" });
		const fetchImpl = stubPlaid({});
		const { trigger } = await sync();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(trigger).toEqual(said("Fix the connection first.", "info"));
	});

	const jevCalls = (fetchImpl: ReturnType<typeof stubPlaid>) =>
		fetchImpl.mock.calls.filter(([url]) => String(url) === JEV_URL);
	/** The background work Sync now handed to waitUntil, finished. */
	const background = () => Promise.all(waitUntil.mock.calls.map(([p]) => p));
	/** Jev answers Eating Out, no flags. */
	const jevSays = (confidence: number) => () =>
		Response.json({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		});
	const categoryOf = (name: string) =>
		env.DB.prepare(
			"SELECT category_source, category_confidence FROM transactions WHERE raw_name = ?",
		)
			.bind(name)
			.first();

	it("applies merchant rules before answering, then Jev sorts the rest in the background (spec §8.1, §8.6)", async () => {
		const category = await env.DB.prepare(
			"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT OR REPLACE INTO merchants (raw_name, display_name, default_category_id) VALUES ('RULED SHOP', 'Ruled Shop', ?)",
		)
			.bind(category?.id)
			.run();
		await addBank("Chase");
		const fetchImpl = stubPlaid(
			{ Chase: ["RULED SHOP", "UNKNOWN SHOP"] },
			[],
			jevSays(0.95),
		);

		const { trigger } = await sync({ JEV_API_KEY: "jev-key" });
		expect(trigger).toEqual(said("2 new transactions"));
		const ruled = await env.DB.prepare(
			"SELECT category_id, category_source FROM transactions WHERE raw_name = 'RULED SHOP'",
		).first();
		expect(ruled).toEqual({
			category_id: category?.id,
			category_source: "merchant_rule",
		});

		// Handed to waitUntil, so the answer above didn't wait for it.
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await background();
		// Rules ran once, in the sync; Jev was asked only about what they left.
		expect(jevCalls(fetchImpl)).toHaveLength(1);
		expect(await categoryOf("UNKNOWN SHOP")).toEqual({
			category_source: "jev",
			category_confidence: 0.95,
		});
		expect(await categoryOf("RULED SHOP")).toEqual({
			category_source: "merchant_rule",
			category_confidence: null,
		});
	});

	it("answers without waiting for Jev", async () => {
		await addBank("Chase");
		let release: (r: Response) => void = () => {};
		const slow = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] }, [], () => slow);
		const { trigger } = await sync({ JEV_API_KEY: "jev-key" });
		// The answer is out while Jev's call is still going.
		expect(trigger).toEqual(said("1 new transaction"));
		await vi.waitFor(() => expect(jevCalls(fetchImpl)).toHaveLength(1));
		expect(await categoryOf("SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
		release(jevSays(0.95)());
		await background();
		expect(await categoryOf("SHOP")).toMatchObject({ category_source: "jev" });
	});

	it("doesn't ask Jev when the sorting switch is off", async () => {
		await saveAiSwitches(env.DB, { sortOnArrival: false });
		await addBank("Chase");
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] }, [], jevSays(0.95));
		const { trigger } = await sync({ JEV_API_KEY: "jev-key" });
		await background();
		expect(trigger).toEqual(said("1 new transaction"));
		expect(jevCalls(fetchImpl)).toHaveLength(0);
	});

	it("doesn't ask Jev without a key", async () => {
		await addBank("Chase");
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] }, [], jevSays(0.95));
		await sync();
		await background();
		expect(jevCalls(fetchImpl)).toHaveLength(0);
	});

	it("doesn't ask Jev when nothing came in", async () => {
		await addBank("Chase");
		const fetchImpl = stubPlaid({ Chase: [] }, [], jevSays(0.95));
		await sync({ JEV_API_KEY: "jev-key" });
		expect(waitUntil).not.toHaveBeenCalled();
		expect(jevCalls(fetchImpl)).toHaveLength(0);
	});

	it("still sorts what the other banks brought when one bank failed, and says only that one failed", async () => {
		await addBank("Chase");
		await addBank("Ally");
		const fetchImpl = stubPlaid({ Ally: ["SHOP"] }, ["Chase"], jevSays(0.95));
		const { trigger, html } = await sync({ JEV_API_KEY: "jev-key" });
		await background();
		expect(trigger).toBeNull();
		expect(html).toContain("Couldn&#39;t sync Chase. Try again later.");
		expect(jevCalls(fetchImpl)).toHaveLength(1);
		expect(await categoryOf("SHOP")).toMatchObject({ category_source: "jev" });
	});

	it("says the same when Jev is down, and the transaction stays for the nightly run", async () => {
		await addBank("Chase");
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] });
		const { trigger, html } = await sync({ JEV_API_KEY: "jev-key" });
		await expect(background()).resolves.toBeDefined();
		expect(trigger).toEqual(said("1 new transaction"));
		expect(html).not.toContain('role="alert"');
		expect(jevCalls(fetchImpl)).toHaveLength(1);
		expect(await categoryOf("SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
	});

	it("tries the merchant rules again itself when that step of the sync failed, and its failure stays out of the answer", async () => {
		await addBank("Chase");
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('SHOP', (SELECT id FROM categories ORDER BY id LIMIT 1))",
			),
			env.DB.prepare(
				"CREATE TRIGGER fail_rules BEFORE UPDATE OF category_id ON transactions BEGIN SELECT RAISE(ABORT, 'nope'); END",
			),
		]);
		const fetchImpl = stubPlaid({ Chase: ["SHOP"] }, [], jevSays(0.95));
		try {
			const { html } = await sync({ JEV_API_KEY: "jev-key" });
			await expect(background()).resolves.toBeDefined();
			expect(html).toContain("Couldn&#39;t sync accounts. Try again later.");
			// The pass applied the rules itself, which failed again, so Jev wasn't asked.
			expect(jevCalls(fetchImpl)).toHaveLength(0);
			expect(JSON.stringify(vi.spyOn(console, "error").mock.calls)).toContain(
				"sort after sync failed",
			);
		} finally {
			await env.DB.prepare("DROP TRIGGER fail_rules").run();
		}
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
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
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
		expect(enabledHtml).toContain("Sync now");
		expect(enabledHtml).toContain("Syncing…");
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
			expect(html).not.toContain("Sync now");
			expect(html).not.toContain(PLAID_LINK_SCRIPT);
			expect(html).not.toContain("/js/plaid-link.js");
		}
	});

	it("keeps Link a bank inside the refreshed summary, after the banks", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
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
