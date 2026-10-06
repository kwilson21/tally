import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, householdToday, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { reserveJevCalls } from "../src/db/jev-calls";
import { pendingForJev } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { runScheduled } from "../src/index";
import { sortAfterSync, syncItemAndSort } from "../src/plaid/sort-after-sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Spec §8.6, decision 68: right after a sync that brought in or changed transactions, Jev sorts what
// is still unsorted, when the household's "Sort new transactions as they arrive" switch is on, within
// the day's cap that the nightly run shares. It never fails the sync it follows.

const db = env.DB;
const KEY = btoa("01234567890123456789012345678901");
const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** A Jev reply: Eating Out at the given confidence, no flags. */
const reply = (confidence: number) =>
	Response.json({
		answers: {
			category: { type: "choice", choice: "Eating Out", confidence },
			transfer: { type: "noul", noul: 0.01 },
			reimbursement: { type: "noul", noul: 0.01 },
			income: { type: "noul", noul: 0.01 },
		},
	});

/** A fake Jev that answers every call and remembers whose bank text it was asked about. */
function fakeJev(answer: () => Response = () => reply(0.95)) {
	const asked: string[] = [];
	const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
		asked.push(JSON.parse(String(init?.body)).state.bank_description);
		return answer();
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, asked };
}

const withKey = { DB: db, JEV_API_KEY: "jev-key" };
const quiet = () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	return vi.spyOn(console, "error").mockImplementation(() => {});
};
const newDay = () =>
	db
		.prepare("DELETE FROM household_settings WHERE key GLOB 'jev_calls_*'")
		.run();
/** The rows waiting for Jev, as the ids a sync would report for them. */
const waitingIds = async () => (await pendingForJev(db, 1000)).map((t) => t.id);
/** How many of the household day's calls are spoken for. */
const callsUsed = async () =>
	Number(
		(
			await db
				.prepare("SELECT value FROM household_settings WHERE key = ?")
				.bind(`jev_calls_${await householdToday(db)}`)
				.first<{ value: string }>()
		)?.value ?? 0,
	);

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
	// The demo's reset keeps the day's Jev count, so each test starts a day of its own.
	await newDay();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db.prepare("DROP TRIGGER IF EXISTS fail_save").run();
});

