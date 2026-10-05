import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { daysBefore } from "../src/dates";
import { merchantKeySql } from "../src/db/merchant-key";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { buildSeed, monthOffset } from "../src/demo/seed";
import { chartStart, netWorthSeries, netWorthView } from "../src/net-worth";

describe("buildSeed", () => {
	it.each(["2026-09-22", "2026-09-01", "2026-02-28", "2027-01-31"])(
		"designed totals hold on %s",
		(today) => {
			const seed = buildSeed(today);
			const month = today.slice(0, 7);
			// A linked refund counts in its purchase's month (spec §6).
			const countedDate = (t: (typeof seed.transactions)[number]) =>
				seed.transactions.find((p) => p.id === t.refundOfId)?.date ?? t.date;
			const counted = seed.transactions.filter(
				(t) => countedDate(t).startsWith(month) && !t.excluded && !t.isSplit,
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
				Groceries: 39458,
				"Eating Out": 28600,
				Gas: 18600,
				Kids: 21000,
				Household: 15041,
			});
			expect(summary.uncategorized).toEqual({ spentCents: 22801, count: 12 });
			expect(summary.incomeCents).toBe(490000);
			expect(summary.safeToSpendCents).toBe(24500);
		},
	);

	it.each(["2026-09-22", "2026-09-01", "2026-03-31", "2027-01-31"])(
		"links the Target refund to a purchase last month on %s",
		(today) => {
			const seed = buildSeed(today);
			const refund = seed.transactions.find((t) => t.refundOfId);
			const purchase = seed.transactions.find(
				(t) => t.id === refund?.refundOfId,
			);
			expect(refund).toMatchObject({
				rawName: "TARGET T-1432",
				amountCents: -2499,
			});
			expect(purchase).toMatchObject({
				rawName: "TARGET T-1432",
				amountCents: 8499,
				categoryId: 4,
			});
			expect(purchase?.date.slice(0, 7)).toBe(monthOffset(today, 1));
			expect(refund?.date).toBe(daysBefore(today, 5));
			expect((purchase?.date ?? "") >= daysBefore(today, 31)).toBe(true);
		},
	);

	it("never dates a transaction after today", () => {
		const seed = buildSeed("2026-09-03");
		expect(seed.transactions.every((t) => t.date <= "2026-09-03")).toBe(true);
	});

	// The designed totals above include Netflix's $17.99 in Household, and Safe to spend is $17.99 lower.
	it.each(["2026-09-22", "2026-09-01", "2026-03-31", "2027-01-31"])(
		"has Netflix's one $17.99 charge, last, in this month, on %s",
		(today) => {
			const seed = buildSeed(today);
			const netflix = seed.transactions.filter(
				(t) => t.rawName === "NETFLIX.COM",
			);
			expect(netflix).toHaveLength(1);
			expect(netflix[0]).toMatchObject({ amountCents: 1799, categoryId: 5 });
			expect(netflix[0]?.date.slice(0, 7)).toBe(today.slice(0, 7));
			expect((netflix[0]?.date ?? "9") <= today).toBe(true);
			// Appended after everything else, so the ids the screenshots use don't move.
			expect(seed.transactions.at(-1)?.rawName).toBe("NETFLIX.COM");
			expect(seed.merchants.find((m) => m.key === "NETFLIX.COM")).toMatchObject(
				{ displayName: "Netflix" },
			);
		},
	);

	it("gives the unpaid Electric and Internet bills' merchants no charges to offer", async () => {
		const seed = buildSeed("2026-09-22");
		for (const rawName of ["METRO ELECTRIC CO", "RIVERSIDE FIBER INTERNET"])
			expect(seed.transactions.some((t) => t.rawName === rawName)).toBe(false);
		await resetDemo(env.DB, "2026-09-22");
		const bills = (
			await env.DB.prepare(
				"SELECT name, merchant_raw_name AS merchant FROM bills WHERE name IN ('Electric','Internet','Netflix') ORDER BY id",
			).all<{ name: string; merchant: string }>()
		).results;
		expect(bills).toEqual([
			{ name: "Electric", merchant: "METRO ELECTRIC CO" },
			{ name: "Netflix", merchant: "NETFLIX.COM" },
			{ name: "Internet", merchant: "RIVERSIDE FIBER INTERNET" },
		]);
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

	it("has exactly one merchant row per merchant key, covering every transaction", () => {
		const seed = buildSeed("2026-09-22");
		const keys = seed.merchants.map((m) => m.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const t of seed.transactions)
			expect(keys).toContain(t.merchantName ?? t.rawName);
	});

	it("gives a few transactions Plaid's merchant name, two raw names sharing one", () => {
		const seed = buildSeed("2026-09-22");
		const named = seed.transactions.filter((t) => t.merchantName);
		expect(named.length).toBeGreaterThan(5);
		expect(
			new Set(
				named.filter((t) => t.merchantName === "Amazon").map((t) => t.rawName),
			),
		).toEqual(new Set(["AMAZON.COM*RT4K2", "AMZN MKTP US*2K4"]));
		// Most of the demo, and every cash transaction, has none.
		expect(
			seed.transactions.filter((t) => !t.merchantName).length,
		).toBeGreaterThan(named.length);
		expect(
			seed.transactions.find((t) => t.accountId === 4)?.merchantName ?? null,
		).toBeNull();
	});

	it("changes the Eating Out budget two months ago", () => {
		const seed = buildSeed("2026-09-22");
		expect(seed.budgetAmounts.filter((a) => a.categoryId === 2)).toEqual([
			{ categoryId: 2, effectiveMonth: "2026-04", amountCents: 20000 },
			{ categoryId: 2, effectiveMonth: "2026-07", amountCents: 25000 },
		]);
	});
});

describe("buildSeed's balance history (spec §9, feature 7)", () => {
	const TODAYS = ["2026-10-05", "2026-09-01", "2026-03-31", "2027-01-31"];
	/** The seed's Plaid accounts: the Cash account has no balance history. */
	const bankAccounts = (today: string) =>
		buildSeed(today).accounts.filter((a) => a.bankId !== null);

	it.each(TODAYS)(
		"has every bank account's balance on every day from the chart's first day to today, on %s",
		(today) => {
			const { balanceHistory } = buildSeed(today);
			const dates = [...new Set(balanceHistory.map((r) => r.date))];
			expect(dates[0]).toBe(chartStart(today));
			expect(dates.at(-1)).toBe(today);
			// No day is missing, and no day is after today.
			for (const [i, date] of dates.entries())
				if (i > 0) expect(daysBefore(date, 1)).toBe(dates[i - 1]);
			const accountIds = bankAccounts(today).map((a) => a.id);
			expect(accountIds).toEqual([1, 2, 3]);
			expect(balanceHistory).toHaveLength(dates.length * accountIds.length);
			expect(
				balanceHistory.every((r) => accountIds.includes(r.accountId)),
			).toBe(true);
			expect(
				balanceHistory.every(
					(r) => Number.isInteger(r.balanceCents) && r.balanceCents > 0,
				),
			).toBe(true);
		},
	);

	it.each(TODAYS)(
		"ends on each account's balance today, so the line meets the headline, on %s",
		(today) => {
			const { balanceHistory } = buildSeed(today);
			for (const account of bankAccounts(today)) {
				expect(
					balanceHistory.find(
						(r) => r.accountId === account.id && r.date === today,
					)?.balanceCents,
				).toBe(account.balanceCents);
			}
		},
	);

	it("is the same every time it is built", () => {
		expect(buildSeed("2026-10-05").balanceHistory).toEqual(
			buildSeed("2026-10-05").balanceHistory,
		);
	});

	it.each(TODAYS)(
		"makes a net-worth line that rose, ending on today's net worth, on %s",
		(today) => {
			const seed = buildSeed(today);
			const liability = new Map(
				seed.accounts.map((a) => [a.id, a.isLiability]),
			);
			const points = netWorthSeries(
				seed.balanceHistory.map((r) => ({
					...r,
					isLiability: liability.get(r.accountId) ?? false,
				})),
				chartStart(today),
			);
			// $4,210.55 + $12,400.00 − $842.17
			expect(points.at(-1)).toEqual({ date: today, cents: 1576838 });
			const view = netWorthView(points, today);
			expect(view.kind).toBe("line");
			expect(view).toMatchObject({ sentence: expect.stringMatching(/^Up \$/) });
		},
	);
});

describe("resetDemo", () => {
	it("stores the seed's balance history, and running it twice gives the same rows", async () => {
		const history = buildSeed("2026-10-05").balanceHistory;
		await resetDemo(env.DB, "2026-10-05");
		await resetDemo(env.DB, "2026-10-05");
		const { results } = await env.DB.prepare(
			"SELECT account_id AS accountId, date, balance_cents AS balanceCents FROM balance_history ORDER BY date, account_id",
		).all();
		expect(results).toEqual(history);
	});

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

	it("stores the seed's merchant names, and every bill's key is its linked payment's merchant key", async () => {
		await resetDemo(env.DB, "2026-09-22");
		const named = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE merchant_name IS NOT NULL",
		).first<{ n: number }>();
		expect(named?.n).toBeGreaterThan(5);

		const { results } = await env.DB.prepare(
			`SELECT b.merchant_raw_name AS billKey, ${merchantKeySql("t")} AS paymentKey
			FROM bill_payments bp
			JOIN bills b ON b.id = bp.bill_id
			JOIN transactions t ON t.id = bp.transaction_id
			WHERE bp.status = 'linked'`,
		).all<{ billKey: string; paymentKey: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const row of results) expect(row.billKey).toBe(row.paymentKey);

		// Every transaction's display name is found under its key, so names resolve for both Amazons.
		const unresolved = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM transactions t
			WHERE NOT EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("t")})`,
		).first<{ n: number }>();
		expect(unresolved?.n).toBe(0);
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
		expect(summary.safeToSpendCents).toBe(24500);
		expect(summary.uncategorized.count).toBe(12);

		const { results } = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM merchants WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).all<{ n: number }>();
		expect(results[0]?.n).toBe(1);
	});
});
