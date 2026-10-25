import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// Home once a new family's questions are answered (spec §8.8, decision 148): Home is Home from then on, with the fifth day's
// view on the day stroke five is drawn (#586, until #774). Before the questions are answered, a family's setup is on its own
// pages (/setup, setup-route.test.ts), and Home sends them there. Home loads no Plaid Link: it has no Link a bank any more.
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

describe("Home once the questions are answered, and the demo", () => {
	it("four strokes drawn: the ruled total, and no three things to check", async () => {
		// The bank's history is in, so the answered phase promises tomorrow (#671 says otherwise while it is importing).
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = datetime('now'), history_complete_at = datetime('now') WHERE disconnected_at IS NULL",
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
		const html = await page(family);
		expect(html).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(html).not.toContain("Three things to check");
		expect(html).not.toContain('href="/first-page"');
	});

	it("in the answered phase, Home has no Your banks and no Have more accounts?", async () => {
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
		const html = await page(plaidFamily);
		expect(html).toContain(
			"Four. Tomorrow Tally keeps count on its own, and that's the fifth.",
		);
		expect(html).not.toContain("Your banks");
		expect(html).not.toContain("Have more accounts?");
		expect(html).not.toContain(PLAID_MODULE);
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
});

describe("Home on the fifth day, the answered wait and Link a bank on the sheets (P125 E, #586, #671, #678)", () => {
	const today = () => todayIn(DEFAULT_TIME_ZONE);
	const yesterday = () => daysBefore(today(), 1);
	const decoded = (html: string) => html.replaceAll("&amp;", "&");

	/** The four questions and stroke one drawn on `day`. */
	const answeredOn = (day: string) => ({
		strokes: { bank: day, pay: day, bills: day, budgets: day },
		budgets: {},
	});
	/** One bank, Chase, with its history in: the demo's second bank is disconnected, so the wording names one bank. */
	const bankHistoryIn = async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id > (SELECT MIN(id) FROM plaid_items)",
		).run();
		await env.DB.prepare(
			"UPDATE plaid_items SET institution_name = 'Chase', last_synced_at = datetime('now'), history_complete_at = datetime('now') WHERE disconnected_at IS NULL",
		).run();
	};
	const storedRecord = async () =>
		JSON.parse(
			(
				await env.DB.prepare(
					"SELECT value FROM household_settings WHERE key = 'first_tally'",
				).first<{ value: string }>()
			)?.value ?? "null",
		);

	it("draws the fifth stroke on the first later day, with the night's sentence, the steps and Home's day", async () => {
		await bankHistoryIn();
		await env.DB.prepare("DELETE FROM transactions").run();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 3, needYou: 0 },
		});
		const html = await page(family);
		expect(html).toContain(
			"Five. Overnight Tally kept count on its own: 3 new transactions, all sorted. You're set up.",
		);
		expect(html).toContain("Safe to spend");
		expect(html).toContain(
			"From tomorrow this list goes, and Home is just Home.",
		);
		expect(html).toContain("Today, ");
		expect(html).not.toContain("See what needs you");
		expect(html).not.toContain("Three things to check");
		expect((await storedRecord()).strokes.count).toBe(today());
	});

	it("says what needs a person, and links to the full list when nothing else is waiting (#714)", async () => {
		await bankHistoryIn();
		await env.DB.prepare("DELETE FROM transactions").run();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 1, needYou: 2 },
		});
		const html = decoded(await page(family));
		expect(html).toContain(
			"Five. Overnight Tally kept count on its own: 1 new transaction; 2 need you.",
		);
		expect(html).toContain(">See what needs you</a>");
		expect(html).toContain('href="/transactions?month=all"');
		expect(html).not.toContain("uncategorized=1");
	});

	it("links to the suggestions when a suggestion waits and nothing needs a category (#714)", async () => {
		await bankHistoryIn();
		await env.DB.prepare("DELETE FROM transactions").run();
		// A paycheck guess Tally is unsure of: money in (a credit) with an income guess, no category to set.
		await env.DB.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name, income_confidence)
			 VALUES ((SELECT MIN(id) FROM accounts), 'fifth-suggestion', ?, -250000, 'VENMO PAYMENT', 0.5)`,
		)
			.bind(today())
			.run();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 1, needYou: 1 },
		});
		const html = decoded(await page(family));
		expect(html).toContain(">See what needs you</a>");
		expect(html).toContain('href="/settings/suggestions"');
		expect(html).not.toContain('href="/transactions/organize"');
	});

	it("links to the full list, where a held credit shows Review credit, when only a held credit waits (#714)", async () => {
		await bankHistoryIn();
		await env.DB.prepare("DELETE FROM transactions").run();
		// A credit with no income guess and no category: held for review, and nothing in the suggestions queue.
		await env.DB.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name)
			 VALUES ((SELECT MIN(id) FROM accounts), 'fifth-held', ?, -5000, 'ZELLE FROM FRIEND')`,
		)
			.bind(today())
			.run();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 1, needYou: 1 },
		});
		const html = decoded(await page(family));
		expect(html).toContain(">See what needs you</a>");
		expect(html).toContain('href="/transactions?month=all"');
		expect(html).not.toContain('href="/transactions/organize"');
		expect(html).not.toContain('href="/settings/suggestions"');
	});

	it("links to the organize list when Home shows its own needs-you count", async () => {
		await bankHistoryIn();
		await env.DB.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name)
			 VALUES ((SELECT MIN(id) FROM accounts), 'fifth-needs', ?, 1500, 'NEEDS A CATEGORY')`,
		)
			.bind(today())
			.run();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 1, needYou: 1 },
		});
		const html = decoded(await page(family));
		expect(html).toContain('href="/transactions/organize"');
		expect(html).toContain(">See what needs you</a>");
	});

	it("is Home again the day after, with no set-up view", async () => {
		await bankHistoryIn();
		await writeRecord({
			...answeredOn(daysBefore(today(), 2)),
			strokes: {
				...answeredOn(daysBefore(today(), 2)).strokes,
				count: yesterday(),
			},
			night: { brought: 0, needYou: 0 },
		});
		const html = await page(family);
		expect(html).not.toContain("From tomorrow this list goes");
		expect(html).not.toContain("Five strokes");
		expect(html).toContain("Safe to spend");
	});

	it("draws the fifth stroke once when Home loads twice on the same day", async () => {
		await bankHistoryIn();
		await writeRecord({
			...answeredOn(yesterday()),
			night: { brought: 0, needYou: 0 },
		});
		await page(family);
		await page(family);
		expect((await storedRecord()).strokes.count).toBe(today());
	});

	it("draws no fifth stroke while no night is kept", async () => {
		await bankHistoryIn();
		await writeRecord(answeredOn(yesterday()));
		const html = await page(family);
		expect((await storedRecord()).strokes.count).toBeUndefined();
		expect(html).not.toContain("From tomorrow this list goes");
	});

	it("while a bank reads its history, the answered status says what it waits for, not tomorrow (#671)", async () => {
		await bankHistoryIn();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = NULL, history_complete_at = NULL WHERE disconnected_at IS NULL",
		).run();
		await writeRecord(answeredOn(today()));
		const html = await page(family);
		expect(html).toContain(
			"Four. Tally keeps count once Chase's history is in.",
		);
		expect(html).not.toContain("Tomorrow Tally keeps count");
	});

	it("never promises tomorrow beside a bank that needs signing in (#671)", async () => {
		await bankHistoryIn();
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE disconnected_at IS NULL",
		).run();
		await writeRecord(answeredOn(today()));
		const html = await page(family);
		expect(html).toContain(
			"Four. Tally keeps count once Chase is signed in again.",
		);
		expect(html).not.toContain("Tomorrow Tally keeps count");
	});

	it("makes no promise beside a bank that stopped updating, and keeps its Fix line (#671)", async () => {
		await bankHistoryIn();
		await env.DB.prepare(
			"UPDATE plaid_items SET last_synced_at = ? WHERE disconnected_at IS NULL",
		)
			.bind(`${daysBefore(today(), 4)} 00:00:00`)
			.run();
		await writeRecord(answeredOn(today()));
		const html = decoded(await page(family));
		expect(html).toContain(">Four.</p>");
		expect(html).toContain("Chase stopped updating");
		expect(html).toContain("the bank in Accounts");
		expect(html).not.toContain("Four. Tally keeps count");
		expect(html).not.toContain("Tomorrow Tally keeps count");
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