describe("sortAfterSync", () => {
	it("asks Jev about the rows the sync reports, and leaves the older waiting ones for the night", async () => {
		quiet();
		const jev = fakeJev();
		const [a, b, c] = await waitingIds();
		await sortAfterSync(
			withKey,
			{ changedIds: [a as number, b as number, c as number] },
			jev.fetchImpl,
		);
		// Three of the seed's twelve unsorted transactions, each asked about once.
		expect(jev.asked).toHaveLength(3);
		expect(new Set(jev.asked).size).toBe(3);
		expect(await pendingForJev(db, 100)).toHaveLength(9);
		// The nightly run takes the nine that waited.
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.asked).toHaveLength(12);
		expect(await pendingForJev(db, 100)).toHaveLength(0);
	});

	it("doesn't run after a sync that brought nothing", async () => {
		const jev = fakeJev();
		await sortAfterSync(withKey, { changedIds: [] }, jev.fetchImpl);
		expect(jev.asked).toEqual([]);
		expect(await callsUsed()).toBe(0);
	});

	it("doesn't run when the sorting switch is off, and leaves everything waiting for the nightly run", async () => {
		quiet();
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, sortOnArrival: false });
		const jev = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			jev.fetchImpl,
		);
		expect(jev.asked).toEqual([]);
		expect(await pendingForJev(db, 100)).toHaveLength(12);
		// The nightly run isn't held back by that switch.
		await categorizePending(withKey, jev.fetchImpl);
		expect(jev.asked).toHaveLength(12);
	});

	it("doesn't run when Jev isn't asked at all, with categories and income both off", async () => {
		await saveAiSwitches(db, {
			...AI_SWITCHES_ALL_ON,
			categories: false,
			income: false,
		});
		const jev = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			jev.fetchImpl,
		);
		expect(jev.asked).toEqual([]);
	});

	it.each([
		{ categories: true, income: false },
		{ categories: false, income: true },
	])(
		"runs with categories $categories and income $income",
		async (switches) => {
			quiet();
			await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, ...switches });
			const jev = fakeJev();
			await sortAfterSync(
				withKey,
				{ changedIds: await waitingIds() },
				jev.fetchImpl,
			);
			expect(jev.asked).toHaveLength(12);
		},
	);

	it("doesn't run without a Jev key", async () => {
		const jev = fakeJev();
		await sortAfterSync(
			{ DB: db },
			{ changedIds: await waitingIds() },
			jev.fetchImpl,
		);
		expect(jev.asked).toEqual([]);
	});

	it("leaves merchant rules to the sync's own after-sync step, so they aren't applied twice", async () => {
		quiet();
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			jev.fetchImpl,
		);
		// Jev was asked about it, since the rule wasn't applied here.
		expect(jev.asked).toContain("SQ *FARMERS MKT");
	});

	it("applies them itself when the sync's rules step failed", async () => {
		quiet();
		await db
			.prepare(
				"UPDATE merchants SET default_category_id = 1 WHERE raw_name = 'SQ *FARMERS MKT'",
			)
			.run();
		const jev = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			jev.fetchImpl,
			{
				rulesApplied: false,
			},
		);
		expect(jev.asked).not.toContain("SQ *FARMERS MKT");
		expect(
			await db
				.prepare(
					"SELECT category_source FROM transactions WHERE raw_name = 'SQ *FARMERS MKT'",
				)
				.first(),
		).toEqual({ category_source: "merchant_rule" });
	});

	it("never throws when Jev is down, and says only the status", async () => {
		const errors = quiet();
		const jev = fakeJev(() => new Response("{}", { status: 503 }));
		await expect(
			sortAfterSync(withKey, { changedIds: await waitingIds() }, jev.fetchImpl),
		).resolves.toBeUndefined();
		expect(jev.asked).toHaveLength(1);
		expect(errors.mock.calls).toEqual([["jev: 503"]]);
	});

	it("never throws when saving an answer fails, and logs the error's name alone", async () => {
		const errors = quiet();
		// Makes saving Jev's answer fail, standing in for any database error mid-run.
		await db
			.prepare(
				"CREATE TRIGGER fail_save BEFORE UPDATE OF category_confidence ON transactions BEGIN SELECT RAISE(ABORT, 'nope SQ *FARMERS MKT'); END",
			)
			.run();
		const jev = fakeJev();
		await expect(
			sortAfterSync(withKey, { changedIds: await waitingIds() }, jev.fetchImpl),
		).resolves.toBeUndefined();
		const logged = JSON.stringify(errors.mock.calls);
		expect(logged).toContain("sort after sync failed Error");
		expect(logged).not.toContain("nope");
		expect(logged).not.toContain("FARMERS");
		expect(logged).not.toContain("jev-key");
	});
});

