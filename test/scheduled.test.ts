import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { jevCallLimit } from "../src/categorize-pending";
import { categoryCallLimit } from "../src/category-suggestions-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { loadMonth } from "../src/db/month";
import { resetDemo as resetDemoBase } from "../src/demo/reset";
import { monthOffset } from "../src/demo/seed";
import handler, {
	runFirstSort,
	runScheduled,
	runSecondSort,
} from "../src/index";
import { encryptToken } from "../src/plaid/token-crypto";
import {
	nameCallLimit,
	suggestMerchantNames,
} from "../src/suggest-names-pending";

const KEY = btoa("01234567890123456789012345678901");

async function resetDemo(
	db: D1Database,
	today: string,
	options?: { categoryExample?: boolean },
) {
	await resetDemoBase(db, today, options);
	await saveAiSwitches(db, { details: false });
}

// The Workers runtime supports scheduled() on the Worker's own export, but the
// generated Fetcher type only declares fetch() and connect().
const worker = exports.default as unknown as {
	scheduled(options: { cron?: string }): Promise<unknown>;
};

/** The same entry point with an environment of the test's choosing, production's say, which `worker` can't take. */
const scheduledWith = handler as unknown as {
	scheduled(controller: { cron: string }, env: unknown): Promise<unknown>;
};

/** What Jev answers: nothing sure, so a call asked costs its queries and changes no category. */
const jevAnswer = () =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
		},
	});

/** A fake Workers AI that always gives the same answer, and remembers each ask. */
const aiThatSays = (response: string) =>
	({ run: vi.fn(async () => ({ response })) }) as unknown as Ai & {
		run: ReturnType<typeof vi.fn>;
	};

// Each test is a new household day, so Jev calls one test makes aren't counted against the next one's cap.
beforeEach(async () => {
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'",
	).run();
});

const count = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{
			n: number;
		}>()
	)?.n ?? 0;

