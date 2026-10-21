import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { markStroke, readFirstTally } from "../src/db/first-tally";
import { loadMonth } from "../src/db/month";
import { resetDemo as resetDemoBase } from "../src/demo/reset";
import { monthOffset } from "../src/demo/seed";
import {
	needsYouCount,
	recordNightSync,
	utcDay,
} from "../src/first-tally/night";
import handler, { runScheduled } from "../src/index";
import type { SyncAllResult } from "../src/plaid/sync-all";
import { encryptToken } from "../src/plaid/token-crypto";
import { runSortInstance } from "../src/sort-instance";
import {
	nameCallLimit,
	suggestMerchantNames,
} from "../src/suggest-names-pending";
import { fakeSteps } from "./fake-sort-steps";
import { recordSorting, sortInProcess } from "./record-sorting";

// Every 09:00 request here starts its night's instance on a recorder, so no real Workflow starts (test/record-sorting.ts).
// A test that checks what the night makes runs that instance in this process (sortInProcess or runSortInstance).
const create = recordSorting();

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
			kind: { type: "choice", choice: "one_off", confidence: 0.99 },
			for_person: { type: "choice", choice: "none", confidence: 0.99 },
			note_worth_writing: { type: "noul", noul: 0.95 },
		},
	});

/** A fake Workers AI that always gives the same answer, and remembers each ask. */
const aiThatSays = (response: string) =>
	({ run: vi.fn(async () => ({ response })) }) as unknown as Ai & {
		run: ReturnType<typeof vi.fn>;
	};

/** The night the 09:00 runs below sync for, as UTC dates (the cron's own day, not a household day). */
const NIGHT = "2026-10-13";

/**
 * The night's instance run in this process, as the Workflow runs it (sort-instance.ts): the sorting, then the night's
 * names and suggestions, then (production) the counts for `night`. For tests about what the night makes.
 */
const runNight = (
	instanceEnv: Parameters<typeof runSortInstance>[0],
	options: {
		night?: string;
		fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
		now?: () => number;
		/** Steps that fail on every attempt, as a step that ran out of retries. */
		fails?: string[];
	} = {},
) =>
	runSortInstance(
		instanceEnv,
		fakeSteps({ fails: options.fails }).runStep,
		{ bySync: false, rulesApplied: false, night: options.night ?? NIGHT },
		{
			runId: crypto.randomUUID(),
			fetchImpl: options.fetchImpl,
			now: options.now,
		},
	);

// Each test is a new household day, so Jev calls one test makes aren't counted against the next one's cap.
// A night that throws after its read can't leave the sorting turn held for the next test.
beforeEach(async () => {
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key GLOB 'jev_calls_*' OR key = 'sorting_turn'",
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

	it("leaves Jev out when there is no key, so the uncategorized seed rows stay uncategorized", async () => {
		const day = utcDay(Date.now());
		await worker.scheduled({ cron: "0 9 * * *" });
		// The 09:00 run starts the night's instance even with no Jev key: its names and suggestions need none.
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			params: { bySync: false, rulesApplied: false, night: day },
		});

		const untouched = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL AND category_source IS NULL AND category_confidence IS NULL AND flag_income = 0 AND excluded = 0",
		).first<{ n: number }>();
		expect(untouched?.n).toBeGreaterThanOrEqual(10);
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

	// Spec §8.6: the night's sorting reads the household's AI switches too.
	it.each([
		{ categories: false, income: false, calls: 0 },
		{ categories: true, income: false, calls: 10 },
		{ categories: false, income: true, calls: 10 },
	])(
		"asks Jev $calls times in the night's instance with categories $categories and income $income",
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
			const prodEnv = { ...env, DEMO: "false", JEV_API_KEY: "jev" };
			await runScheduled({
				...prodEnv,
				SORT: sortInProcess(prodEnv, {
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}).SORT,
			});

			expect(fetchImpl).toHaveBeenCalledTimes(calls);
			vi.restoreAllMocks();
		},
	);

	it("asks Jev nothing itself in production's 09:00 run: it syncs and starts the night's instance (decision 139)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		const fetchImpl = vi.fn(async () => jevAnswer());

		await runScheduled(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
	});
});

