import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { netWorthHistory } from "../src/db/balance-history";
import { resetDemo } from "../src/demo/reset";

const TODAY = "2026-10-05";

const addBalance = (accountId: number, date: string, cents: number) =>
	env.DB.prepare(
		"INSERT INTO balance_history (account_id, date, balance_cents) VALUES (?, ?, ?)",
	)
		.bind(accountId, date, cents)
		.run();

// The demo's accounts: 1 Checking and 2 Savings at First Harbor Bank, 3 Credit card at Northline, 4 Cash.
describe("netWorthHistory", () => {
	beforeEach(() => resetDemo(env.DB, TODAY));

	it("is net worth on each day of the chart's six months, ending on today's headline", async () => {
		const points = await netWorthHistory(env.DB, TODAY);
		expect(points[0]?.date).toBe("2026-05-01");
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1576838 });
		// May 1 to Oct 5, one point a day.
		expect(points).toHaveLength(158);
	});

	it("leaves the Cash account out, as net worth does", async () => {
		const before = await netWorthHistory(env.DB, TODAY);
		await addBalance(4, TODAY, 999999);
		await addBalance(4, "2026-06-01", 999999);
		expect(await netWorthHistory(env.DB, TODAY)).toEqual(before);
	});

	it("leaves a disconnected bank's accounts out of the whole line, so it still meets the headline", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE institution_name = 'Northline Card Services'",
		).run();
		const points = await netWorthHistory(env.DB, TODAY);
		// Checking and Savings only: $4,210.55 + $12,400.00.
		expect(points.at(-1)).toEqual({ date: TODAY, cents: 1661055 });
		expect(points).toHaveLength(158);
	});

	it("keeps an account's last balance from before the six months when it has none inside them", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		await addBalance(1, "2026-05-01", 100000);
		await addBalance(1, "2026-05-02", 110000);
		await addBalance(3, "2026-04-20", 30000);
		await addBalance(3, "2026-03-01", 99999);
		expect(await netWorthHistory(env.DB, TODAY)).toEqual([
			{ date: "2026-05-01", cents: 70000 },
			{ date: "2026-05-02", cents: 80000 },
		]);
	});

	it("ignores rows dated after today", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		await addBalance(1, TODAY, 100000);
		await addBalance(1, "2026-10-06", 500000);
		expect(await netWorthHistory(env.DB, TODAY)).toEqual([
			{ date: TODAY, cents: 100000 },
		]);
	});

	it("is empty before any balance is recorded", async () => {
		await env.DB.prepare("DELETE FROM balance_history").run();
		expect(await netWorthHistory(env.DB, TODAY)).toEqual([]);
	});
});
