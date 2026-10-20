import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import {
	bankState,
	readYourBanks,
	type YourBank,
} from "../src/first-tally/your-banks";

// Home's Your banks list (P140 A, decision 133, spec §8.8): each connected bank's state, from the row the list reads.
const TODAY = "2026-10-05";

const HEALTHY: YourBank = {
	id: 1,
	name: "Chase",
	status: "ok",
	lastSyncedAt: "2026-10-05 08:00:00",
	historyCompleteAt: null,
	fresh: true,
	count: 86,
};

describe("bankState", () => {
	it("in: a bank whose 90-day history is in, whatever else is true of it", () => {
		expect(
			bankState(
				{
					...HEALTHY,
					historyCompleteAt: "2026-10-05 09:00:00",
					status: "needs_attention",
				},
				TODAY,
			),
		).toBe("in");
	});

	it("paused by sign-in: the bank needs signing in, even while it is fresh", () => {
		expect(bankState({ ...HEALTHY, status: "needs_attention" }, TODAY)).toBe(
			"paused",
		);
	});

	it("paused by 3+ days stale: the last sync is 3 days back, even while it is fresh", () => {
		expect(
			bankState({ ...HEALTHY, lastSyncedAt: "2026-10-02 12:00:00" }, TODAY),
		).toBe("paused");
	});

	it("being read: healthy, history not in, linked within the hour, with transactions so far", () => {
		expect(bankState(HEALTHY, TODAY)).toBe("being-read");
	});

	it("being read with nothing stored yet: still being read", () => {
		expect(bankState({ ...HEALTHY, count: 0 }, TODAY)).toBe("being-read");
	});

	it("healthy past its first hour, history not in: reading, with no ring", () => {
		expect(bankState({ ...HEALTHY, fresh: false }, TODAY)).toBe("reading");
	});

	it("a bank with no sync time is never stale, so it is reading past the hour, not paused", () => {
		expect(
			bankState({ ...HEALTHY, lastSyncedAt: null, fresh: false }, TODAY),
		).toBe("reading");
	});
});

describe("readYourBanks", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	const connected = () =>
		env.DB.prepare(
			"SELECT id FROM plaid_items WHERE disconnected_at IS NULL ORDER BY id",
		).all<{ id: number }>();

	it("gives one row per connected bank, in link order", async () => {
		const rows = await readYourBanks(env.DB);
		const ids = (await connected()).results.map((row) => row.id);
		expect(rows.map((row) => row.id)).toEqual(ids);
		expect(ids.length).toBeGreaterThan(0);
	});

	it("counts the stored bank transactions, and leaves split children out", async () => {
		const account = await env.DB.prepare(
			"SELECT id, plaid_item_id AS bank FROM accounts WHERE plaid_item_id IS NOT NULL ORDER BY id LIMIT 1",
		).first<{ id: number; bank: number }>();
		const before = (await readYourBanks(env.DB)).find(
			(row) => row.id === account?.bank,
		);
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_transaction_id) VALUES (?, '2026-10-01', 500, 'SHOP', 'list-test-1')",
		)
			.bind(account?.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, '2026-10-01', 200, 'SHOP', (SELECT id FROM transactions WHERE account_id = ? ORDER BY id LIMIT 1))",
		)
			.bind(account?.id, account?.id)
			.run();
		const after = (await readYourBanks(env.DB)).find(
			(row) => row.id === account?.bank,
		);
		expect(after?.count).toBe((before?.count ?? 0) + 1);
	});

	it("leaves a disconnected bank out", async () => {
		const [first] = (await connected()).results;
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
		)
			.bind(first?.id)
			.run();
		const rows = await readYourBanks(env.DB);
		expect(rows.some((row) => row.id === first?.id)).toBe(false);
	});

	it("gives two banks with the same name their own rows, by id", async () => {
		const [first, second] = (await connected()).results;
		await env.DB.prepare(
			"UPDATE plaid_items SET institution_name = 'Chase' WHERE id IN (?, ?)",
		)
			.bind(first?.id, second?.id)
			.run();
		const named = (await readYourBanks(env.DB)).filter(
			(row) => row.name === "Chase",
		);
		expect(named.map((row) => row.id)).toEqual([first?.id, second?.id]);
	});

	it("counts a bank with no transactions as 0", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by) VALUES (901, X'', 'Empty Bank', 'test')",
		).run();
		const empty = (await readYourBanks(env.DB)).find((row) => row.id === 901);
		expect(empty?.count).toBe(0);
	});

	it("says a bank linked over an hour ago is not fresh, and one linked now is", async () => {
		const [first, second] = (await connected()).results;
		await env.DB.prepare(
			"UPDATE plaid_items SET created_at = datetime('now', '-61 minutes') WHERE id = ?",
		)
			.bind(first?.id)
			.run();
		const rows = await readYourBanks(env.DB);
		expect(rows.find((row) => row.id === first?.id)?.fresh).toBe(false);
		expect(rows.find((row) => row.id === second?.id)?.fresh).toBe(true);
	});
});