// Which run each cron starts (decision 139): production has two, the 09:00 sync, which starts the night's Workflow
// instance, and the 10:00 reminders; the demo has one. The entry point routes by the cron that fired.
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

	it("asks Jev and Workers AI nothing at 09:00, which syncs, starts the night's instance and retries feedback", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		create.mockClear();
		expect(await fire("0 9 * * *")).toEqual({ jev: 0, names: 0 });
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			params: { bySync: false, rulesApplied: false, night: utcDay(Date.now()) },
		});
		vi.restoreAllMocks();
	});

	it("starts no instance at 10:00, which sends the reconnect reminders", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		create.mockClear();
		expect(await fire("0 10 * * *")).toEqual({ jev: 0, names: 0 });
		expect(create).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});

// The minute run (decision 146): each minute in production runs the ready email alone. A family whose questions are open
// and whose person has left gets the email on the first minute, nothing on the next, and nothing ever in the demo.
describe("scheduled handler: the minute run for the ready email (decision 146)", () => {
	/** A family whose questions are open: a bank with its history in, stroke one drawn, no waiting, Dana on the list. */
	async function openFamily() {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, { categories: false, income: false });
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE plaid_items SET disconnected_at = NULL, last_synced_at = '2026-10-13 09:00:00', history_complete_at = '2026-10-13 09:00:00'",
			),
			env.DB.prepare("DELETE FROM household_members"),
			env.DB.prepare(
				"INSERT INTO household_members (email, last_seen_at) VALUES ('dana@example.com', datetime('now'))",
			),
			env.DB.prepare(
				"DELETE FROM household_settings WHERE key = 'first_tally'",
			),
			env.DB.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
			).bind(JSON.stringify({ strokes: { bank: "2026-10-13" }, budgets: {} })),
		]);
	}

	it("sends the ready email once with the questions open, starts no sorting instance, and sends nothing more the next minute", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await openFamily();
		create.mockClear();
		const resend = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({}, { status: 200 }));
		const minuteEnv = {
			...env,
			DEMO: "false",
			RESEND_API_KEY: "key",
			EMAIL: undefined,
		};
		await scheduledWith.scheduled({ cron: "* * * * *" }, minuteEnv);
		expect(resend).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
		await scheduledWith.scheduled({ cron: "* * * * *" }, minuteEnv);
		expect(resend).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
	});

	it("never runs in the demo", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await openFamily();
		create.mockClear();
		const resend = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({}, { status: 200 }));
		await scheduledWith.scheduled(
			{ cron: "* * * * *" },
			{ ...env, DEMO: "true", RESEND_API_KEY: "key" },
		);
		expect(resend).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});

it("logs a night that fails to start by its error name, and the feedback retry still runs", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	await env.DB.prepare(
		"INSERT INTO feedback (created_at, actor, type, feeling, message, page, device) VALUES (datetime('now', '-11 minutes'), 'person', 'Question', 'Okay', 'Why?', '/', 'Desktop browser')",
	).run();
	create.mockRejectedValueOnce(new TypeError("secret transaction text"));
	const github = vi.fn(async () =>
		Response.json({ number: 5 }, { status: 201 }),
	);

	await expect(
		runScheduled(
			{ ...env, DEMO: "false", FEEDBACK_GITHUB_TOKEN: "token" },
			github as unknown as typeof fetch,
		),
	).resolves.toBeUndefined();

	expect(logged).toHaveBeenCalledWith("sorting: couldn't start TypeError");
	expect(JSON.stringify(logged.mock.calls)).not.toContain(
		"secret transaction text",
	);
	expect(github).toHaveBeenCalledTimes(1);
	await env.DB.prepare("DELETE FROM feedback").run();
	vi.restoreAllMocks();
});

