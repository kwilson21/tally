import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { savingsGoalForMonth, summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { home as homeRoutes } from "../src/routes/home";
import { D1_STATEMENT_LIMIT } from "./d1-limits";

describe("savings goal history", () => {
	it("uses the latest amount on or before the month", () => {
		const amounts = [
			{ effectiveMonth: "2026-10", amountCents: 50000 },
			{ effectiveMonth: "2026-12", amountCents: 60000 },
		];
		expect(savingsGoalForMonth(amounts, "2026-09")).toBeNull();
		expect(savingsGoalForMonth(amounts, "2026-11")).toBe(50000);
		expect(savingsGoalForMonth(amounts, "2026-12")).toBe(60000);
	});
});

describe("summarizeMonth with a savings goal", () => {
	const summary = (month: string) =>
		summarizeMonth({
			month,
			categories: [{ id: 1, name: "Home" }],
			amounts: [
				{ categoryId: 1, effectiveMonth: "2026-10", amountCents: 140000 },
			],
			transactions: [{ categoryId: 1, amountCents: 46000, income: false }],
			unpaidDueBillsCents: 14200,
			savingsGoalCents: 50000,
		});

	it.each(["2026-10-01", "2026-10-20"])(
		"sets aside the whole goal on %s",
		(date) => {
			const result = summary(date.slice(0, 7));
			expect(result.safeToSpendCents).toBe(29800);
			expect(result.totalBudgetCents).toBe(140000);
			expect(result.categories).toHaveLength(1);
		},
	);
});

describe("savings goal routes", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM savings_goal_amounts").run();
	});

	it("offers Set a goal under Not budgeted", async () => {
		const response = await exports.default.fetch("http://tally.test/");
		const html = await response.text();
		const notBudgeted = html.indexOf("Not budgeted");
		const setGoal = html.indexOf("Set a goal");
		expect(notBudgeted).toBeGreaterThan(-1);
		expect(setGoal).toBeGreaterThan(notBudgeted);
	});

	it("shows the savings goal first and saves it from the household's current month", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
			env.DB.prepare("DELETE FROM savings_goal_amounts"),
		]);
		await env.DB.prepare(
			"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, ?, 140000)",
		)
			.bind(month)
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id) SELECT id, ?, 46000, 'GROCERIES', 1 FROM accounts LIMIT 1",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE))
			.run();
		await env.DB.prepare(
			"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Rent', 14200, ?, 'monthly', 'RENT')",
		)
			.bind(Number(todayIn(DEFAULT_TIME_ZONE).slice(8)))
			.run();
		await env.DB.prepare(
			"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 50000)",
		)
			.bind(month)
			.run();
		const home = await exports.default.fetch("http://tally.test/");
		const html = await home.text();
		expect(html.indexOf("Savings")).toBeLessThan(html.indexOf("Groceries"));
		expect(html).toContain("$500");
		expect(html).toContain("a month");
		expect(html).toContain("Set aside from Safe to spend");
		expect(html).toContain("$298");
		const goalRow = html.slice(
			html.indexOf('<li><a href="/savings-goal"'),
			html.indexOf("</li>", html.indexOf('<li><a href="/savings-goal"')),
		);
		expect(goalRow).not.toContain("bar-fill");
		expect(goalRow).not.toContain("nudge-");

		const sheet = await exports.default.fetch("http://tally.test/savings-goal");
		const sheetHtml = await sheet.text();
		expect(sheetHtml).toContain("Save each month, from ");
		expect(sheetHtml).toContain(
			"Set aside from Safe to spend at the start of every month.",
		);
		const saved = await homeRoutes.fetch(
			new Request("http://tally.test/savings-goal", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
				body: "goal=600",
			}),
			env,
		);
		expect(
			JSON.parse(saved.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Saved the savings goal");
		const row = await env.DB.prepare(
			"SELECT effective_month AS month, amount_cents AS cents FROM savings_goal_amounts ORDER BY effective_month DESC LIMIT 1",
		).first();
		expect(row).toEqual({ month, cents: 60000 });
		const removed = await homeRoutes.fetch(
			new Request("http://tally.test/savings-goal", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
				},
				body: "goal=0",
			}),
			env,
		);
		expect(removed.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents FROM savings_goal_amounts WHERE effective_month = ?",
			)
				.bind(month)
				.first(),
		).toEqual({ amount_cents: 0 });
		expect(await removed.text()).toContain("Set a goal");
	});

	it("keeps Home's D1 statement count below the per-invocation limit", async () => {
		let statements = 0;
		const counted = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await homeRoutes.fetch(new Request("http://tally.test/"), {
			...env,
			DB: counted as D1Database,
		});
		expect(statements).toBeLessThan(D1_STATEMENT_LIMIT);
	});

	it("does not change Safe to spend for an excluded transfer into savings", async () => {
		const month = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare(
			"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, 50000)",
		)
			.bind(month)
			.run();
		const before = await loadMonth(env.DB, month);
		const initial = summarizeMonth({
			...before,
			month,
			unpaidDueBillsCents: 0,
			savingsGoalCents: before.savingsGoalCents,
		}).safeToSpendCents;
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, excluded, flag_transfer) SELECT id, ?, 50000, 'SAVINGS TRANSFER', 1, 1 FROM accounts LIMIT 1",
		)
			.bind(`${month}-15`)
			.run();
		const after = await loadMonth(env.DB, month);
		expect(
			summarizeMonth({
				...after,
				month,
				unpaidDueBillsCents: 0,
				savingsGoalCents: after.savingsGoalCents,
			}).safeToSpendCents,
		).toBe(initial);
	});
});
