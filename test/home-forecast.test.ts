import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { homeForecastDays } from "../src/db/home-forecast";
import { resetDemo } from "../src/demo/reset";
import { FORECAST_START_DAY, forecastMonth } from "../src/home-forecast";
import { HomeForecast } from "../src/views/home-forecast";

describe("forecastMonth", () => {
	it("counts refunds once without projecting them as everyday spending", () => {
		const cases = [
			{
				name: "bill credit",
				spentCents: -2000,
				billPaymentsCents: -2000,
				refundsCents: 0,
				endCents: -2000,
			},
			{
				name: "unlinked refund",
				spentCents: 8000,
				billPaymentsCents: 0,
				refundsCents: 2000,
				endCents: 18667,
			},
			{
				name: "bill payment",
				spentCents: 5000,
				billPaymentsCents: 5000,
				refundsCents: 0,
				endCents: 5000,
			},
			{
				name: "everyday spending",
				spentCents: 1000,
				billPaymentsCents: 0,
				refundsCents: 0,
				endCents: 2067,
			},
		];
		for (const entry of cases) {
			const forecast = forecastMonth({
				day: 15,
				daysInMonth: 31,
				totalBudgetCents: 100000,
				spentCents: entry.spentCents,
				billPaymentsCents: entry.billPaymentsCents,
				refundsCents: entry.refundsCents,
				planPaymentsCents: 0,
				billsStillDueCents: 0,
			});
			expect(forecast.endCents, entry.name).toBe(entry.endCents);
		}
		const noRefund = forecastMonth({
			day: 15,
			daysInMonth: 31,
			totalBudgetCents: 100000,
			spentCents: 10000,
			billPaymentsCents: 0,
			refundsCents: 0,
			planPaymentsCents: 0,
			billsStillDueCents: 0,
		});
		expect(noRefund.endCents).toBe(20667);
		const overRefunded = forecastMonth({
			day: 15,
			daysInMonth: 31,
			totalBudgetCents: 100000,
			spentCents: -2000,
			billPaymentsCents: 0,
			refundsCents: 3000,
			planPaymentsCents: 0,
			billsStillDueCents: 0,
		});
		expect(overRefunded.endCents).toBe(-2000);
	});

	it("projects everyday spending and bills still due in integer cents", () => {
		expect(
			forecastMonth({
				day: 15,
				daysInMonth: 31,
				totalBudgetCents: 100000,
				spentCents: 40000,
				billPaymentsCents: 10000,
				refundsCents: 0,
				planPaymentsCents: 0,
				billsStillDueCents: 5000,
			}),
		).toEqual({
			endCents: 77000,
			underCents: 23000,
			visible: true,
		});
	});

	it("rounds a projected overage up to whole dollars", () => {
		expect(
			forecastMonth({
				day: 7,
				daysInMonth: 31,
				totalBudgetCents: 50000,
				spentCents: 100000,
				billPaymentsCents: 0,
				refundsCents: 0,
				planPaymentsCents: 0,
				billsStillDueCents: 0,
			}),
		).toEqual({
			endCents: 442857,
			overCents: 392900,
			visible: true,
		});
	});

	it("excludes planned payments from the projected everyday pace", () => {
		const input = {
			day: 15,
			daysInMonth: 31,
			totalBudgetCents: 100000,
			spentCents: 40000,
			billPaymentsCents: 10000,
			refundsCents: 0,
			planPaymentsCents: 5000,
			billsStillDueCents: 5000,
		};
		expect(forecastMonth(input).endCents).toBe(71667);
	});

	it("starts on day 7 and has no forecast before then", () => {
		const input = {
			day: 6,
			daysInMonth: 28,
			totalBudgetCents: 10000,
			spentCents: 0,
			billPaymentsCents: 0,
			refundsCents: 0,
			planPaymentsCents: 0,
			billsStillDueCents: 0,
		};
		expect(FORECAST_START_DAY).toBe(7);
		expect(forecastMonth(input).visible).toBe(false);
		expect(forecastMonth({ ...input, day: 7 }).visible).toBe(true);
	});

	it.each([
		["2026-02", 28],
		["2026-03", 31],
	])("shows on the last day of a %s month", (month, daysInMonth) => {
		const html = String(
			HomeForecast({
				month,
				day: daysInMonth,
				daysInMonth,
				spentByDay: Array.from({ length: daysInMonth }, () => 100),
				budgetCents: 10000,
				endCents: 10000,
				differenceCents: 0,
			}),
		);
		expect(html).toContain(
			`by ${month === "2026-02" ? "Feb 28" : "Mar 31"}, at this pace`,
		);
	});
});

