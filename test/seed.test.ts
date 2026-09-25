import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { buildSeed } from "../src/demo/seed";

describe("buildSeed", () => {
	it.each(["2026-09-22", "2026-09-01", "2026-02-28", "2027-01-31"])(
		"designed totals hold on %s",
		(today) => {
			const seed = buildSeed(today);
			const month = today.slice(0, 7);
			const counted = seed.transactions.filter(
				(t) => t.date.startsWith(month) && !t.excluded && !t.isSplit,
			);

			const summary = summarizeMonth({
				month,
				categories: seed.categories,
				amounts: seed.budgetAmounts,
				transactions: counted.map((t) => ({
					categoryId: t.categoryId,
					amountCents: t.amountCents,
					income: t.flagIncome,
				})),
				unpaidDueBillsCents: 0,
			});

			const spent = Object.fromEntries(
				summary.categories.map((c) => [c.name, c.spentCents]),
			);
			expect(spent).toEqual({
				Groceries: 41200,
				"Eating Out": 28600,
				Gas: 18600,
				Kids: 21000,
				Household: 9500,
			});
			expect(summary.uncategorized).toEqual({ spentCents: 22801, count: 12 });
			expect(summary.incomeCents).toBe(490000);
			expect(summary.safeToSpendCents).toBe(28299);
		},
	);

	it("never dates a transaction after today", () => {
		const seed = buildSeed("2026-09-03");
		expect(seed.transactions.every((t) => t.date <= "2026-09-03")).toBe(true);
	});

	it("includes six months of history with Eating Out creeping up", () => {
		const seed = buildSeed("2026-09-22");
		const eatingOut = (month: string) =>
			seed.transactions
				.filter((t) => t.date.startsWith(month) && t.categoryId === 2)
				.reduce((sum, t) => sum + t.amountCents, 0);
		expect(
			["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"].map(eatingOut),
		).toEqual([17000, 19500, 21500, 24000, 26200]);
	});

	it("has exactly one merchant row per raw name, covering every transaction", () => {
		const seed = buildSeed("2026-09-22");
		const names = seed.merchants.map((m) => m.rawName);
		expect(new Set(names).size).toBe(names.length);
		for (const t of seed.transactions) expect(names).toContain(t.rawName);
	});

	it("changes the Eating Out budget two months ago", () => {
		const seed = buildSeed("2026-09-22");
		expect(seed.budgetAmounts.filter((a) => a.categoryId === 2)).toEqual([
			{ categoryId: 2, effectiveMonth: "2026-04", amountCents: 20000 },
			{ categoryId: 2, effectiveMonth: "2026-07", amountCents: 25000 },
		]);
	});
});

describe("resetDemo", () => {
	it("gives Local Bakery id 110, which the edit-sheet screenshot uses", async () => {
		await resetDemo(env.DB, "2026-09-22");
		const row = await env.DB.prepare(
			"SELECT raw_name FROM transactions WHERE id = 110",
		).first<{ raw_name: string }>();
		expect(row?.raw_name).toBe("SQ *LOCAL BAKERY 4432");
	});

	it("gives a Jev-picked Trader Joe's id 94, which the Jev edit-sheet screenshot uses", async () => {
		await resetDemo(env.DB, "2026-09-22");
		const row = await env.DB.prepare(
			"SELECT raw_name, category_source FROM transactions WHERE id = 94",
		).first<{ raw_name: string; category_source: string }>();
		expect(row).toEqual({
			raw_name: "TRADER JOE'S #552",
			category_source: "jev",
		});
	});

	it("gives the seed's Jev-categorized rows a matching Jev pick", async () => {
		await resetDemo(env.DB, "2026-09-22");
		const mismatched = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'jev' AND jev_category_id IS NOT category_id",
		).first<{ n: number }>();
		const others = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE COALESCE(category_source, '') != 'jev' AND jev_category_id IS NOT NULL",
		).first<{ n: number }>();
		expect(mismatched?.n).toBe(0);
		expect(others?.n).toBe(0);
	});

	it("replaces all data with the seed, and running it twice gives the same result", async () => {
		await resetDemo(env.DB, "2026-09-22");
		await resetDemo(env.DB, "2026-09-22");

		const data = await loadMonth(env.DB, "2026-09");
		const summary = summarizeMonth({
			month: "2026-09",
			...data,
			unpaidDueBillsCents: 0,
		});
		expect(summary.safeToSpendCents).toBe(28299);
		expect(summary.uncategorized.count).toBe(12);

		const { results } = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM merchants WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).all<{ n: number }>();
		expect(results[0]?.n).toBe(1);
	});
});