describe("scheduled handler", () => {
	it("seeds Pet Care through the real demo scheduled reset without changing Home totals", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const month = today.slice(0, 7);
		await resetDemo(env.DB, today);
		const beforeData = await loadMonth(env.DB, month);
		const before = summarizeMonth({
			month,
			...beforeData,
			unpaidDueBillsCents: 0,
		});
		await scheduledWith.scheduled(
			{ cron: "0 8 * * *" },
			{
				...env,
				DEMO: "true",
				PLAID_SECRET: undefined,
				PLAID_CLIENT_ID: undefined,
				JEV_API_KEY: undefined,
				AI: undefined,
			},
		);
		const suggestion = await env.DB.prepare(
			"SELECT id FROM category_suggestions WHERE name='Pet Care' AND status='pending'",
		).first<{ id: number }>();
		const rows = await env.DB.prepare(
			"SELECT COUNT(*) AS n, MIN(date) AS earliest FROM transactions WHERE category_suggestion_id=?",
		)
			.bind(suggestion?.id)
			.first<{ n: number; earliest: string }>();
		expect(rows?.n).toBeGreaterThanOrEqual(3);
		expect(rows?.earliest.slice(0, 7)).toBe(monthOffset(today, 2).slice(0, 7));
		const afterData = await loadMonth(env.DB, month);
		const after = summarizeMonth({
			month,
			...afterData,
			unpaidDueBillsCents: 0,
		});
		expect(after).toEqual(before);
	});

	it("restores the demo seed through the Worker entry point when the guard allows it", async () => {
		await env.DB.prepare("DELETE FROM transactions").run();
		expect(await count()).toBe(0);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await worker.scheduled({ cron: "0 8 * * *" });

		expect(await count()).toBeGreaterThan(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("leaves Jev out when there is no key, so the seed's 12 stay uncategorized", async () => {
		await worker.scheduled({ cron: "0 9 * * *" });

		const untouched = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL AND flag_income = 0 AND excluded = 0",
		).first<{ n: number }>();
		expect(untouched?.n).toBeGreaterThanOrEqual(12);
	});

	it("syncs and applies merchant rules at the sync, so a new transaction gets its rule's category", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
		const category = await env.DB.prepare(
			"SELECT id FROM categories ORDER BY id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('NEW SHOP', ?)",
		)
			.bind(category?.id)
			.run();
		const token = await encryptToken("access-token", KEY);
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', 'item')",
		)
			.bind(token)
			.run();
		const fetchImpl = async (url: RequestInfo | URL) => {
			if (String(url).endsWith("/accounts/get")) {
				return new Response(
					JSON.stringify({
						accounts: [
							{
								account_id: "account",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					}),
				);
			}
			return new Response(
				JSON.stringify({
					added: [
						{
							transaction_id: "new-transaction",
							account_id: "account",
							date: "2026-09-27",
							amount: 12,
							name: "NEW SHOP",
							pending: false,
						},
					],
					modified: [],
					removed: [],
					next_cursor: "next",
					has_more: false,
				}),
			);
		};

		await runScheduled(
			{
				...env,
				DEMO: "false",
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
				TOKEN_ENCRYPTION_KEY: KEY,
				JEV_API_KEY: "jev",
			},
			fetchImpl,
		);

		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE plaid_transaction_id = 'new-transaction'",
			).first(),
		).toEqual({ category_id: category?.id, category_source: "merchant_rule" });
	});

	it("applies merchant rules at the nightly sync even when Jev has no key", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
		const category = await env.DB.prepare(
			"SELECT id FROM categories ORDER BY id LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('NEW SHOP', ?)",
		)
			.bind(category?.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', 'item')",
		)
			.bind(await encryptToken("access-token", KEY))
			.run();
		const fetchImpl = async (url: RequestInfo | URL) =>
			String(url).endsWith("/accounts/get")
				? Response.json({
						accounts: [
							{
								account_id: "account",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					})
				: Response.json({
						added: [
							{
								transaction_id: "new-transaction",
								account_id: "account",
								date: "2026-09-27",
								amount: 12,
								name: "NEW SHOP",
								pending: false,
							},
						],
						modified: [],
						removed: [],
						next_cursor: "next",
						has_more: false,
					});

		await runScheduled(
			{
				...env,
				DEMO: "false",
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
				TOKEN_ENCRYPTION_KEY: KEY,
				JEV_API_KEY: undefined,
			},
			fetchImpl,
		);

		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE plaid_transaction_id = 'new-transaction'",
			).first(),
		).toEqual({ category_id: category?.id, category_source: "merchant_rule" });
	});

	// Decision 56: production's 09:20 and 09:40 runs only sort; they never reset the demo or sync.
	it.each(["20 9 * * *", "40 9 * * *"])(
		"runs only a sort at %s, with no reset and no sync",
		async (cron) => {
			await env.DB.prepare("DELETE FROM transactions").run();
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			await worker.scheduled({ cron });

			expect(await count()).toBe(0);
			expect(fetchSpy).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		},
	);

	it("asks Jev about what the first sort left, so the day still reaches its cap (decision 56)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const fetchImpl = vi.fn(async () => jevAnswer());

		await runSecondSort(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);

		expect(fetchImpl).toHaveBeenCalledTimes(12);
		vi.restoreAllMocks();
	});

	// Spec §8.6: the first sort reads the household's AI switches too.
	it.each([
		{ categories: false, income: false, calls: 0 },
		{ categories: true, income: false, calls: 12 },
		{ categories: false, income: true, calls: 12 },
	])(
		"asks Jev $calls times in the 09:20 run with categories $categories and income $income",
		async ({ categories, income, calls }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await saveAiSwitches(env.DB, {
				...AI_SWITCHES_ALL_ON,
				details: false,
				categories,
				income,
			});
			const fetchImpl = vi.fn(async () => jevAnswer());

			// Production, not the demo, whose nightly reset would turn the switches back on.
			await runFirstSort(
				{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
				fetchImpl as unknown as typeof fetch,
			);

			expect(fetchImpl).toHaveBeenCalledTimes(calls);
			vi.restoreAllMocks();
		},
	);

	it("asks Jev nothing in production's 09:00 run, which only syncs (decision 56)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const fetchImpl = vi.fn(async () => jevAnswer());

		await runScheduled(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("takes the 09:20 run's up to 200 calls and the 09:40 run's up to 300 from one day's 500", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				 SELECT 'plaid-' || i, 1, '2026-09-20', 500 + i, 'SHOP NUMBER ' || i FROM n`,
			),
		]);
		const production = { ...env, DEMO: "false", JEV_API_KEY: "jev" };
		const first = vi.fn(async () => jevAnswer());
		const second = vi.fn(async () => jevAnswer());
		const third = vi.fn(async () => jevAnswer());

		await runFirstSort(production, first as unknown as typeof fetch);
		await runSecondSort(production, second as unknown as typeof fetch);
		await runSecondSort(production, third as unknown as typeof fetch);

		expect(first).toHaveBeenCalledTimes(200);
		expect(second).toHaveBeenCalledTimes(300);
		expect(third).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	}, 60_000);
});

// Which run each cron starts (decision 56): production has three, 20 minutes apart, so each has D1's 1,000
// queries to itself (09:00 syncs, 09:20 asks Jev and then names, 09:40 asks Jev); the demo has one. The entry point routes by the cron that fired.
describe("scheduled handler: which run a cron starts", () => {
	async function seedWaiting() {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
	}
	/** Fires one cron in production with a fake Jev (the global fetch) and a fake Workers AI. */
	async function fire(cron: string) {
		const jev = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => jevAnswer());
		const ai = aiThatSays("Some Place Name");
		await scheduledWith.scheduled(
			{ cron },
			{ ...env, DEMO: "false", JEV_API_KEY: "jev", AI: ai },
		);
		return { jev: jev.mock.calls.length, names: ai.run.mock.calls.length };
	}

	it("asks Jev and Workers AI nothing at 09:00, which syncs and retries feedback", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		expect(await fire("0 9 * * *")).toEqual({ jev: 0, names: 0 });
		vi.restoreAllMocks();
	});

	it("asks Jev, then names, at 09:20", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		const { jev, names } = await fire("20 9 * * *");
		expect(jev).toBe(12);
		expect(names).toBeGreaterThan(0);
		vi.restoreAllMocks();
	});

	it("asks Jev, and no names, at 09:40", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		expect(await fire("40 9 * * *")).toEqual({ jev: 12, names: 0 });
		vi.restoreAllMocks();
	});
});

// The nightly names step (spec §7, §9, #33): Workers AI suggests names where there is a binding. In
// production it runs last in the 09:20 run, after that run's Jev pass, in a run of its own that no sync
// shares. Both steps have a time budget counted from the start of the run, so neither can starve the other:
// Jev starts no call after 9 minutes and names start no request after 13. The demo has one run, which
// names after Jev, within the same two budgets.
describe("scheduled handler: merchant names", () => {
	async function oneUnnamedCharge() {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name) VALUES ('plaid-1', 1, '2026-09-20', 650, 'SQ *BLUE BOTTLE COF 0412')",
			),
		]);
	}
	const pending = () =>
		env.DB.prepare(
			"SELECT raw_name, suggested_name, display_name, suggestion_status FROM merchants",
		).all();

	it("asks no names in production's 09:00 or 09:40 run, which sync and sort", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee");
		await runScheduled({ ...env, DEMO: "false", AI: ai });
		await runSecondSort({ ...env, DEMO: "false", AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
		expect((await pending()).results).toEqual([]);
		vi.restoreAllMocks();
	});

	it("suggests names for a bank text Plaid didn't name in production's 09:20 run, as pending suggestions", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee\nBlue Bottle");
		await runFirstSort({ ...env, DEMO: "false", AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(1);
		expect((await pending()).results).toEqual([
			{
				raw_name: "SQ *BLUE BOTTLE COF 0412",
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
				display_name: null,
				suggestion_status: "pending",
			},
		]);
		vi.restoreAllMocks();
	});

	it("does nothing where there is no Workers AI binding, as in local development", async () => {
		await oneUnnamedCharge();
		await runSecondSort({ ...env, DEMO: "false" });
		await runScheduled({ ...env, DEMO: "false" });
		await runFirstSort({ ...env, DEMO: "false" });
		expect((await pending()).results).toEqual([]);
	});

	// A fake clock the test moves by hand: a slow request is a `tick`, never a real wait.
	const fakeClock = () => {
		let t = 0;
		return {
			now: () => t,
			tick: (ms: number) => {
				t += ms;
			},
		};
	};
	/** `n` charges nobody has sorted or named, each from a store of its own. */
	const addUnsorted = (n: number) =>
		env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				 SELECT 'plaid-' || i, 1, '2026-09-20', 500 + i, 'SHOP NUMBER ' || i FROM n`,
			).bind(n),
		]);
	/** One linked bank, so the 09:00 run has a sync to make. */
	async function linkOneBank() {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM feedback"),
		]);
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', 'item')",
		)
			.bind(await encryptToken("access-token", KEY))
			.run();
	}
	/**
	 * A fake Plaid sending `n` new transactions, each from a store of its own, in pages of at most 95 (Plaid's
	 * own pages are 100, the most one D1 query can bind), and a fake GitHub; `seen` hears each request.
	 */
	const fakeBanks = (
		n: number,
		seen: (what: "plaid" | "feedback" | "other") => void,
	) => {
		const PAGE = 95;
		let page = 0;
		return async (url: RequestInfo | URL) => {
			const text = String(url);
			if (text.includes("api.github.com")) {
				seen("feedback");
				return Response.json({ number: 5 }, { status: 201 });
			}
			if (!text.includes("/accounts/get") && !text.includes("/transactions/")) {
				seen("other");
				return new Response(null, { status: 500 });
			}
			seen("plaid");
			return text.endsWith("/accounts/get")
				? Response.json({
						accounts: [
							{
								account_id: "account",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					})
				: (() => {
						const from = page * PAGE;
						const to = Math.min(n, from + PAGE);
						page += 1;
						return Response.json({
							added: Array.from({ length: to - from }, (_, k) => ({
								transaction_id: `new-${from + k}`,
								account_id: "account",
								date: "2026-09-27",
								amount: 12 + from + k,
								name: `SHOP NUMBER ${from + k}`,
								pending: false,
							})),
							modified: [],
							removed: [],
							next_cursor: `page-${page}`,
							has_more: to < n,
						});
					})();
		};
	};
	const bank = {
		PLAID_CLIENT_ID: "client",
		PLAID_SECRET: "secret",
		TOKEN_ENCRYPTION_KEY: KEY,
	};

	it("ends production's 09:00 run at the feedback retry, asking no names and no Jev", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await linkOneBank();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		// A report old enough for the retry to file.
		await env.DB.prepare(
			"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), 'person', 'Question', 'Okay', 'Why?', '/', 'Desktop browser')",
		).run();
		const order: string[] = [];
		const note = (what: string) => {
			if (order.at(-1) !== what) order.push(what);
		};
		const fetchImpl = fakeBanks(3, note);
		const ai = {
			run: vi.fn(async () => {
				note("names");
				return { response: "Some Place Name" };
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		await runScheduled(
			{
				...env,
				...bank,
				DEMO: "false",
				AI: ai,
				JEV_API_KEY: "jev",
				FEEDBACK_GITHUB_TOKEN: "token",
			},
			fetchImpl as unknown as typeof fetch,
		);

		// No "other" request either: Jev, which the run never asks, would be one.
		expect(order).toEqual(["plaid", "feedback"]);
		expect(ai.run).not.toHaveBeenCalled();
		await env.DB.prepare("DELETE FROM feedback").run();
		vi.restoreAllMocks();
	});

	it("asks Jev first in the 09:20 run, then names, so the sort is never delayed by them", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const order: string[] = [];
		const ai = {
			run: vi.fn(async () => {
				order.push("names");
				return { response: "Blue Bottle Coffee" };
			}),
		} as unknown as Ai;
		const fetchImpl = vi.fn(async () => {
			order.push("jev");
			return jevAnswer();
		});
		await runFirstSort(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);
		expect(order).toEqual(["jev", "names"]);
		vi.restoreAllMocks();
	});

	/** How many of the household day's Jev calls are spoken for. */
	const callsCounted = async () =>
		Number(
			(
				await env.DB.prepare(
					"SELECT value FROM household_settings WHERE key GLOB 'jev_calls_*'",
				).first<{ value: string }>()
			)?.value ?? 0,
		);

	it("stops Jev at 9 minutes in the 09:20 run, gives back the calls it didn't ask, and lets names run until 13 minutes", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await addUnsorted(250);
		const clock = fakeClock();
		const order: string[] = [];
		// A slow Jev, a minute a call, and a name takes a minute too.
		const fetchImpl = vi.fn(async () => {
			order.push("jev");
			clock.tick(60_000);
			return jevAnswer();
		});
		const ai = {
			run: vi.fn(async () => {
				order.push("names");
				clock.tick(60_000);
				return { response: "Some Place Name" };
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		await runFirstSort(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
			{ now: clock.now },
		);

		// Jev started calls at 0:00 to 8:00 and none at 9:00. The names started at 9:00 to 12:00, none at 13:00.
		expect(fetchImpl).toHaveBeenCalledTimes(9);
		expect(ai.run).toHaveBeenCalledTimes(4);
		expect(order).toEqual([...Array(9).fill("jev"), ...Array(4).fill("names")]);
		// The 200 it reserved, less the 191 it gave back: the day shows only what was asked.
		expect(await callsCounted()).toBe(9);
		vi.restoreAllMocks();
	});

	it("stops Jev at 13 minutes in the 09:40 run, which asks no names", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await addUnsorted(400);
		const clock = fakeClock();
		const fetchImpl = vi.fn(async () => {
			clock.tick(60_000);
			return jevAnswer();
		});
		const ai = aiThatSays("Some Place Name");

		await runSecondSort(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
			{ now: clock.now },
		);

		// Calls started at 0:00 to 12:00, and none at 13:00.
		expect(fetchImpl).toHaveBeenCalledTimes(13);
		expect(ai.run).not.toHaveBeenCalled();
		expect(await callsCounted()).toBe(13);
		vi.restoreAllMocks();
	});

	it("gives the demo's one 09:00 run the same two deadlines: Jev's 9 minutes, then names' 13", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const clock = fakeClock();
		const order: string[] = [];
		const fetchImpl = vi.fn(async () => {
			order.push("jev");
			clock.tick(60_000);
			return jevAnswer();
		});
		const ai = {
			run: vi.fn(async () => {
				order.push("names");
				clock.tick(2 * 60_000);
				return { response: "Some Place Name" };
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		// DEMO is "true" here, with no Plaid secrets: this is the demo's run, which resets the seed first.
		await runScheduled(
			{ ...env, AI: ai, JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
			{ now: clock.now },
		);

		// The seed's 12 waiting: Jev started calls at 0:00 to 8:00 and none at 9:00. The names started at 9:00
		// and 11:00, none at 13:00.
		expect(fetchImpl).toHaveBeenCalledTimes(9);
		expect(ai.run).toHaveBeenCalledTimes(2);
		expect(order).toEqual([...Array(9).fill("jev"), "names", "names"]);
		vi.restoreAllMocks();
	});

	it("leaves the names to the 09:20 run, however big 09:00's sync was", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await linkOneBank();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const production = {
			...env,
			...bank,
			DEMO: "false",
			JEV_API_KEY: "jev",
		};
		const ai = {
			run: vi.fn(async () => ({ response: "Some Place Name" })),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		// 09:00: 190 new transactions, a sync that uses the whole run. It asks no names.
		await runScheduled(
			{ ...production, AI: ai },
			fakeBanks(190, () => {}) as unknown as typeof fetch,
		);
		expect(await count()).toBe(190);
		expect(ai.run).not.toHaveBeenCalled();

		// 09:20: the names have a run of their own, so all 100 of a night's are asked.
		await runFirstSort(
			{ ...production, AI: ai },
			vi.fn(async () => jevAnswer()) as unknown as typeof fetch,
		);
		expect(ai.run).toHaveBeenCalledTimes(100);
		vi.restoreAllMocks();
	});

	it("caps the 09:20 run's Jev pass at 200 calls, so its sort and names stay under D1's query limit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				 SELECT 'plaid-' || i, 1, '2026-09-20', 500 + i, 'SHOP NUMBER ' || i FROM n`,
			),
		]);
		const fetchImpl = vi.fn(async () =>
			Response.json({
				answers: {
					category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			}),
		);
		await runFirstSort(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(200);
		vi.restoreAllMocks();
	});

	it("asks about the demo's seeded bank texts in its one 09:00 run, since the demo has the binding (spec §4.1), within the nightly limit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const ai = aiThatSays("Some Place Name");
		await runScheduled({ ...env, AI: ai });
		expect(ai.run.mock.calls.length).toBeGreaterThan(0);
		expect(ai.run.mock.calls.length).toBeLessThanOrEqual(100);
		vi.restoreAllMocks();
	});

	it("keeps going when Workers AI fails, so the run still ends well after its sort", async () => {
		await oneUnnamedCharge();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const ai = {
			run: vi.fn(async () => {
				throw new Error("capacity");
			}),
		} as unknown as Ai;
		const fetchImpl = vi.fn(async () => jevAnswer());
		await expect(
			runFirstSort(
				{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toBeUndefined();
		expect((await pending()).results).toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		logged.mockRestore();
		vi.restoreAllMocks();
	});

	/** A DB whose sort step fails, as D1 can: the query for the categories Jev is offered throws. */
	const dbThatFailsTheSort = () =>
		new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						if (/FROM categories WHERE archived = 0/.test(sql))
							throw new Error("D1 is down for the secret text");
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

	it("still makes the names in the 09:20 run when the sort throws, and logs only the error's name", async () => {
		await oneUnnamedCharge();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		vi.spyOn(console, "log").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = aiThatSays("Blue Bottle Coffee");
		const fetchImpl = vi.fn(async () => jevAnswer());

		await expect(
			runFirstSort(
				{
					...env,
					DB: dbThatFailsTheSort(),
					DEMO: "false",
					AI: ai,
					JEV_API_KEY: "jev",
				},
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toBeUndefined();

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(ai.run).toHaveBeenCalledTimes(1);
		const lines = logged.mock.calls.map((call) => String(call.join(" ")));
		expect(lines).toContain("jev: sort step failed Error");
		expect(lines.join(" ")).not.toContain("secret text");
		logged.mockRestore();
		vi.restoreAllMocks();
	});

	it("still makes the names in the demo's one run when its sort throws", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = aiThatSays("Some Place Name");

		// DEMO is "true" here, with no Plaid secrets: the demo's run, which resets the seed first.
		await expect(
			runScheduled({
				...env,
				DB: dbThatFailsTheSort(),
				AI: ai,
				JEV_API_KEY: "jev",
			}),
		).resolves.toBeUndefined();

		expect(ai.run.mock.calls.length).toBeGreaterThan(0);
		expect(logged.mock.calls.map((call) => String(call.join(" ")))).toContain(
			"jev: sort step failed Error",
		);
		logged.mockRestore();
		vi.restoreAllMocks();
	});
});

// New category suggestions (spec §7, §8.6, #51): Workers AI proposes a name for three or more transactions
// Jev was sure no category fit. In production it runs last in the 09:20 run, after that run's Jev pass and
// its names, within the same 13-minute run budget; the demo's one run does it too, after its names. It
// follows Guess categories, and nothing it makes is a category: a person creates or dismisses it.
describe("scheduled handler: new category suggestions", () => {
	/** `n` confident "none of these fit" transactions of one theme, and nothing else to sort or name. */
	async function noneFitGroup(n = 3, theme = "ENTERTAINMENT") {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM category_suggestions"),
		]);
		await addNoneFit(n, theme);
	}
	const addNoneFit = (n: number, theme: string) =>
		env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			 INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, plaid_category, category_confidence, jev_none_fit)
			 SELECT 1, '2026-09-20', 1500, 'STREAM ' || i || ?, 'Stream ' || char(64 + i) || ?, ?, 0.95, 1 FROM n`,
		)
			.bind(n, theme, theme, theme)
			.run();
	const suggested = async () =>
		(
			await env.DB.prepare(
				"SELECT name, status FROM category_suggestions ORDER BY id",
			).all<{ name: string; status: string }>()
		).results;
	/** A fake Workers AI that says which kind of question it heard, and answers a category question with `name`. */
	const aiThatHears = (heard: string[], name = "Subscriptions") =>
		({
			run: vi.fn(async (_model: string, input: unknown) => {
				const user = (
					input as { messages: { role: string; content: string }[] }
				).messages.find((m) => m.role === "user")?.content;
				const kind = user?.startsWith("Places:") ? "categories" : "names";
				heard.push(kind);
				return { response: kind === "categories" ? name : "Some Place Name" };
			}),
		}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

	it("makes them last in production's 09:20 run, after the Jev pass and the names, and creates no category", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await noneFitGroup();
		await addUnsortedAndUnnamed();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const order: string[] = [];
		const ai = aiThatHears(order);
		const jev = vi.fn(async () => {
			order.push("jev");
			return jevAnswer();
		});
		const categoriesBefore = await categoryCount();

		await runFirstSort(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(order).toEqual(["jev", "names", "categories"]);
		expect(await suggested()).toEqual([
			{ name: "Subscriptions", status: "pending" },
		]);
		expect(await categoryCount()).toBe(categoriesBefore);
		vi.restoreAllMocks();
	});
	const addUnsortedAndUnnamed = () =>
		env.DB.prepare(
			"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name) VALUES ('plaid-1', 1, '2026-09-20', 650, 'SQ *BLUE BOTTLE COF 0412')",
		).run();
	const categoryCount = async () =>
		(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{
				n: number;
			}>()
		)?.n;

	it("makes none in production's 09:00 or 09:40 run, which sync and sort", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await noneFitGroup();
		const heard: string[] = [];
		const ai = aiThatHears(heard);
		await runScheduled({ ...env, DEMO: "false", AI: ai });
		await runSecondSort({ ...env, DEMO: "false", AI: ai });
		expect(heard).toEqual([]);
		expect(await suggested()).toEqual([]);
		vi.restoreAllMocks();
	});

	it("asks nothing in the 09:20 run for fewer than three, or with Guess categories off", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await noneFitGroup(2);
		const heard: string[] = [];
		const ai = aiThatHears(heard);
		await runFirstSort({ ...env, DEMO: "false", AI: ai });
		expect(heard).toEqual([]);

		await noneFitGroup(3);
		await saveAiSwitches(env.DB, { categories: false });
		await runFirstSort({ ...env, DEMO: "false", AI: ai });
		expect(heard).toEqual([]);
		expect(await suggested()).toEqual([]);
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		vi.restoreAllMocks();
	});

	it("does nothing in the 09:20 run where there is no Workers AI binding", async () => {
		await noneFitGroup();
		await runFirstSort({ ...env, DEMO: "false" });
		expect(await suggested()).toEqual([]);
	});

	it("starts no request after the run's 13 minutes, the names' deadline too, and keeps what it asked", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await noneFitGroup(3, "ONE");
		for (const theme of ["TWO", "THREE", "FOUR"]) await addNoneFit(3, theme);
		let t = 0;
		const heard: string[] = [];
		const ai = {
			run: vi.fn(async (_model: string, input: unknown) => {
				heard.push("categories");
				// Each takes five minutes: it starts at 0, 5 and 10, and a fourth would start at 15.
				t += 5 * 60_000;
				const places = (input as { messages: { content: string }[] })
					.messages[1]?.content;
				// A name of its own for each theme, so none is mistaken for another's.
				const theme = places?.match(/Stream A(\w+)/)?.[1] ?? "x";
				return { response: `Group ${theme}` };
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };

		await runFirstSort({ ...env, DEMO: "false", AI: ai }, undefined, {
			now: () => t,
		});

		expect(heard).toHaveLength(3);
		expect(await suggested()).toHaveLength(3);
		vi.restoreAllMocks();
	});

	it("is made in the demo's one run too, after its names, from what the sort found", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const order: string[] = [];
		const ai = aiThatHears(order);
		let found = false;
		// The demo's run resets first, so Jev's answers are put in as it goes: three confident none-fits.
		const jev = vi.fn(async () => {
			order.push("jev");
			if (!found) {
				found = true;
				await addNoneFit(3, "ENTERTAINMENT");
			}
			return jevAnswer();
		});
		await runScheduled(
			{ ...env, AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);
		expect(order.at(-1)).toBe("categories");
		expect(order.indexOf("names")).toBeGreaterThan(order.lastIndexOf("jev"));
		expect(order.filter((o) => o === "categories")).toHaveLength(1);
		expect((await suggested()).map((s) => s.name)).toContain("Subscriptions");
		vi.restoreAllMocks();
	});

	it("keeps the run going when Workers AI fails for it, and logs only the error's name", async () => {
		await noneFitGroup();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const ai = {
			run: vi.fn(async () => {
				throw Object.assign(new Error("failed for Stream A"), {
					name: "AiError",
				});
			}),
		} as unknown as Ai;
		await expect(
			runFirstSort({ ...env, DEMO: "false", AI: ai }),
		).resolves.toBeUndefined();
		expect(await suggested()).toEqual([]);
		const lines = logged.mock.calls
			.map((call) => String(call.join(" ")))
			.join("\n");
		expect(lines).toContain("AiError");
		expect(lines).not.toContain("Stream");
		logged.mockRestore();
		vi.restoreAllMocks();
	});
});

// D1 allows 1,000 queries in one Worker invocation, and every statement a run prepares is one. A Jev call
// costs about three (the switches read before and after it, and saving its answer), plus one merchant-history
// query per Jev run; a name costs about three too, and each new category suggestion about five. Each of
// production's three runs and the demo's one is an invocation of its own, so each has to fit its worst case:
// 09:00 the sync and feedback retry, 09:20 100 names, 200 Jev calls and 5 new category suggestions, and
// 09:40 300 Jev calls.
describe("scheduled handler: each run stays under D1's 1,000 queries", () => {
	const D1_LIMIT = 1000;
	const NEW_TRANSACTIONS = 100;

	/** A DB that counts every statement a run prepares, for D1's 1,000 queries per invocation. */
	function countingDb() {
		let statements = 0;
		const counted = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { db: counted as D1Database, statements: () => statements };
	}

	/** `n` charges nobody has sorted or named, each from a store of its own. */
	const addWaiting = (n: number) =>
		env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				 SELECT 'plaid-' || i, 1, '2026-09-20', 500 + i, 'SHOP NUMBER ' || i FROM n`,
			).bind(n),
		]);

	it("the scheduled names pass stays within 110 statements for 100 names", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(100);
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		await suggestMerchantNames({ DB: counted.db, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(100);
		// One candidate query, 100 writes and a fixed number of switch reads per 25-name batch.
		expect(counted.statements()).toBeLessThanOrEqual(110);
	});

	it("the demo's one run, which resets, sorts and names", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		const jev = vi.fn(async () => jevAnswer());

		// DEMO is "true" here, and there are no Plaid secrets: this is the demo's run.
		await runScheduled(
			{ ...env, DB: counted.db, AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(jev.mock.calls.length).toBeGreaterThan(0);
		expect(ai.run.mock.calls.length).toBeGreaterThan(0);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		// The seed leaves few to ask about; with every call the demo's caps allow, at about three queries each, it still fits.
		const unused =
			jevCallLimit({ DEMO: "true" }) -
			jev.mock.calls.length +
			(nameCallLimit - ai.run.mock.calls.length);
		// The seed holds a suggestion already, so its night makes no new one: the five it could, at about five each.
		expect(
			counted.statements() + unused * 3 + categoryCallLimit * 5,
		).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	// A sync costs about five queries for each new transaction and isn't capped here: a backfill bigger than
	// a busy night's is for the queue that lifts the per-run limit (#248). The feedback retry's worst case,
	// 20 old reports, is in the same invocation, so it is in the count. The names are not: they have the 09:20
	// run.
	it("production's 09:00 run, which syncs a busy night's 100 new transactions and retries 20 reports", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM feedback"),
		]);
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
			 INSERT INTO feedback (created_at, actor, type, feeling, message, page, device)
			 SELECT datetime('now', '-11 minutes'), 'person', 'Question', 'Okay', 'Why ' || i, '/', 'Desktop browser' FROM n`,
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', 'item')",
		)
			.bind(await encryptToken("access-token", KEY))
			.run();
		const fetchImpl = async (url: RequestInfo | URL) =>
			String(url).includes("api.github.com")
				? Response.json({ number: 5 }, { status: 201 })
				: String(url).endsWith("/accounts/get")
					? Response.json({
							accounts: [
								{
									account_id: "account",
									name: "Checking",
									type: "depository",
									balances: { current: 10 },
								},
							],
						})
					: Response.json({
							added: Array.from({ length: NEW_TRANSACTIONS }, (_, i) => ({
								transaction_id: `new-${i}`,
								account_id: "account",
								date: "2026-09-27",
								amount: 12 + i,
								name: `SHOP NUMBER ${i}`,
								pending: false,
							})),
							modified: [],
							removed: [],
							next_cursor: "next",
							has_more: false,
						});
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");

		await runScheduled(
			{
				...env,
				DB: counted.db,
				DEMO: "false",
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
				TOKEN_ENCRYPTION_KEY: KEY,
				JEV_API_KEY: "jev",
				FEEDBACK_GITHUB_TOKEN: "token",
				AI: ai,
			},
			fetchImpl,
		);

		expect(await count()).toBe(NEW_TRANSACTIONS);
		expect(ai.run).not.toHaveBeenCalled();
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM feedback WHERE github_issue_number IS NOT NULL",
				).first<{ n: number }>()
			)?.n,
		).toBe(20);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		await env.DB.prepare("DELETE FROM feedback").run();
		vi.restoreAllMocks();
	}, 60_000);

	it("production's 09:20 run, which asks Jev about up to 200, then 100 names, then 5 new category suggestions", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(400);
		// Seven themes with three confident none-fits each: more than a night asks about, each its own name.
		for (const theme of ["A", "B", "C", "D", "E", "F", "G"])
			await env.DB.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_category, category_confidence, jev_none_fit)
				 VALUES (1, '2026-09-20', 900, 'PLACE ' || ?1 || ' ONE', ?1, 0.95, 1),
					(1, '2026-09-20', 900, 'PLACE ' || ?1 || ' TWO', ?1, 0.95, 1),
					(1, '2026-09-20', 900, 'PLACE ' || ?1 || ' THREE', ?1, 0.95, 1)`,
			)
				.bind(theme)
				.run();
		const counted = countingDb();
		let named = 0;
		const ai = {
			run: vi.fn(async (_model: string, input: unknown) => {
				const user = (
					input as { messages: { role: string; content: string }[] }
				).messages.find((m) => m.role === "user")?.content;
				// A new name for each group, so each one is saved as a suggestion of its own.
				return user?.startsWith("Places:")
					? { response: `Group ${String.fromCharCode(65 + named++)}` }
					: { response: "Some Place Name" };
			}),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		const jev = vi.fn(async () => jevAnswer());

		await runFirstSort(
			{ ...env, DB: counted.db, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(ai.run).toHaveBeenCalledTimes(nameCallLimit + categoryCallLimit);
		expect(jev).toHaveBeenCalledTimes(200);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM category_suggestions WHERE status = 'pending'",
				).first<{ n: number }>()
			)?.n,
		).toBe(categoryCallLimit);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	it("production's 09:40 run, which asks Jev about up to 300 and no names", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		await addWaiting(400);
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		const jev = vi.fn(async () => jevAnswer());

		await runSecondSort(
			{ ...env, DB: counted.db, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(ai.run).not.toHaveBeenCalled();
		expect(jev).toHaveBeenCalledTimes(300);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);
});