describe("HomeForecast chart scale", () => {
	it("keeps an earlier cumulative spending peak inside the viewBox", () => {
		const html = String(
			HomeForecast({
				month: "2026-10",
				day: 2,
				daysInMonth: 31,
				spentByDay: [20000, -19000],
				budgetCents: 10000,
				endCents: 5000,
				differenceCents: 5000,
			}),
		);
		const points = [
			...html.matchAll(/(?:\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g),
		].map((match) => Number(match[1]));
		expect(points.length).toBeGreaterThan(0);
		expect(points.every((y) => y >= 34 && y <= 142)).toBe(true);
	});
});

describe("homeForecastDays query budget", () => {
	it("assigns linked credits, refunds, bill payments, and spending once", async () => {
		const month = "2099-10";
		await resetDemo(env.DB, `${month}-18`);
		const before = await homeForecastDays(env.DB, month, `${month}-18`);
		const names = [
			"Forecast role bill credit",
			"Forecast role refund",
			"Forecast role payment",
			"Forecast role everyday",
		];
		const bill = await env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,merchant_raw_name) VALUES('Forecast role bill', 2000, 15, 'monthly', 'Forecast role bill') RETURNING id",
		).first<{ id: number }>();
		const paymentBill = await env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,merchant_raw_name) VALUES('Forecast role payment bill', 5000, 17, 'monthly', 'Forecast role payment bill') RETURNING id",
		).first<{ id: number }>();
		try {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name,credit_reviewed) VALUES(1, ?, -2000, ?, 1)",
				).bind(`${month}-15`, names[0]),
				env.DB.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name,credit_reviewed) VALUES(1, ?, -2000, ?, 1)",
				).bind(`${month}-16`, names[1]),
				env.DB.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1, ?, 5000, ?)",
				).bind(`${month}-17`, names[2]),
				env.DB.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1, ?, 1000, ?)",
				).bind(`${month}-18`, names[3]),
			]);
			const credit = await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = ? ORDER BY id DESC LIMIT 1",
			)
				.bind(names[0])
				.first<{ id: number }>();
			const payment = await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = ? ORDER BY id DESC LIMIT 1",
			)
				.bind(names[2])
				.first<{ id: number }>();
			if (!bill || !paymentBill || !credit || !payment)
				throw new Error("Forecast fixture missing");
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, ?, ?, 'user', 'linked')",
				).bind(bill.id, month, credit.id),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, ?, ?, 'user', 'linked')",
				).bind(paymentBill.id, month, payment.id),
			]);
			const rows = await homeForecastDays(env.DB, month, `${month}-18`);
			for (const [day, spentCents, billPaymentsCents, refundsCents] of [
				[15, -2000, -2000, 0],
				[16, -2000, 0, 2000],
				[17, 5000, 5000, 0],
				[18, 1000, 0, 0],
			]) {
				const prior = before.find((row) => row.day === day);
				const actual = rows.find((row) => row.day === day);
				expect((actual?.spentCents ?? 0) - (prior?.spentCents ?? 0)).toBe(
					spentCents,
				);
				expect(
					(actual?.billPaymentsCents ?? 0) - (prior?.billPaymentsCents ?? 0),
				).toBe(billPaymentsCents);
				expect((actual?.refundsCents ?? 0) - (prior?.refundsCents ?? 0)).toBe(
					refundsCents,
				);
			}
		} finally {
			await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id = ?")
				.bind(bill?.id)
				.run();
			await env.DB.prepare(
				"DELETE FROM transactions WHERE raw_name IN (?, ?, ?, ?)",
			)
				.bind(...names)
				.run();
			await env.DB.prepare("DELETE FROM bills WHERE id = ?")
				.bind(bill?.id)
				.run();
			await env.DB.prepare("DELETE FROM bills WHERE id = ?")
				.bind(paymentBill?.id)
				.run();
		}
	});

	it("reads the current month's forecast in one bounded statement", async () => {
		let statements = 0;
		let forecastSql = "";
		const db = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						forecastSql = sql;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const today = todayIn(DEFAULT_TIME_ZONE);
		await homeForecastDays(db as D1Database, today.slice(0, 7), today);
		expect(statements).toBe(1);
		expect(forecastSql).toContain("t.date >= ? AND t.date < ? AND t.date <= ?");
	});
});
