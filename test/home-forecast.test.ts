import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { homeForecastDays } from "../src/db/home-forecast";
import { forecastMonth } from "../src/home-forecast";

describe("forecastMonth", () => {
	it("projects everyday spending and bills still due in integer cents", () => {
		expect(
			forecastMonth({
				day: 15,
				daysInMonth: 31,
				totalBudgetCents: 100000,
				spentCents: 40000,
				billPaymentsCents: 10000,
				planPaymentsCents: 0,
				refundsCents: 2000,
				billsStillDueCents: 5000,
			}),
		).toEqual({
			endCents: 79133,
			underCents: 20800,
			visible: true,
		});
	});

	it("rounds a projected overage up to whole dollars", () => {
		expect(
			forecastMonth({
				day: 3,
				daysInMonth: 31,
				totalBudgetCents: 50000,
				spentCents: 100000,
				billPaymentsCents: 0,
				planPaymentsCents: 0,
				refundsCents: 60000,
				billsStillDueCents: 0,
			}),
		).toEqual({
			endCents: 1593333,
			overCents: 1543400,
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
			planPaymentsCents: 5000,
			refundsCents: 2000,
			billsStillDueCents: 5000,
		};
		expect(forecastMonth(input).endCents).toBe(73800);
	});

	it("starts on the third day and has no forecast before then", () => {
		const input = {
			day: 2,
			daysInMonth: 28,
			totalBudgetCents: 10000,
			spentCents: 0,
			billPaymentsCents: 0,
			planPaymentsCents: 0,
			refundsCents: 0,
			billsStillDueCents: 0,
		};
		expect(forecastMonth(input).visible).toBe(false);
		expect(forecastMonth({ ...input, day: 3 }).visible).toBe(true);
	});
});

describe("homeForecastDays query budget", () => {
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
