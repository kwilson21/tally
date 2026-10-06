import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { runScheduled, runSecondSort } from "../src/index";
import { encryptToken } from "../src/plaid/token-crypto";

const KEY = btoa("01234567890123456789012345678901");

// The Workers runtime supports scheduled() on the Worker's own export, but the
// generated Fetcher type only declares fetch() and connect().
const worker = exports.default as unknown as {
	scheduled(options: { cron?: string }): Promise<unknown>;
};

const count = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions").first<{
			n: number;
		}>()
	)?.n ?? 0;

describe("scheduled handler", () => {
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

	it("syncs before categorizing, so a new transaction gets its merchant rule", async () => {
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

	// Decision 56: the 09:30 run only sorts what the first left; it never resets the demo or syncs.
	it("runs only the second sort at 09:30, with no reset and no sync", async () => {
		await env.DB.prepare("DELETE FROM transactions").run();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await worker.scheduled({ cron: "30 9 * * *" });

		expect(await count()).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("asks Jev about what the first run left, so the night still reaches the day's cap", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		const answer = () =>
			new Response(
				JSON.stringify({
					answers: {
						category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
						transfer: { type: "noul", noul: 0.01 },
						reimbursement: { type: "noul", noul: 0.01 },
						income: { type: "noul", noul: 0.01 },
					},
				}),
			);
		const fetchImpl = vi.fn(async () => answer());

		await runSecondSort(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);

		expect(fetchImpl).toHaveBeenCalledTimes(12);
		vi.restoreAllMocks();
	});

	// Spec §8.6: the nightly run reads the household's AI switches too.
	it.each([
		{ categories: false, income: false, calls: 0 },
		{ categories: true, income: false, calls: 12 },
		{ categories: false, income: true, calls: 12 },
	])(
		"asks Jev $calls times at night with categories $categories and income $income",
		async ({ categories, income, calls }) => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await saveAiSwitches(env.DB, {
				...AI_SWITCHES_ALL_ON,
				categories,
				income,
			});
			const fetchImpl = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							answers: {
								category: {
									type: "choice",
									choice: "Eating Out",
									confidence: 0.5,
								},
								transfer: { type: "noul", noul: 0.01 },
								reimbursement: { type: "noul", noul: 0.01 },
								income: { type: "noul", noul: 0.01 },
							},
						}),
					),
			);

			// Production, not the demo, whose nightly reset would turn the switches back on.
			await runScheduled(
				{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
				fetchImpl as unknown as typeof fetch,
			);

			expect(fetchImpl).toHaveBeenCalledTimes(calls);
			vi.restoreAllMocks();
		},
	);
});

// The nightly names step (spec §7, §9, #33): Workers AI suggests names where there is a binding. In
// production it runs in the 09:30 run, before that run's Jev pass, so no one invocation nears D1's 1,000
// queries (the 09:00 run syncs and asks Jev about up to 300); the demo has one run, which names after Jev.
describe("scheduled handler: merchant names", () => {
	const aiThatSays = (response: string) =>
		({ run: vi.fn(async () => ({ response })) }) as unknown as Ai & {
			run: ReturnType<typeof vi.fn>;
		};
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

	it("asks no names in production's 09:00 run, which has synced and asked Jev already", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee");
		await runScheduled({ ...env, DEMO: "false", AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
		expect((await pending()).results).toEqual([]);
		vi.restoreAllMocks();
	});

	it("suggests names for a bank text Plaid didn't name in the 09:30 run, as pending suggestions", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee\nBlue Bottle");
		await runSecondSort({ ...env, DEMO: "false", AI: ai });
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
		expect((await pending()).results).toEqual([]);
	});

	it("asks names first in the 09:30 run, then Jev, so a long names step can't starve the sort", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		const order: string[] = [];
		const ai = {
			run: vi.fn(async () => {
				order.push("names");
				return { response: "Blue Bottle Coffee" };
			}),
		} as unknown as Ai;
		const fetchImpl = vi.fn(async () => {
			order.push("jev");
			return Response.json({
				answers: {
					category: { type: "choice", choice: "Eating Out", confidence: 0.5 },
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			});
		});
		await runSecondSort(
			{ ...env, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);
		expect(order).toEqual(["names", "jev"]);
		vi.restoreAllMocks();
	});

	it("caps the 09:30 run's Jev pass at 200 calls, so its names and sort stay under D1's query limit", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
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
		await runSecondSort(
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

	it("keeps going when Workers AI fails, so the rest of the night still runs", async () => {
		await oneUnnamedCharge();
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = {
			run: vi.fn(async () => {
				throw new Error("capacity");
			}),
		} as unknown as Ai;
		await expect(
			runSecondSort({ ...env, DEMO: "false", AI: ai }),
		).resolves.toBeUndefined();
		expect((await pending()).results).toEqual([]);
		logged.mockRestore();
	});
});
