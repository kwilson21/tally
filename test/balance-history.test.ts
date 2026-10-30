import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountsWithHistory } from "../src/db/balance-history";
import { resetDemo } from "../src/demo/reset";

const TODAY = "2026-10-05";

const addBalance = (accountId: number, date: string, cents: number) =>
	env.DB.prepare(
		"INSERT INTO balance_history (account_id, date, balance_cents) VALUES (?, ?, ?)",
	)
		.bind(accountId, date, cents)
		.run();

/** The line's cents on one day, or undefined when it has no point that day. */
const on = (points: { date: string; cents: number }[], date: string) =>
	points.find((p) => p.date === date)?.cents;

// The demo's accounts: 1 Checking and 2 Savings at First Harbor Bank (item 1), 3 Credit card at
// Northline (item 2), 4 Cash.
describe("accountsWithHistory", () => {
	beforeEach(() => resetDemo(env.DB, TODAY));

	it("gives the banks and net worth on each day of the chart's six months, ending on today's headline", async () => {
		const { banks, points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(banks.map((b) => b.name)).toEqual([
			"First Harbor Bank",
			"Northline Card Services",
		]);
		expect(points[0]?.date).toBe("2026-05-01");
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1576838 });
		// May 1 to Oct 5, one point a day.
		expect(points).toHaveLength(158);
		// Both banks were there from the window's first day, so none is named.
		expect(added).toEqual([]);
	});

	it("reads the banks and the balances in one batch, so a sync can't land between them", async () => {
		const batches: number[] = [];
		const db = {
			prepare: (query: string) => env.DB.prepare(query),
			batch: (statements: D1PreparedStatement[]) => {
				batches.push(statements.length);
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		const { banks, points } = await accountsWithHistory(db, TODAY);
		expect(batches).toEqual([3]);
		expect(banks).toHaveLength(2);
		expect(points).toHaveLength(158);
	});

	it("leaves the Cash account out, as net worth does", async () => {
		const before = await accountsWithHistory(env.DB, TODAY);
		await addBalance(4, TODAY, 999999);
		await addBalance(4, "2026-06-01", 999999);
		const after = await accountsWithHistory(env.DB, TODAY);
		expect(after.points).toEqual(before.points);
		expect(after.added).toEqual([]);
	});

	it("leaves a disconnected bank's accounts out of the whole line, so it still meets the headline", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE institution_name = 'Northline Card Services'",
		).run();
		const { points, added } = await accountsWithHistory(env.DB, TODAY);
		// Checking and Savings only: $4,210.55 + $12,400.00.
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1661055 });
		expect(points).toHaveLength(158);
		// A disconnected bank is not a source, so it is never named.
		expect(added).toEqual([]);
	});

	it("leaves a connected account with no balance recorded yet out of the line, and draws the line from the others", async () => {
		// A bank account Plaid gave a balance, whose first snapshot hasn't been written (just rolled
		// out, a failed first sync, a login that needs fixing). The headline already counts it; the
		// line can't count it until it has a balance, so it waits outside the line, not the line.
		await env.DB.prepare(
			"INSERT INTO accounts (plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (2, 'Store card', '3333', 'credit', 'credit card', 1, 25000)",
		).run();
		const { banks, points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(banks.flatMap((b) => b.accounts)).toHaveLength(4);
		expect(points).toHaveLength(158);
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1576838 });
		expect(added).toEqual([]);
	});

	it("steps the line on the day that account's first balance arrives, down by what it owes, and keeps the past months", async () => {
		const without = await accountsWithHistory(env.DB, TODAY);
		await env.DB.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (10, 2, 'Store card', '3333', 'credit', 'credit card', 1, 25000)",
		).run();
		await addBalance(10, "2026-10-04", 24000);
		await addBalance(10, TODAY, 25000);
		const { points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(points).toHaveLength(158);
		expect(points[0]).toEqual(without.points[0]);
		expect(on(points, "2026-10-03")).toBe(on(without.points, "2026-10-03"));
		expect(on(points, "2026-10-04")).toBe(
			(on(without.points, "2026-10-04") ?? 0) - 24000,
		);
		// $1,576,838 less the new card's $250.00 owed on the last day.
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1576838 - 25000 });
		// Northline was there from May, so the bank isn't named again for its card.
		expect(added).toEqual([]);
	});

	it("names a bank linked mid-window by its first balance, and steps the line up on that day", async () => {
		const without = await accountsWithHistory(env.DB, TODAY);
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by) VALUES (9, X'00', 'Ally Bank', 'demo')",
		).run();
		await env.DB.prepare(
			"INSERT INTO accounts (id, plaid_item_id, name, mask, type, subtype, is_liability, balance_cents) VALUES (11, 9, 'Savings', '5555', 'depository', 'savings', 0, 500000)",
		).run();
		await addBalance(11, "2026-10-02", 500000);
		await addBalance(11, TODAY, 500000);
		const { points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(points).toHaveLength(158);
		expect(on(points, "2026-10-01")).toBe(on(without.points, "2026-10-01"));
		expect(on(points, "2026-10-02")).toBe(
			(on(without.points, "2026-10-02") ?? 0) + 500000,
		);
		expect(added).toEqual([
			{ name: "Ally Bank", verb: "linked", date: "2026-10-02" },
		]);
	});

	it("keeps an account's last balance from before the six months when it has none inside them", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		await env.DB.prepare("DELETE FROM accounts WHERE id = 2").run();
		await addBalance(1, "2026-05-01", 100000);
		await addBalance(1, "2026-05-02", 110000);
		await addBalance(3, "2026-04-20", 30000);
		await addBalance(3, "2026-03-01", 99999);
		const { points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(added).toEqual([]);
		expect(points).toEqual([
			{ date: "2026-05-01", cents: 70000 },
			{ date: "2026-05-02", cents: 80000 },
		]);
	});

	it("ignores rows dated after today", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		await addBalance(1, TODAY, 100000);
		await addBalance(2, TODAY, 200000);
		await addBalance(3, TODAY, 30000);
		await addBalance(1, "2026-10-06", 500000);
		expect((await accountsWithHistory(env.DB, TODAY)).points).toEqual([
			{ date: TODAY, cents: 270000 },
		]);
	});

	it("is empty, and names no account, before any balance is recorded", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		const { points, added } = await accountsWithHistory(env.DB, TODAY);
		expect(points).toEqual([]);
		expect(added).toEqual([]);
	});
});