// The night's names step (spec §7, §9, #33): Workers AI suggests names where there is a binding. It runs in the
// night's instance, as a step of its own right after the sorting, so Jev's answers come first (decision 139). Each
// step has a time budget counted from its own start (sort-instance.test.ts).
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

	it("asks no names in production's 09:00 run, which syncs and starts the night's instance", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee");
		const prodEnv = { ...env, DEMO: "false", AI: ai };
		await runScheduled(prodEnv);
		expect(ai.run).not.toHaveBeenCalled();
		expect((await pending()).results).toEqual([]);
		vi.restoreAllMocks();
	});

	it("suggests names for a bank text Plaid didn't name in the night's instance, as pending suggestions", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee\nBlue Bottle");
		await runNight({ ...env, DEMO: "false", AI: ai });
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

	it("asks about the 3 names waiting in the night's instance, though 150 untried notes come first (#458)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, details_asked, note_worth_writing)
				 SELECT 'plaid-note-' || i, 1, '2026-09-20', 650, 'NOTE SHOP ' || i, 'Note Shop', 1, 1 FROM n`,
			),
			env.DB.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)
				 INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
				 SELECT 'plaid-name-' || i, 1, '2026-09-20', 500 + i, 'SHOP NUMBER ' || i FROM n`,
			),
		]);
		// A note's call answers empty, so it is tried and not asked again; a name's call answers a name.
		const ai = {
			run: vi.fn(async (_model: string, input: unknown) => ({
				response: JSON.stringify(input).includes("NOTE SHOP")
					? ""
					: "Some Place Name",
			})),
		} as unknown as Ai & { run: ReturnType<typeof vi.fn> };
		await runNight({ ...env, DEMO: "false", AI: ai });
		const asked = ai.run.mock.calls.map(([, input]) => JSON.stringify(input));
		expect(asked.filter((text) => text.includes("NOTE SHOP"))).toHaveLength(
			nameCallLimit / 2,
		);
		expect(asked.filter((text) => text.includes("SHOP NUMBER"))).toHaveLength(
			3,
		);
		vi.restoreAllMocks();
	});

	it("does nothing where there is no Workers AI binding, as in local development", async () => {
		await oneUnnamedCharge();
		await runScheduled({ ...env, DEMO: "false" });
		await runNight({ ...env, DEMO: "false" });
		expect((await pending()).results).toEqual([]);
	});

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

		const prodEnv = {
			...env,
			...bank,
			DEMO: "false",
			AI: ai,
			JEV_API_KEY: "jev",
			FEEDBACK_GITHUB_TOKEN: "token",
		};
		await runScheduled(prodEnv, fetchImpl as unknown as typeof fetch);

		// No "other" request either: Jev, which the run never asks, would be one.
		expect(order).toEqual(["plaid", "feedback"]);
		expect(ai.run).not.toHaveBeenCalled();
		await env.DB.prepare("DELETE FROM feedback").run();
		vi.restoreAllMocks();
	});

	it("asks Jev first in the night's instance, then names, so the sort is never delayed by them", async () => {
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
		const prodEnv = { ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" };
		const night = sortInProcess(prodEnv, { fetchImpl });
		await runScheduled({ ...prodEnv, SORT: night.SORT });
		expect(order).toEqual(["jev", "names"]);
		// The step order: the group's save, then the names' step.
		const names = night.runs[0]?.names() ?? [];
		expect(names.indexOf("group-1-write")).toBeLessThan(
			names.indexOf("night-names"),
		);
		vi.restoreAllMocks();
	});

	it("asks about the demo's seeded bank texts in its one 09:00 run's night, since the demo has the binding (spec §4.1), within the nightly limit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const ai = aiThatSays("Some Place Name");
		// DEMO is "true" here, with no Plaid secrets: the demo's run resets the seed, then starts its night's instance.
		const demo = { ...env, AI: ai };
		await runScheduled({ ...demo, SORT: sortInProcess(demo).SORT });
		expect(ai.run.mock.calls.length).toBeGreaterThan(0);
		expect(ai.run.mock.calls.length).toBeLessThanOrEqual(100);
		vi.restoreAllMocks();
	});

	it("keeps going when Workers AI fails, so the night's instance still ends after its sort", async () => {
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
			runNight(
				{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
				{ fetchImpl },
			),
		).resolves.toBeUndefined();
		// The failed name makes no merchant row, and is recorded as failed apart from merchants (#468).
		expect((await pending()).results).toEqual([]);
		expect(
			(
				await env.DB.prepare(
					"SELECT raw_name FROM merchant_name_failures",
				).all<{ raw_name: string }>()
			).results,
		).toEqual([{ raw_name: "SQ *BLUE BOTTLE COF 0412" }]);
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

	it("still makes the names in the night's instance when the sort throws, and logs only the error's name", async () => {
		await oneUnnamedCharge();
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		vi.spyOn(console, "log").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = aiThatSays("Blue Bottle Coffee");
		const fetchImpl = vi.fn(async () => jevAnswer());
		const prodEnv = {
			...env,
			DB: dbThatFailsTheSort(),
			DEMO: "false",
			AI: ai,
			JEV_API_KEY: "jev",
		};

		await expect(
			runScheduled({
				...prodEnv,
				SORT: sortInProcess(prodEnv, { fetchImpl }).SORT,
			}),
		).resolves.toBeUndefined();

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(ai.run).toHaveBeenCalledTimes(1);
		const lines = logged.mock.calls.map((call) => String(call.join(" ")));
		expect(lines).toContain("sorting: stopped Error");
		expect(lines.join(" ")).not.toContain("secret text");
		logged.mockRestore();
		vi.restoreAllMocks();
	});

	it("still makes the names in the demo's one run when its sort throws", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = aiThatSays("Some Place Name");

		// DEMO is "true" here, with no Plaid secrets: the demo's run, which resets the seed first.
		const demoEnv = {
			...env,
			DB: dbThatFailsTheSort(),
			AI: ai,
			JEV_API_KEY: "jev",
		};
		await expect(
			runScheduled({
				...demoEnv,
				SORT: sortInProcess(demoEnv).SORT,
			}),
		).resolves.toBeUndefined();

		expect(ai.run.mock.calls.length).toBeGreaterThan(0);
		expect(logged.mock.calls.map((call) => String(call.join(" ")))).toContain(
			"sorting: stopped Error",
		);
		logged.mockRestore();
		vi.restoreAllMocks();
	});
});

