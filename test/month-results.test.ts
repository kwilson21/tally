import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { firstCountedMonth, loadMonth, monthResults } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";

/** A finished month's result as Home's MonthEnd shows it: budgets minus all counted spending, null with no budgets. */
async function resultFromSummary(month: string) {
	const data = await loadMonth(env.DB, month);
	const summary = summarizeMonth({
		month,
		...data,
		unpaidDueBillsCents: 0,
	});
	return summary.categories.length > 0
		? summary.totalBudgetCents - summary.totalSpentCents
		: null;
}

describe("monthResults", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	});

	it("matches the result Home's MonthEnd shows for every month of the demo", async () => {
		const current = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const first = await firstCountedMonth(env.DB);
		if (!first) throw new Error("Demo has no counted month");
		const months: string[] = [];
		for (let month = first; month <= current; month = monthsBefore(month, -1))
			months.push(month);
		const results = await monthResults(env.DB, months);
		expect(Object.keys(results).sort()).toEqual([...months].sort());
		for (const month of months) {
			expect(results[month], month).toBe(await resultFromSummary(month));
		}
	});

	it("matches summarizeMonth when a category was archived and its refunds and bills count", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE categories SET archived = 1, archived_on = '2026-07-10' WHERE name = 'Eating Out'",
			),
			env.DB.prepare(
				"INSERT INTO category_archive_periods (category_id, archived_on) SELECT id, '2026-07-10' FROM categories WHERE name = 'Eating Out'",
			),
		]);
		const months = ["2026-04", "2026-06", "2026-07", "2026-08", "2026-09"];
		const results = await monthResults(env.DB, months);
		for (const month of months) {
			expect(results[month], month).toBe(await resultFromSummary(month));
		}
	});

	it("gives null for a month with no budget, and nothing for a month not asked for", async () => {
		const results = await monthResults(env.DB, ["2026-04", "2026-09"]);
		expect(results["2026-04"]).toBeNull();
		expect(typeof results["2026-09"]).toBe("number");
		expect("2026-05" in results).toBe(false);
	});
});
