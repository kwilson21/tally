import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jevCallLimit } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import handler, {
	runFirstSort,
	runScheduled,
	runSecondSort,
} from "../src/index";
import { encryptToken } from "../src/plaid/token-crypto";
import { nameCallLimit } from "../src/suggest-names-pending";

const KEY = btoa("01234567890123456789012345678901");

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
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
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
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		const fetchImpl = vi.fn(async () => jevAnswer());

		await runScheduled(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			fetchImpl as unknown as typeof fetch,
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("takes the 09:20 run's up to 300 calls and the 09:40 run's up to 200 from one day's 500", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
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

		expect(first).toHaveBeenCalledTimes(300);
		expect(second).toHaveBeenCalledTimes(200);
		expect(third).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	}, 60_000);
});

// Which run each cron starts (decision 56): production has three, 20 minutes apart, so each has D1's 1,000
// queries to itself; the demo has one. The entry point routes by the cron that fired.
describe("scheduled handler: which run a cron starts", () => {
	async function seedWaiting() {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
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

	it("asks Jev, and no names, at 09:20", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		expect(await fire("20 9 * * *")).toEqual({ jev: 12, names: 0 });
		vi.restoreAllMocks();
	});

	it("asks names, then Jev, at 09:40", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await seedWaiting();
		const { jev, names } = await fire("40 9 * * *");
		expect(jev).toBe(12);
		expect(names).toBeGreaterThan(0);
		vi.restoreAllMocks();
	});
});

// The nightly names step (spec §7, §9, #33): Workers AI suggests names where there is a binding. In
// production it runs in the 09:40 run, before that run's Jev pass, in an invocation of its own (the 09:00
// run syncs, the 09:20 run asks Jev about up to 300); the demo has one run, which names after Jev.
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

	it("asks no names in production's 09:00 or 09:20 run, each of which has queries enough to do already", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await oneUnnamedCharge();
		const ai = aiThatSays("Blue Bottle Coffee");
		await runScheduled({ ...env, DEMO: "false", AI: ai });
		await runFirstSort({ ...env, DEMO: "false", AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
		expect((await pending()).results).toEqual([]);
		vi.restoreAllMocks();
	});

	it("suggests names for a bank text Plaid didn't name in the 09:40 run, as pending suggestions", async () => {
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
		await runFirstSort({ ...env, DEMO: "false" });
		expect((await pending()).results).toEqual([]);
	});

	it("asks names first in the 09:40 run, then Jev, so a long names step can't starve the sort", async () => {
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

	it("caps the 09:40 run's Jev pass at 200 calls, so its names and sort stay under D1's query limit", async () => {
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

// D1 allows 1,000 queries in one Worker invocation, and every statement a run prepares is one (a call to
// Jev costs about three: the switches read before it and after it, and saving its answer; a name about
// three too). Each of production's three runs and the demo's one is an invocation of its own, so each
// has to fit, with its worst case in it.
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
		expect(counted.statements() + unused * 3).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	// A sync costs about five queries for each new transaction and isn't capped here: a backfill bigger than
	// a busy night's is for the queue that lifts the per-run limit (#248).
	it("production's 09:00 run, which syncs a busy night's 100 new transactions", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
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

		await runScheduled(
			{
				...env,
				DB: counted.db,
				DEMO: "false",
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
				TOKEN_ENCRYPTION_KEY: KEY,
				JEV_API_KEY: "jev",
			},
			fetchImpl,
		);

		expect(await count()).toBe(NEW_TRANSACTIONS);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	it("production's 09:20 run, which asks Jev about up to 300", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(400);
		const counted = countingDb();
		const jev = vi.fn(async () => jevAnswer());

		await runFirstSort(
			{ ...env, DB: counted.db, DEMO: "false", JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(jev).toHaveBeenCalledTimes(300);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);

	it("production's 09:40 run, which asks 100 names and then Jev about up to 200", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
		await addWaiting(400);
		const counted = countingDb();
		const ai = aiThatSays("Some Place Name");
		const jev = vi.fn(async () => jevAnswer());

		await runSecondSort(
			{ ...env, DB: counted.db, DEMO: "false", AI: ai, JEV_API_KEY: "jev" },
			jev as unknown as typeof fetch,
		);

		expect(ai.run).toHaveBeenCalledTimes(100);
		expect(jev).toHaveBeenCalledTimes(200);
		expect(counted.statements()).toBeLessThan(D1_LIMIT);
		vi.restoreAllMocks();
	}, 60_000);
});
