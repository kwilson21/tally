import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { runReadyEmail } from "../src/first-tally/ready-email";
import { home } from "../src/routes/home";
import { enabled } from "../src/routes/plaid";

// The Your banks list's refresh (P140 A, decision 133): GET /home/banks, polled every 5 seconds while a bank is being read.
// It answers with the list and the status out of band, announces a bank that came in, redraws the whole first-week top once
// the questions open, and redraws Home in full, without a reload, when there is no setup to draw (decision 146).
const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;
const TODAY = todayIn(DEFAULT_TIME_ZONE);

const writeRecord = (value: unknown) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(JSON.stringify(value))
		.run();

const refresh = async (query = "", bindings: Env = family) => {
	const res = await home.request(`/home/banks${query}`, {}, bindings);
	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
};

const trigger = (res: Response) => {
	const header = res.headers.get("HX-Trigger");
	return header ? JSON.parse(header) : null;
};

/** The opening tag of the element with this id, as the page draws it. */
const openingTag = (html: string, id: string) =>
	html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`))?.[0] ?? "";

// Every connected bank, with one "in" and the rest reading: the reading phase, with the list polling.
const readingBanks = async () => {
	await env.DB.prepare("UPDATE plaid_items SET disconnected_at = NULL").run();
	await env.DB.prepare(
		"UPDATE plaid_items SET history_complete_at = NULL",
	).run();
	await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
};

const connectedIds = async () =>
	(
		await env.DB.prepare(
			"SELECT id FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id",
		).all<{ id: number }>()
	).results.map((row) => row.id);

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = 'first_tally'",
	).run();
});

describe("GET /home/banks: the list while a bank is read", () => {
	it("answers with the list and the status out of band, and no layout", async () => {
		await readingBanks();
		const { res, html } = await refresh();
		expect(res.status).toBe(200);
		expect(html).toContain('id="your-banks"');
		expect(html).toContain('hx-swap-oob="innerHTML"');
		expect(html).toContain('id="setup-status"');
		expect(html).toContain("Tally's reading your last 90 days");
		expect(html).not.toContain("<html");
		expect(html).not.toContain('id="home"');
	});

	it("with Plaid off, still answers with the list: no reload, and no Have more accounts? prompt", async () => {
		// The premise: no Plaid credentials, so Home draws no prompt. The fragment is not gated on Plaid (Home draws the list
		// with Plaid off too), and it never carries the prompt, so the last assertion guards that rather than proving it.
		expect(enabled(family)).toBe(false);
		await readingBanks();
		const { res, html } = await refresh();
		expect(res.status).toBe(200);
		expect(html).toContain('id="your-banks"');
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(html).not.toContain("Have more accounts?");
	});

	it("keeps nothing focusable in the list, so a refresh never moves focus", async () => {
		await readingBanks();
		const { html } = await refresh();
		const list = html.split('id="your-banks"')[1]?.split("</section>")[0] ?? "";
		expect(list).not.toContain("<a ");
		expect(list).not.toContain("<button");
		expect(list).not.toContain("tabindex");
	});

	it("keeps polling while a bank is being read, asking for the banks it already shows as in", async () => {
		await readingBanks();
		const [first] = await connectedIds();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id = ?",
		)
			.bind(first)
			.run();
		const { html } = await refresh(`?in=${first}`);
		expect(html).toContain(`hx-get="/home/banks?in=${first}&amp;step=reading"`);
		expect(html).toContain('hx-trigger="every 5s"');
		expect(html).toContain('hx-status:4xx="swap:none"');
		expect(html).toContain('hx-status:5xx="swap:none"');
		expect(html).toContain("data-quiet");
	});

	it("stops polling once the sort has gone quiet for an hour, with no trigger and no quiet flag (decision 146)", async () => {
		await readingBanks();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-quiet', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		// Every history came in two hours ago: Tally is still sorting, but taking longer than usual, so the list stops.
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now', '-2 hours')",
		).run();
		const { res, html } = await refresh();
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(html).toContain('id="your-banks"');
		expect(html).not.toContain("every 5s");
		expect(html).not.toContain("data-quiet");
		// The page stops refreshing, but its person is still there: the poll never takes the check-in out (decision 146).
		expect(html).not.toContain('hx-swap-oob="delete"');
	});

	it("marks the poll so a Plaid Link window pauses it while it is open (decision 146)", async () => {
		await readingBanks();
		const { html } = await refresh();
		expect(openingTag(html, "your-banks")).toContain("data-waits-for-link");
	});

	it("leaves the check-in alone while the step it shows has not changed", async () => {
		await readingBanks();
		const { html } = await refresh("?step=reading");
		expect(html).toContain('hx-trigger="every 5s"');
		expect(html).not.toContain('id="home-seen"');
	});

	it("announces a bank that came in, with its count, once", async () => {
		await readingBanks();
		const [first] = await connectedIds();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id = ?",
		)
			.bind(first)
			.run();
		const row = await env.DB.prepare(
			"SELECT institution_name AS name FROM plaid_items WHERE id = ?",
		)
			.bind(first)
			.first<{ name: string }>();
		const { res } = await refresh("");
		const count = (
			await env.DB.prepare(
				`SELECT COUNT(t.id) AS n FROM accounts a JOIN transactions t ON t.account_id = a.id
				WHERE a.plaid_item_id = ? AND t.plaid_transaction_id IS NOT NULL`,
			)
				.bind(first)
				.first<{ n: number }>()
		)?.n;
		const message = `${row?.name} is in: ${count} ${count === 1 ? "transaction" : "transactions"}.`;
		expect(trigger(res)).toEqual({
			toast: { message, type: "info" },
			announce: message,
		});
		// A refresh that is told the bank is in says nothing about it.
		const again = await refresh(`?in=${first}`);
		expect(trigger(again.res)).toBeNull();
	});

	it("joins two banks that came in on one refresh into one message", async () => {
		await readingBanks();
		const [first, second] = await connectedIds();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id IN (?, ?)",
		)
			.bind(first, second)
			.run();
		const { res } = await refresh("");
		const names = (
			await env.DB.prepare(
				"SELECT institution_name AS name FROM plaid_items WHERE id IN (?, ?) ORDER BY id",
			)
				.bind(first, second)
				.all<{ name: string }>()
		).results.map((row) => row.name);
		const message = trigger(res)?.announce as string;
		expect(message.startsWith(`${names[0]} is in: `)).toBe(true);
		expect(message).toContain(`${names[1]} is in: `);
		expect(message.split(". ").length).toBeGreaterThanOrEqual(2);
	});

	it("says '1 transaction' for a bank with exactly one", async () => {
		await readingBanks();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by, history_complete_at) VALUES (902, X'', 'Solo Card', 'test', datetime('now'))",
		).run();
		await env.DB.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (990, 902, 'Card', '0000', 'credit', 'credit card', 1, 0)",
		).run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id) VALUES (990, '2026-10-01', 500, 'SHOP', 'solo-card-1')",
		).run();
		const { res } = await refresh("");
		expect(trigger(res)?.announce).toBe("Solo Card is in: 1 transaction.");
	});

	it("sends no announcement when a refresh only moves a count, for a bank being read or one already in", async () => {
		// A refresh that only moves a count says nothing: the list shows the count, and saying it every 5 seconds would drown
		// out everything else (DESIGN.md, YourBanks).
		await readingBanks();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by) VALUES (903, X'', 'Count Bank', 'test')",
		).run();
		await env.DB.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (993, 903, 'Card', '0000', 'credit', 'credit card', 1, 0)",
		).run();
		const addTransaction = (plaidId: string) =>
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id) VALUES (993, '2026-10-01', 500, 'SHOP', ?)",
			)
				.bind(plaidId)
				.run();

		await addTransaction("count-1");
		await addTransaction("count-2");
		const reading = await refresh();
		expect(reading.html).toContain("Reading · 2 so far");
		expect(trigger(reading.res)).toBeNull();

		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id = 903",
		).run();
		// The page already draws this bank as in, so the refresh only has to move its count.
		const arrived = await refresh("?in=903");
		expect(trigger(arrived.res)).toBeNull();
		await addTransaction("count-3");
		const moved = await refresh("?in=903");
		expect(moved.html).toContain("90 days in · 3");
		expect(trigger(moved.res)).toBeNull();
	});

	it("ignores anything in ?in= that is not a positive whole number", async () => {
		await readingBanks();
		const [first] = await connectedIds();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now') WHERE id = ?",
		)
			.bind(first)
			.run();
		const { res } = await refresh("?in=abc,-2,0,2.5,");
		expect(trigger(res)?.announce).toContain(" is in: ");
	});
});

describe("GET /home/banks: a step change is announced once (decision 146)", () => {
	it("announces the sorting status once, when the poll that named reading finds the sort begun", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-step', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		await readingBanks();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		const ids = (await connectedIds()).join(",");
		const first = await refresh(`?in=${ids}&step=reading`);
		expect(trigger(first.res)?.announce).toContain(
			"Sorting your last 90 days:",
		);
		// The page now shows sorting, so the next poll names it: the status ticks on silently.
		const again = await refresh(`?in=${ids}&step=sorting`);
		expect(trigger(again.res)).toBeNull();
		expect(again.html).toContain("Sorting your last 90 days:");
	});

	it("swaps the check-in to the new step when the poll announces it, so the page does not reload for a change it shows (decision 146)", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-check', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		await readingBanks();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		const ids = (await connectedIds()).join(",");
		const { html } = await refresh(`?in=${ids}&step=reading`);
		expect(html).toContain(
			'<div id="home-seen" hx-swap-oob="outerHTML" hidden',
		);
		expect(html).toContain('hx-vals="{&quot;step&quot;:&quot;sorting&quot;}"');
		// A poll that names the step already shown swaps no check-in, so the 5-second poll never resets the 30-second one.
		const same = await refresh(`?in=${ids}&step=sorting`);
		expect(same.html).not.toContain('id="home-seen"');
	});

	it("announces the ready status and redraws the top once the questions open from a sort (reading to ready)", async () => {
		await readingBanks();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		// Nothing left to sort: the questions open, and the top redraws with the ready status.
		await saveAiSwitches(env.DB, { categories: false, income: false });
		const ids = (await connectedIds()).join(",");
		const { res } = await refresh(`?in=${ids}&step=sorting`);
		expect(res.headers.get("HX-Retarget")).toBe("#setup-top");
		expect(trigger(res)?.announce).toContain(
			"Now answer three quick questions to set up your budget.",
		);
	});
});

describe("GET /home/banks: the questions open, or there is no setup", () => {
	it("redraws the whole first-week top once the phase is no longer reading, and announces the status", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = NULL, history_complete_at = datetime('now')",
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
		// The page already shows every bank as in, so only the status is said.
		const { res, html } = await refresh(
			`?in=${(await connectedIds()).join(",")}`,
		);
		expect(res.headers.get("HX-Retarget")).toBe("#setup-top");
		expect(res.headers.get("HX-Reswap")).toBe("outerHTML");
		expect(html).toContain('id="setup-top"');
		// The swap moves focus to the new status: the button that had it (Link a bank, a Fix) is gone with the old top.
		const status = html.split('id="setup-status"')[1]?.split(">")[0] ?? "";
		expect(status).toContain(" autofocus");
		expect(html).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(trigger(res)?.announce).toBe(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(trigger(res)?.toast).toEqual({
			message:
				"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
			type: "info",
		});
	});

	it("redraws Home in full, with no reload, when no setup is drawn: set up, or the fifth day (decision 146)", async () => {
		await writeRecord({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
				count: "2026-10-01",
			},
			budgets: {},
		});
		const { res, html } = await refresh();
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(res.headers.get("HX-Retarget")).toBe("#page");
		expect(res.headers.get("HX-Reselect")).toBe("#page");
		expect(html).toContain('id="page"');
		// Set up, Home's status is announced as it is drawn and takes focus (decision 146): the page has no focused button left.
		const focused = html
			.replaceAll("&#39;", "'")
			.match(/<[a-z0-9]+[^<>]*\bautofocus\b[^<>]*>([^<]*)</)?.[1];
		expect(focused).toBeTruthy();
		expect(trigger(res)?.announce).toBe(focused);
		expect(trigger(res)?.toast).toEqual({ message: focused, type: "info" });
		expect(html.match(/\bautofocus\b/g)?.length).toBe(1);
	});

	it("redraws Home in full before a bank, announcing its headline and taking focus on it (decision 146)", async () => {
		await readingBanks();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const { res, html } = await refresh();
		expect(res.headers.get("HX-Retarget")).toBe("#page");
		expect(html).toContain('id="page"');
		expect(trigger(res)?.announce).toBe("Five strokes, and you're set up.");
		expect(html.replaceAll("&#39;", "'")).toMatch(
			/<h1[^<>]*\bautofocus\b[^<>]*>Five strokes, and you're set up\.<\/h1>/,
		);
		expect(html.match(/\bautofocus\b/g)?.length).toBe(1);
	});

	it("answers 204 in the demo, which draws no setup to poll for, and never reloads", async () => {
		const { res } = await refresh("", demo);
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
	});
});

describe("a page that stops refreshing: its check-in and the ready email (decision 146)", () => {
	const DANA = "dana@example.com";
	const production = {
		...env,
		DEMO: "false",
		RESEND_API_KEY: "test-key",
		EMAIL: undefined,
	} as never;

	it("a slow page keeps its check-in, so its person, last checked in a minute ago, is emailed only once away ten minutes", async () => {
		await readingBanks();
		await env.DB.prepare("DELETE FROM household_members").run();
		await env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at, home_seen_at) VALUES (?, datetime('now'), datetime('now', '-1 minutes'))",
		)
			.bind(DANA)
			.run();
		// Every history came in two hours ago and one transaction still waits for Jev: Tally is sorting, and slow.
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-chain', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now', '-2 hours')",
		).run();
		const slow = await refresh();
		expect(slow.html).toContain("Sorting is taking longer than usual");
		// The page stops refreshing, not checking in: the poll removes nothing (decision 146).
		expect(slow.html).not.toContain('hx-swap-oob="delete"');

		// The sort finishes and the questions open. The page has stopped checking in, and its last check-in is a minute old,
		// so this minute is too soon for the email.
		await saveAiSwitches(env.DB, { categories: false, income: false });
		await env.DB.prepare(
			"DELETE FROM transactions WHERE plaid_transaction_id = 'waiting-chain'",
		).run();
		const sent: string[] = [];
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				sent.push((JSON.parse(String(init?.body)) as { to: string }).to);
				return new Response("{}", { status: 200 });
			},
		);
		await runReadyEmail(production, fetchImpl);
		expect(sent).toEqual([]);

		// Ten minutes after its last check-in, the person counts as away and is emailed.
		await env.DB.prepare(
			"UPDATE household_members SET home_seen_at = datetime('now', '-11 minutes') WHERE email = ?",
		)
			.bind(DANA)
			.run();
		await runReadyEmail(production, fetchImpl);
		expect(sent).toEqual([DANA]);
	});
});