// New category suggestions (spec §7, §8.6, #51): Workers AI proposes a name for three or more transactions
// Jev was sure no category fit. The night's instance makes them last, after its sorting and its names, each step
// within its own 13-minute budget (decision 139); the demo's one night does it too, after its names. It
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

	it("makes them last in the night's instance, after the Jev pass and the names, and creates no category", async () => {
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

		await runNight(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			{ fetchImpl: jev },
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

	it("asks nothing in the night's instance for fewer than three, or with Guess categories off", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await noneFitGroup(2);
		const heard: string[] = [];
		const ai = aiThatHears(heard);
		await runNight({ ...env, DEMO: "false", AI: ai });
		expect(heard).toEqual([]);

		await noneFitGroup(3);
		await saveAiSwitches(env.DB, { categories: false });
		await runNight({ ...env, DEMO: "false", AI: ai });
		expect(heard).toEqual([]);
		expect(await suggested()).toEqual([]);
		await saveAiSwitches(env.DB, { ...AI_SWITCHES_ALL_ON, details: false });
		vi.restoreAllMocks();
	});

	it("does nothing in the night's instance where there is no Workers AI binding", async () => {
		await noneFitGroup();
		await runNight({ ...env, DEMO: "false" });
		expect(await suggested()).toEqual([]);
	});

	it("is made in the demo's one night too, after its names, from what the sort found", async () => {
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
		const demo = { ...env, AI: ai, JEV_API_KEY: "jev" };
		await runScheduled({
			...demo,
			SORT: sortInProcess(demo, { fetchImpl: jev }).SORT,
		});
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
			runNight({ ...env, DEMO: "false", AI: ai }),
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

// D1 allows 1,000 queries in one Worker invocation. A batch is one request, so in production a batch may count once
// rather than statement by statement (the D1 limits page doesn't say; issue #418). This check counts every statement a
// run prepares, a conservative check: a run under it fits under either reading. A Jev call
// costs about three (the switches read, and saving its answer with its log row in one batch), plus one merchant-history
// query per Jev run; a name costs about three too, and each new category suggestion about five. Each of
// production's 09:00 run and the demo's are each an invocation of their own. Each one's sync, feedback retry and start
// of the night's Workflow has to fit; the night's sorting, names and suggestions are the Workflow's steps, each with its
// own budget (sort-instance.test.ts), not this invocation's queries (decision 139).
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

	it("cleans old cash snapshots in a fixed number of statements and keeps today's", async () => {
		const countFor = async (n: number) => {
			await env.DB.prepare("DELETE FROM cash_delete_holds").run();
			if (n > 0)
				await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
					INSERT INTO cash_delete_holds (token,created_at,display_name,transaction_row,split_rows,payment_rows,refund_rows)
					SELECT 'old-'||i, ?-86400001, 'old', '{}', '[]', '[]', '[]' FROM n`)
					.bind(n, Date.now())
					.run();
			await env.DB.prepare(
				"INSERT INTO cash_delete_holds (token,created_at,display_name,transaction_row,split_rows,payment_rows,refund_rows) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind("new", Date.now(), "new", "{}", "[]", "[]", "[]")
				.run();
			const counted = countingDb();
			await runScheduled({ ...env, DB: counted.db, DEMO: "false" });
			return counted.statements();
		};
		const few = await countFor(1);
		const remaining = await env.DB.prepare(
			"SELECT token FROM cash_delete_holds",
		).all<{ token: string }>();
		expect(remaining.results.map(({ token }) => token)).toEqual(["new"]);
		const many = await countFor(500);
		expect(
			(
				await env.DB.prepare("SELECT token FROM cash_delete_holds").all<{
					token: string;
				}>()
			).results.map(({ token }) => token),
		).toEqual(["new"]);
		expect(many).toBeLessThan(100);
		expect(many).toBe(few);
		// The cash cleanup is one statement, and the 09:00 run's night sync (#586) is one more, whatever the count.
		expect(few).toBe(2);
		expect(many).toBe(2);
	});

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

	it("the scheduled names pass saves 100 names in a small fixed statement count", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(100);
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		await suggestMerchantNames({ DB: counted.db, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(100);
		// One candidate query and the switch read, then for every five calls a switch read and two writes (the
		// merchants upsert and the failures delete): 1 + 1 + 20 × 3 = 62.
		expect(counted.statements()).toBeLessThanOrEqual(62);
	});

	it("the scheduled names pass's worst mixed night, every merchant already failed and calls alternating fail and answer, stays under 82 statements", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(100);
		await env.DB.prepare(
			"INSERT INTO merchant_name_failures (raw_name, failed_at) SELECT raw_name, '2026-10-01 09:25:00' FROM transactions",
		).run();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const counted = countingDb();
		let calls = 0;
		const ai = {
			run: vi.fn(async () => {
				calls += 1;
				// Every odd call fails, so three never fail in a row and all 100 are asked: 20 batches, each with both.
				if (calls % 2 === 1) throw new Error("capacity");
				return { response: "Some Place Name" };
			}),
		} as unknown as Ai;
		await suggestMerchantNames({ DB: counted.db, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(100);
		// 1 + 1 + 20 × 4 = 82: a switch read, a merchants upsert, a failures upsert and a failures delete per batch.
		expect(counted.statements()).toBeLessThanOrEqual(82);
		logged.mockRestore();
		vi.restoreAllMocks();
	});

	it("the demo's one 09:00 run, which resets and starts the night's instance, makes no call and stays under the limit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		const jev = vi.fn(async () => jevAnswer());

		// DEMO is "true" here, and there are no Plaid secrets: this is the demo's run.
		const demoEnv = { ...env, DB: counted.db, AI: ai, JEV_API_KEY: "jev" };
		await runScheduled(demoEnv, jev as unknown as typeof fetch);

		expect(jev).not.toHaveBeenCalled();
		expect(ai.run).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	// A sync costs about five queries for each new transaction and isn't capped here: the night's sorting of a big
	// backfill runs as the Workflow's steps, not in this invocation (decision 139). The feedback retry's worst case,
	// 20 old reports, is in the same invocation, so it is in the count. The names are not: they are the Workflow's steps.
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

		const prodEnv = {
			...env,
			DB: counted.db,
			DEMO: "false",
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			TOKEN_ENCRYPTION_KEY: KEY,
			JEV_API_KEY: "jev",
			FEEDBACK_GITHUB_TOKEN: "token",
			AI: ai,
		};
		await runScheduled(prodEnv, fetchImpl);

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
});

/** A UTC clock for a run, so a test pins the night's day (the 09:00 cron runs at 09:00 UTC). */
const runAt = (iso: string) => ({ now: () => Date.parse(iso) });

/** A Plaid fake for one bank: its one account, and `added` new transactions; `failSync` makes its sync fail. */
const plaidBank = (
	prefix: string,
	{ added, failSync = false }: { added: number; failSync?: boolean },
) =>
	vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return Response.json({
				accounts: [
					{
						account_id: "account",
						name: "Checking",
						type: "depository",
						balances: { current: 10 },
					},
				],
			});
		}
		if (failSync) return new Response("unavailable", { status: 500 });
		return Response.json({
			added: Array.from({ length: added }, (_, i) => ({
				transaction_id: `${prefix}-${i}`,
				account_id: "account",
				date: "2026-10-13",
				amount: 12,
				name: `${prefix} SHOP ${i}`,
				pending: false,
			})),
			modified: [],
			removed: [],
			next_cursor: "next",
			has_more: false,
		});
	});

/** One bank's item, connected, with the encrypted token a sync reads. */
const linkBank = async (name: string, status: "ok" | "needs_attention") =>
	env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id, status) VALUES (?, ?, 'person@example.com', ?, ?)",
	)
		.bind(await encryptToken("access-token", KEY), name, `item-${name}`, status)
		.run();

/** A household with its bank linked and pay, bills and budgets drawn, and no night kept yet. */
const answeredHousehold = async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchants"),
		env.DB.prepare("DELETE FROM merchant_name_failures"),
		env.DB.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
	]);
	await linkBank("Chase", "ok");
	for (const stroke of ["bank", "pay", "bills", "budgets"] as const) {
		await markStroke(env.DB, stroke, "2026-10-12");
	}
};

/** The production run's environment: Plaid on, no Jev key, and the given AI binding (none by default). */
const production = (extra: Record<string, unknown> = {}) => ({
	...env,
	DEMO: "false",
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: KEY,
	JEV_API_KEY: undefined,
	AI: undefined,
	...extra,
});

/** Jev's switches for a night test: categories on or off, the others off. */
const switches = (categories: boolean, names = false) =>
	saveAiSwitches(env.DB, {
		names,
		details: false,
		categories,
		income: false,
		sortOnArrival: false,
	});

describe("scheduled handler: the first night's counts (P125 E, #586)", () => {
	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await switches(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the night's counts in the night's instance once the sync was clean and nothing waits", async () => {
		await answeredHousehold();
		const prod = production();
		const night = sortInProcess(prod);

		await runScheduled(
			{ ...prod, SORT: night.SORT },
			plaidBank("CHASE", { added: 2 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		expect(night.create).toHaveBeenCalledWith({
			params: { bySync: false, rulesApplied: false, night: "2026-10-13" },
		});

		// The instance keeps the night at the end of the 09:00 run: both new transactions need a category, and
		// nothing else asks a question.
		expect((await readFirstTally(env.DB))?.night).toEqual({
			brought: 2,
			needYou: 2,
		});
		expect((await readFirstTally(env.DB))?.nightSync).toBeUndefined();
	});

	it("records no sync before the three questions are answered", async () => {
		await answeredHousehold();
		await env.DB.prepare(
			"DELETE FROM household_settings WHERE key = 'first_tally'",
		).run();
		await markStroke(env.DB, "bank", "2026-10-12");

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		expect((await readFirstTally(env.DB))?.nightSync).toBeUndefined();
	});

	it("records the night not ok when a bank's sync failed, and keeps nothing", async () => {
		await answeredHousehold();

		await runScheduled(
			production(),
			plaidBank("CHASE", {
				added: 1,
				failSync: true,
			}) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		expect((await readFirstTally(env.DB))?.nightSync).toEqual({
			brought: 0,
			on: "2026-10-13",
			ok: false,
		});
		await runNight(production(), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();
	});

	it("records the night not ok when a connected bank needs signing in, though the others synced", async () => {
		await answeredHousehold();
		await linkBank("Wells Fargo", "needs_attention");

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		expect((await readFirstTally(env.DB))?.nightSync).toEqual({
			brought: 1,
			on: "2026-10-13",
			ok: false,
		});
		await runNight(production(), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();
	});

	it("keeps nothing in the night's instance while Jev still has a transaction waiting for its category", async () => {
		await answeredHousehold();
		await switches(true);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		await runNight(production(), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();
	});

	it("keeps nothing while a bank text is still waiting for its name, when Workers AI is bound and the switch is on", async () => {
		await answeredHousehold();
		await switches(false, true);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		// The names step fails before it asks, so the bank text is still waiting for its name when the counts step runs.
		await runNight(production({ AI: aiThatSays("Some Place Name") }), {
			night: "2026-10-13",
			fails: ["night-names"],
		});
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();
	});

	it("does not wait for names when Workers AI is unbound, though the names switch is on", async () => {
		await answeredHousehold();
		await switches(false, true);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		await runNight(production({ AI: undefined }), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toEqual({
			brought: 1,
			needYou: 1,
		});
	});

	it("does not wait for names when the names switch is off, though Workers AI is bound", async () => {
		await answeredHousehold();
		await switches(false, false);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		await runNight(production({ AI: aiThatSays("[]") }), {
			night: "2026-10-13",
		});
		expect((await readFirstTally(env.DB))?.night).toEqual({
			brought: 1,
			needYou: 1,
		});
	});

	it("counts a bank text whose name call failed as done, so it never holds the night", async () => {
		await answeredHousehold();
		await switches(false, true);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		// The name call fails, so its failure is recorded, and a failed name counts as done.
		const failing = {
			run: vi.fn(async () => {
				throw new Error("capacity");
			}),
		} as unknown as Ai;
		await runNight(production({ AI: failing }), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toEqual({
			brought: 1,
			needYou: 1,
		});
	});

	it("replaces a sync of a night that did not finish with the next 09:00 run's", async () => {
		await answeredHousehold();
		await switches(true);

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 3 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		await runNight(production(), { night: "2026-10-13" });
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();

		await switches(false);
		await runScheduled(
			production(),
			plaidBank("LATER", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-14T09:00:00Z"),
		);
		expect((await readFirstTally(env.DB))?.nightSync).toEqual({
			brought: 1,
			on: "2026-10-14",
			ok: true,
		});
		await runNight(production(), { night: "2026-10-14" });
		// The three from the unfinished night still need a category too.
		expect((await readFirstTally(env.DB))?.night).toEqual({
			brought: 1,
			needYou: 4,
		});
	});

	it("keeps nothing in the night's instance when the 09:00 sync was for another day", async () => {
		await answeredHousehold();

		await runScheduled(
			production(),
			plaidBank("CHASE", { added: 1 }) as unknown as typeof fetch,
			runAt("2026-10-13T09:00:00Z"),
		);
		await runNight(production(), { night: "2026-10-14" });
		expect((await readFirstTally(env.DB))?.night).toBeUndefined();
	});

	it("records no sync in the demo's 09:00 run, whose night has no counts step", async () => {
		await answeredHousehold();
		const demo = { ...env, DEMO: "true", AI: undefined };
		const night = sortInProcess(demo);

		await runScheduled(
			{ ...demo, SORT: night.SORT },
			undefined,
			runAt("2026-10-13T09:00:00Z"),
		);
		expect(await readFirstTally(env.DB)).toBeNull();
		expect(night.runs[0]?.names()).not.toContain("night-counts");
	});
});

describe("the night's needs-you count (P125 E, #586)", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM merchant_name_failures"),
		]);
	});

	const all = {
		names: false,
		details: false,
		categories: true,
		income: true,
		sortOnArrival: false,
	};

	it("counts a transaction once, even when it needs a category and is also a category Maybe", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) VALUES ((SELECT MIN(id) FROM accounts), 'needs-once', '2026-10-13', 1000, 'ONCE SHOP')",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET jev_category_id = (SELECT id FROM categories WHERE archived = 0 LIMIT 1), category_confidence = 0.5 WHERE plaid_transaction_id = 'needs-once'",
		).run();
		expect(await needsYouCount(env.DB, all)).toBe(1);
	});

	it("counts a held credit once, though it is also an income Maybe", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) VALUES ((SELECT MIN(id) FROM accounts), 'held-credit', '2026-10-13', -5000, 'HELD CREDIT')",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET income_confidence = 0.6 WHERE plaid_transaction_id = 'held-credit'",
		).run();
		expect(await needsYouCount(env.DB, all)).toBe(1);
	});

	it("adds the name suggestion a person still has to choose", async () => {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) VALUES ((SELECT MIN(id) FROM accounts), 'named', '2026-10-13', 1000, 'SHOP NAMED')",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('SHOP NAMED', 'Named Shop', 'pending')",
		).run();
		// The transaction needs a category, and its name is waiting for a choice.
		expect(await needsYouCount(env.DB, { ...all, names: true })).toBe(2);
	});
});

describe("recordNightSync's result", () => {
	const synced = (over: Partial<SyncAllResult>): SyncAllResult => ({
		added: 2,
		modified: 0,
		changedIds: [],
		synced: 1,
		skipped: 0,
		busy: 0,
		failed: 0,
		failedBanks: [],
		...over,
	});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare(
				"DELETE FROM household_settings WHERE key = 'first_tally'",
			),
		]);
		await linkBank("Chase", "ok");
		for (const stroke of ["bank", "pay", "bills", "budgets"] as const) {
			await markStroke(env.DB, stroke, "2026-10-12");
		}
	});

	it.each([
		["a failed bank", { failed: 1 }],
		["a skipped bank", { skipped: 1 }],
		[
			"a failed household step after the banks",
			{ afterSyncFailed: true as const },
		],
		// Plaid switched off is no sync at all, so the night isn't clean (#714).
		["Plaid switched off", { disabled: true as const }],
	])("is not ok with %s", async (_, over) => {
		await recordNightSync(env.DB, synced(over), "2026-10-13");
		expect((await readFirstTally(env.DB))?.nightSync).toEqual({
			brought: 2,
			on: "2026-10-13",
			ok: false,
		});
	});

	it("is ok only when every connected bank is ok and nothing failed or was skipped", async () => {
		await recordNightSync(env.DB, synced({}), "2026-10-13");
		expect((await readFirstTally(env.DB))?.nightSync).toEqual({
			brought: 2,
			on: "2026-10-13",
			ok: true,
		});
	});

	it("ignores a disconnected bank that needs signing in", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention', disconnected_at = datetime('now')",
		).run();
		await recordNightSync(env.DB, synced({}), "2026-10-13");
		expect((await readFirstTally(env.DB))?.nightSync?.ok).toBe(true);
	});
});
