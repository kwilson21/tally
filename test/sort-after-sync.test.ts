import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, householdToday, todayIn } from "../src/dates";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { jevCallsLeft } from "../src/db/jev-calls";
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

beforeEach(async () => {
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await db.prepare("DROP TRIGGER IF EXISTS fail_save").run();
});

describe("sortAfterSync", () => {
	it("asks Jev about what's still unsorted after a sync that added transactions", async () => {
		quiet();
		const jev = fakeJev();
		await sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl);
		// The seed's 12 unsorted transactions, each asked about once.
		expect(jev.asked).toHaveLength(12);
		expect(new Set(jev.asked).size).toBe(12);
		expect(await pendingForJev(db, 100)).toHaveLength(0);
	});

	it("also runs after a sync that only changed transactions", async () => {
		quiet();
		const jev = fakeJev();
		await sortAfterSync(withKey, { added: 0, modified: 2 }, jev.fetchImpl);
		expect(jev.asked).toHaveLength(12);
	});

	it("doesn't run after a sync that brought nothing", async () => {
		const jev = fakeJev();
		await sortAfterSync(withKey, { added: 0, modified: 0 }, jev.fetchImpl);
		expect(jev.asked).toEqual([]);
	});

	it("doesn't run when the sorting switch is off, and leaves everything waiting for the nightly run", async () => {
		quiet();
		await saveAiSwitches(db, { ...AI_SWITCHES_ALL_ON, sortOnArrival: false });
		const jev = fakeJev();
		await sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl);
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
		await sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl);
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
			await sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl);
			expect(jev.asked).toHaveLength(12);
		},
	);

	it("doesn't run without a Jev key", async () => {
		const jev = fakeJev();
		await sortAfterSync({ DB: db }, { added: 3, modified: 0 }, jev.fetchImpl);
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
		await sortAfterSync(withKey, { added: 1, modified: 0 }, jev.fetchImpl);
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
		await sortAfterSync(withKey, { added: 1, modified: 0 }, jev.fetchImpl, {
			rulesApplied: false,
		});
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
			sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl),
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
			sortAfterSync(withKey, { added: 3, modified: 0 }, jev.fetchImpl),
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
		await sortAfterSync(withKey, { added: 12, modified: 0 }, atSync.fetchImpl);
		expect(atSync.asked).toHaveLength(12);
		// ... another sync brings 50 more, and its run takes 28 before the cap is reached ...
		await addPending(50);
		const second = fakeJev();
		await sortAfterSync(withKey, { added: 50, modified: 0 }, second.fetchImpl);
		expect(second.asked).toHaveLength(28);
		// ... so the nightly run the same day has nothing left to spend.
		const nightly = fakeJev();
		await categorizePending(withKey, nightly.fetchImpl);
		expect(nightly.asked).toEqual([]);
		expect(await jevCallsLeft(db, await householdToday(db), 40)).toBe(0);
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
		await sortAfterSync(withKey, { added: 62, modified: 0 }, flaky.fetchImpl);
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
		// Production, not the demo, whose nightly reset would clear the count.
		await runScheduled(
			{ ...env, DEMO: "false", JEV_API_KEY: "jev" },
			jev.fetchImpl,
		);
		expect(jev.asked).toHaveLength(5);
		expect(await jevCallsLeft(db, today, 500)).toBe(0);
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

	/** Plaid gives `added` and `modified`; Jev, if asked, answers with `jev`. */
	function fakes(
		added: string[],
		{
			modified = [],
			jev = () => reply(0.95),
		}: { modified?: string[]; jev?: () => Response } = {},
	) {
		const asked: string[] = [];
		const tx = (name: string) => ({
			transaction_id: `tx-${name}`,
			account_id: "account-1",
			date: "2026-09-27",
			amount: 4.25,
			name,
			pending: false,
		});
		const fetchImpl = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				if (String(url) === JEV_URL) {
					asked.push(JSON.parse(String(init?.body)).state.bank_description);
					return jev();
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
				return Response.json({
					added: added.map(tx),
					modified: modified.map(tx),
					removed: [],
					next_cursor: "next",
					has_more: false,
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

		expect(synced).toEqual({ added: 2, modified: 0, removed: 0 });
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
		expect(synced).toEqual({ added: 0, modified: 0, removed: 0 });
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
		expect(synced).toEqual({ added: 1, modified: 0, removed: 0 });
		expect(asked).toEqual(["NEW SHOP"]);
		expect(await categoryOf("NEW SHOP")).toEqual({
			category_source: null,
			category_confidence: null,
		});
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
		expect(synced).toEqual({ added: 1, modified: 0, removed: 0 });
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM transactions").first(),
		).toEqual({ n: 1 });
		expect(JSON.stringify(errors.mock.calls)).toContain(
			"sort after sync failed",
		);
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
