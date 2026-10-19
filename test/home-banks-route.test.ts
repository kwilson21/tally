import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// The Your banks list's refresh (P140 A, decision 133): GET /home/banks, polled every 5 seconds while a bank is being read.
// It answers with the list and the status out of band, announces a bank that came in, redraws the whole first-week top once
// the questions open, and asks for a reload when there is no setup to draw.
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
		expect(html).toContain(`hx-get="/home/banks?in=${first}"`);
		expect(html).toContain('hx-trigger="every 5s"');
		expect(html).toContain('hx-status:4xx="swap:none"');
		expect(html).toContain('hx-status:5xx="swap:none"');
		expect(html).toContain("data-quiet");
	});

	it("stops polling once no bank is being read, with no trigger and no quiet flag", async () => {
		await readingBanks();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now')",
		).run();
		const { res, html } = await refresh();
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(html).toContain('id="your-banks"');
		expect(html).not.toContain("every 5s");
		expect(html).not.toContain("data-quiet");
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
		expect(res.headers.get("HX-Retarget")).toBe("#first-week");
		expect(res.headers.get("HX-Reswap")).toBe("outerHTML");
		expect(html).toContain('id="first-week"');
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

	it("asks for a reload when no setup is drawn: set up, or the demo", async () => {
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
		const { res } = await refresh();
		expect(res.headers.get("HX-Refresh")).toBe("true");
		const demoRes = await refresh("", demo);
		expect(demoRes.res.headers.get("HX-Refresh")).toBe("true");
	});
});