describe("the day's cap across a sync's run and the nightly run", () => {
	/** More unsorted transactions than the demo's cap of 40, added after the seed's 12. */
	async function addPending(n: number) {
		await db
			.prepare(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				 INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				 SELECT 1, '2026-09-01', 100, 'EXTRA ' || i FROM n`,
			)
			.bind(n)
			.run();
	}

	it("gives the nightly run only what the syncs left of the day", async () => {
		quiet();
		// The demo's cap is 40. A run after a sync sorts the seed's 12 ...
		const atSync = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			atSync.fetchImpl,
		);
		expect(atSync.asked).toHaveLength(12);
		// ... another sync brings 50 more, and its run takes 28 before the cap is reached ...
		await addPending(50);
		const second = fakeJev();
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			second.fetchImpl,
		);
		expect(second.asked).toHaveLength(28);
		// ... so the nightly run the same day has nothing left to spend.
		const nightly = fakeJev();
		await categorizePending(withKey, nightly.fetchImpl);
		expect(nightly.asked).toEqual([]);
		expect(await callsUsed()).toBe(40);
		expect(await pendingForJev(db, 100)).toHaveLength(22);
	});

	it("lets the nightly run spend what a sync's run left", async () => {
		quiet();
		await addPending(50);
		// A sync's run takes 5 of the 40 (a Jev that fails after 5 answers stops it early).
		let calls = 0;
		const flaky = fakeJev(() =>
			++calls <= 5 ? reply(0.95) : new Response("{}", { status: 503 }),
		);
		await sortAfterSync(
			withKey,
			{ changedIds: await waitingIds() },
			flaky.fetchImpl,
		);
		expect(flaky.asked).toHaveLength(6);
		// The failed sixth call counted too, since it was asked: 34 left for the nightly run.
		const nightly = fakeJev();
		await categorizePending(withKey, nightly.fetchImpl);
		expect(nightly.asked).toHaveLength(34);
		expect(flaky.asked.length + nightly.asked.length).toBe(40);
	});

	it("counts the nightly run through runScheduled against the same day", async () => {
		quiet();
		// 495 of production's 500 were spent at syncs earlier today.
		const today = await householdToday(db);
		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES (?, '495') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.bind(`jev_calls_${today}`)
			.run();
		const jev = fakeJev();
		await runScheduled(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			jev.fetchImpl,
		);
		expect(jev.asked).toHaveLength(5);
		expect(await callsUsed()).toBe(500);
	});

	it("keeps the day's count through the demo's nightly reset, so a second run can't spend the cap again", async () => {
		quiet();
		// 35 of the demo's 40 were spent earlier today; the reset seeds twelve unsorted ones again.
		await reserveJevCalls(db, await householdToday(db), 40, 35);
		const jev = fakeJev();
		await runScheduled(
			{ ...env, DEMO: "true", JEV_API_KEY: "jev" },
			jev.fetchImpl,
		);
		expect(jev.asked).toHaveLength(5);
		expect(await callsUsed()).toBe(40);
	});

	it("starts the next day with the whole cap again", async () => {
		quiet();
		await addPending(50);
		const day1 = fakeJev();
		await categorizePending(withKey, day1.fetchImpl);
		expect(day1.asked).toHaveLength(40);
		await newDay();
		const day2 = fakeJev();
		await categorizePending(withKey, day2.fetchImpl);
		expect(day2.asked).toHaveLength(22);
	});
});

// A real sync, then the sort, the way the webhook and a repaired connection run it.
describe("syncItemAndSort", () => {
	const plaidEnv = {
		...env,
		DEMO: "false",
		PLAID_CLIENT_ID: "client",
		PLAID_SECRET: "secret",
		TOKEN_ENCRYPTION_KEY: KEY,
		JEV_API_KEY: "jev-key",
	};
	let itemId: number;

	beforeEach(async () => {
		// The demo's categories and merchants, but none of its banks or transactions.
		await db.batch([
			db.prepare("DELETE FROM bill_payments"),
			db.prepare("DELETE FROM transactions"),
			db.prepare("DELETE FROM accounts"),
			db.prepare("DELETE FROM plaid_items"),
		]);
		const row = await db
			.prepare(
				`INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id)
				 VALUES (?, 'Bank', 'person@example.com', 'item') RETURNING id`,
			)
			.bind(await encryptToken("token-secret", KEY))
			.first<{ id: number }>();
		itemId = row?.id as number;
	});

	/** A transaction Plaid sends: just its bank text, or more, such as a pending one. */
	type Item =
		| string
		| {
				name: string;
				id?: string;
				pending?: boolean;
				pendingOf?: string;
				amount?: number;
		  };

	/**
	 * Plaid gives `added`, `modified` and `removed`; Jev, if asked, answers with `jev`. With
	 * `failSecondPage`, the first page is saved (it says more is coming) and the second fails.
	 */
	function fakes(
		added: Item[],
		{
			modified = [],
			removed = [],
			jev = () => reply(0.95),
			failSecondPage = false,
		}: {
			modified?: Item[];
			removed?: string[];
			jev?: () => Response | Promise<Response>;
			failSecondPage?: boolean;
		} = {},
	) {
		const asked: string[] = [];
		const tx = (item: Item) => {
			const o = typeof item === "string" ? { name: item } : item;
			return {
				transaction_id: o.id ?? `tx-${o.name}`,
				account_id: "account-1",
				date: "2026-09-27",
				amount: o.amount ?? 4.25,
				name: o.name,
				pending: o.pending ?? false,
				pending_transaction_id: o.pendingOf ?? null,
			};
		};
		let syncCalls = 0;
		const fetchImpl = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url) === JEV_URL) {
					asked.push(JSON.parse(String(init?.body)).state.bank_description);
					return await jev();
				}
				if (String(url).endsWith("/accounts/get"))
					return Response.json({
						accounts: [
							{
								account_id: "account-1",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					});
				syncCalls += 1;
				if (failSecondPage && syncCalls === 2)
					return Response.json(
						{ error_type: "API_ERROR", request_id: "request-safe" },
						{ status: 500 },
					);
				return Response.json({
					added: added.map(tx),
					modified: modified.map(tx),
					removed: removed.map((transaction_id) => ({ transaction_id })),
					next_cursor: "next",
					has_more: failSecondPage,
				});
			},
		);
		return { fetchImpl: fetchImpl as unknown as typeof fetch, asked };
	}

	const categoryOf = (name: string) =>
		db
			.prepare(
				"SELECT category_source, category_confidence FROM transactions WHERE raw_name = ?",
			)
			.bind(name)
			.first();

	it("sorts the transactions a sync brought in, after its own rules", async () => {
		quiet();
		const category = await db
			.prepare(
				"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order LIMIT 1",
			)
			.first<{ id: number }>();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULED SHOP', ?)",
			)
			.bind(category?.id)
			.run();
		const { fetchImpl, asked } = fakes(["RULED SHOP", "NEW SHOP"]);

		const synced = await syncItemAndSort(plaidEnv, itemId, fetchImpl);

		expect(synced).toMatchObject({ added: 2, modified: 0, removed: 0 });
		// The rule sorted one, so Jev was asked about the other only.
		expect(asked).toEqual(["NEW SHOP"]);
		expect(await categoryOf("RULED SHOP")).toEqual({
			category_source: "merchant_rule",
			category_confidence: null,
		});
		expect(await categoryOf("NEW SHOP")).toEqual({
			category_source: "jev",
			category_confidence: 0.95,
		});
	});

	it("sorts after a sync that only modified a transaction", async () => {
		quiet();
		const first = fakes(["NEW SHOP"], { jev: () => reply(0.5) });
		await syncItemAndSort(plaidEnv, itemId, first.fetchImpl);
		expect(first.asked).toEqual(["NEW SHOP"]);
		// Plaid corrects the amount; the answer that depended on it is cleared and asked again.
		const second = fakes([], { modified: ["NEW SHOP"] });
		await db
			.prepare("UPDATE transactions SET amount_cents = 999 WHERE raw_name = ?")
			.bind("NEW SHOP")
			.run();
		const synced = await syncItemAndSort(plaidEnv, itemId, second.fetchImpl);
		expect(synced).toMatchObject({ added: 0, modified: 1 });
		expect(second.asked).toEqual(["NEW SHOP"]);
	});

	it("asks nothing when the sync brought nothing", async () => {
		quiet();
		const { fetchImpl, asked } = fakes([]);
		const synced = await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(synced).toMatchObject({ added: 0, modified: 0, removed: 0 });
		expect(asked).toEqual([]);
	});

	it("asks nothing when the sorting switch is off", async () => {
		quiet();
		await saveAiSwitches(db, { sortOnArrival: false });
		const { fetchImpl, asked } = fakes(["NEW SHOP"]);
		await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(asked).toEqual([]);
		expect(await categoryOf("NEW SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
	});

	it("asks nothing when another sync of the bank is already running", async () => {
		quiet();
		await db
			.prepare(
				"UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes'), sync_lock_id = 'other' WHERE id = ?",
			)
			.bind(itemId)
			.run();
		const { fetchImpl, asked } = fakes(["NEW SHOP"]);
		expect(await syncItemAndSort(plaidEnv, itemId, fetchImpl)).toEqual({
			skipped: true,
		});
		expect(asked).toEqual([]);
	});

	it("keeps the sync's result and its transactions when Jev is down", async () => {
		const errors = quiet();
		const { fetchImpl, asked } = fakes(["NEW SHOP"], {
			jev: () => new Response("{}", { status: 503 }),
		});
		const synced = await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(synced).toMatchObject({ added: 1, modified: 0, removed: 0 });
		expect(asked).toEqual(["NEW SHOP"]);
		expect(await categoryOf("NEW SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
		// A failure about the whole service marks nothing as failed.
		expect(
			await db
				.prepare("SELECT jev_failed_at FROM transactions WHERE raw_name = ?")
				.bind("NEW SHOP")
				.first(),
		).toEqual({ jev_failed_at: null });
		const logged = JSON.stringify(errors.mock.calls);
		expect(logged).not.toContain("NEW SHOP");
		expect(logged).not.toContain("jev-key");
		expect(logged).not.toContain("token-secret");
	});

	it("keeps the sync's result when the sort itself throws", async () => {
		const errors = quiet();
		await db
			.prepare(
				"CREATE TRIGGER fail_save BEFORE UPDATE OF category_confidence ON transactions BEGIN SELECT RAISE(ABORT, 'nope NEW SHOP'); END",
			)
			.run();
		const { fetchImpl } = fakes(["NEW SHOP"]);
		const synced = await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(synced).toMatchObject({ added: 1, modified: 0, removed: 0 });
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
		).toEqual({ n: 1 });
		expect(JSON.stringify(errors.mock.calls)).toContain(
			"sort after sync failed",
		);
	});

	it("asks about this sync's three new transactions only, and an older one waits for the night", async () => {
		quiet();
		// An older transaction nobody sorted, saved while sorting right away was off.
		await saveAiSwitches(db, { sortOnArrival: false });
		const earlier = fakes(["OLD SHOP"]);
		await syncItemAndSort(plaidEnv, itemId, earlier.fetchImpl);
		expect(earlier.asked).toEqual([]);
		await saveAiSwitches(db, { sortOnArrival: true });

		const { fetchImpl, asked } = fakes(["NEW A", "NEW B", "NEW C"]);
		await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(asked.sort()).toEqual(["NEW A", "NEW B", "NEW C"]);
		expect(await categoryOf("OLD SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});

		// The night's run asks about it, within the same day's count.
		const night = fakeJev();
		await categorizePending(plaidEnv, night.fetchImpl);
		expect(night.asked).toEqual(["OLD SHOP"]);
		expect(await callsUsed()).toBe(4);
	});

	it("with room for 2 of 5 new transactions, asks 2 and leaves 3 for the night", async () => {
		quiet();
		// Production's cap is 500; 498 are spent earlier in the household's day.
		await reserveJevCalls(db, await householdToday(db), 500, 498);
		const { fetchImpl, asked } = fakes(["A", "B", "C", "D", "E"]);
		await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		expect(asked).toHaveLength(2);
		expect(await pendingForJev(db, 100)).toHaveLength(3);
		expect(await callsUsed()).toBe(500);
		// Tomorrow the night's run, with a fresh day, takes the three.
		await newDay();
		const night = fakeJev();
		await categorizePending(plaidEnv, night.fetchImpl);
		expect(night.asked).toHaveLength(3);
	});

	it("stops asking about the sync's rows when sorting right away is turned off partway", async () => {
		quiet();
		const names = ["A", "B", "C", "D", "E"];
		const { fetchImpl, asked } = fakes(names, {
			jev: async () => {
				// Someone turns the switch off while the second answer is on its way.
				if (asked.length === 2)
					await saveAiSwitches(db, { sortOnArrival: false });
				return reply(0.95);
			},
		});
		await syncItemAndSort(plaidEnv, itemId, fetchImpl);
		// The second answer was already on its way, so it's kept; the third is never asked.
		expect(asked).toHaveLength(2);
		expect(await pendingForJev(db, 100)).toHaveLength(3);
		// The night's run isn't held back by that switch, and takes the three.
		const night = fakeJev();
		await categorizePending(plaidEnv, night.fetchImpl);
		expect(night.asked).toHaveLength(3);
	});

	describe("a pending transaction", () => {
		const row = (plaidId: string) =>
			db
				.prepare(
					"SELECT category_source, category_confidence, jev_category_id, pending FROM transactions WHERE plaid_transaction_id = ?",
				)
				.bind(plaidId)
				.first();

		it("is asked about like any other", async () => {
			quiet();
			const { fetchImpl, asked } = fakes([
				{ name: "CARD SHOP", id: "pending-1", pending: true },
			]);
			await syncItemAndSort(plaidEnv, itemId, fetchImpl);
			expect(asked).toEqual(["CARD SHOP"]);
			expect(await row("pending-1")).toMatchObject({
				pending: 1,
				category_source: "jev",
				category_confidence: 0.95,
			});
		});

		it("has its answer on the posted transaction once the bank posts it, with no second call", async () => {
			quiet();
			const first = fakes([
				{ name: "CARD SHOP", id: "pending-1", pending: true },
			]);
			await syncItemAndSort(plaidEnv, itemId, first.fetchImpl);
			const second = fakes(
				[{ name: "CARD SHOP", id: "posted-1", pendingOf: "pending-1" }],
				{ removed: ["pending-1"] },
			);
			await syncItemAndSort(plaidEnv, itemId, second.fetchImpl);
			expect(second.asked).toEqual([]);
			expect(await row("pending-1")).toBeNull();
			expect(await row("posted-1")).toMatchObject({
				pending: 0,
				category_source: "jev",
				category_confidence: 0.95,
			});
		});

		it("is asked again when the bank posts it for a different amount, as for any correction", async () => {
			quiet();
			const first = fakes([
				{ name: "CARD SHOP", id: "pending-1", pending: true },
			]);
			await syncItemAndSort(plaidEnv, itemId, first.fetchImpl);
			const second = fakes(
				[
					{
						name: "CARD SHOP",
						id: "posted-1",
						pendingOf: "pending-1",
						amount: 5.5,
					},
				],
				{ removed: ["pending-1"] },
			);
			await syncItemAndSort(plaidEnv, itemId, second.fetchImpl);
			expect(second.asked).toEqual(["CARD SHOP"]);
			expect(await row("posted-1")).toMatchObject({
				category_source: "jev",
				category_confidence: 0.95,
			});
		});
	});

	it("leaves the rows of a sync that failed partway for the night, which asks about them", async () => {
		quiet();
		const { fetchImpl, asked } = fakes(["SAVED SHOP"], {
			failSecondPage: true,
		});
		await expect(syncItemAndSort(plaidEnv, itemId, fetchImpl)).rejects.toThrow(
			"Plaid request failed",
		);
		// The first page was saved; the failed sync reported nothing, so nothing was asked right away.
		expect(asked).toEqual([]);
		expect(await categoryOf("SAVED SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
		// The nightly run has no list: it asks about everything still waiting.
		const night = fakeJev();
		await categorizePending(plaidEnv, night.fetchImpl);
		expect(night.asked).toEqual(["SAVED SHOP"]);
		expect(await categoryOf("SAVED SHOP")).toEqual({
			category_source: "jev",
			category_confidence: 0.95,
		});
	});

	it("still throws a failed sync's own error, and sorts nothing", async () => {
		quiet();
		const asked: string[] = [];
		const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
			if (String(url) === JEV_URL) asked.push("jev");
			return Response.json(
				{ error_type: "API_ERROR", request_id: "request-safe" },
				{ status: 500 },
			);
		}) as unknown as typeof fetch;
		await expect(syncItemAndSort(plaidEnv, itemId, fetchImpl)).rejects.toThrow(
			"Plaid request failed",
		);
		expect(asked).toEqual([]);
	});
});
