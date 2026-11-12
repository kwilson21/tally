import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The budgets area's three routes after the cutover (#951): they answer as before, and what the rules add shows only in
// what is stored: a request for what is already true saves nothing, and two taps at once still both count.

const BASE = "http://tally.test";

async function post(path: string, fields: Record<string, string> = {}) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields).toString(),
	});

	await res.text();

	return res;
}

const toast = (res: Response) =>
	// SAFETY: the HX-Trigger header is JSON this app writes itself, with the toast key below when a route sends one.
	(
		JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
			toast?: { message: string; type: string };
		}
	).toast;

const THIS_MONTH = () => todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
const LAST_MONTH = () => monthsBefore(THIS_MONTH(), 1);

const budgetRows = async (categoryId = 1) =>
	(
		await env.DB.prepare(
			"SELECT effective_month AS month, amount_cents AS cents FROM budget_amounts WHERE category_id = ? ORDER BY effective_month",
		)
			.bind(categoryId)
			.all<{ month: string; cents: number }>()
	).results;

const goalRows = async () =>
	(
		await env.DB.prepare(
			"SELECT effective_month AS month, amount_cents AS cents FROM savings_goal_amounts ORDER BY effective_month",
		).all<{ month: string; cents: number }>()
	).results;

/** Groceries (category 1) with one budget, set last month. */
const budgetFromLastMonth = (cents: number) =>
	env.DB.batch([
		env.DB.prepare("DELETE FROM budget_amounts WHERE category_id = 1"),
		env.DB.prepare(
			"INSERT INTO budget_amounts (category_id, effective_month, amount_cents) VALUES (1, ?, ?)",
		).bind(LAST_MONTH(), cents),
	]);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("POST /budget/:id", () => {
	it("saves a new amount from this month on, leaving last month's alone", async () => {
		await budgetFromLastMonth(65000);
		const res = await post("/budget/1", { budget: "700" });
		expect(res.status).toBe(200);
		expect(toast(res)?.type).toBe("success");
		expect(await budgetRows()).toEqual([
			{ month: LAST_MONTH(), cents: 65000 },
			{ month: THIS_MONTH(), cents: 70000 },
		]);
	});

	it("answers the same for the amount it already has, and saves nothing", async () => {
		await budgetFromLastMonth(65000);
		const changed = await post("/budget/1", { budget: "700" });
		await budgetFromLastMonth(65000);
		const same = await post("/budget/1", { budget: "650.00" });
		expect(same.status).toBe(200);
		expect(toast(same)).toEqual(toast(changed));
		expect(await budgetRows()).toEqual([{ month: LAST_MONTH(), cents: 65000 }]);
	});

	it("is not found for an archived category, a category that isn't there, or id 0, and saves nothing", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		const before = await budgetRows();
		expect((await post("/budget/1", { budget: "700" })).status).toBe(404);
		expect(await budgetRows()).toEqual(before);
		expect((await post("/budget/999999", { budget: "700" })).status).toBe(404);
		expect(await budgetRows(999999)).toEqual([]);
		expect((await post("/budget/0", { budget: "700" })).status).toBe(404);
	});

	it("refuses an amount it can't read with the sheet and its words, and saves nothing", async () => {
		await budgetFromLastMonth(65000);
		const res = await post("/budget/1", { budget: "six hundred" });
		expect(res.status).toBe(422);
		expect(await budgetRows()).toEqual([{ month: LAST_MONTH(), cents: 65000 }]);
	});
});

describe("POST /budget/:id/nudge/:direction", () => {
	it("counts both of two taps made at once", async () => {
		await budgetFromLastMonth(71240);

		const [a, b] = await Promise.all([
			post("/budget/1/nudge/up"),
			post("/budget/1/nudge/up"),
		]);

		expect([a.status, b.status]).toEqual([200, 200]);
		expect(await budgetRows()).toEqual([
			{ month: LAST_MONTH(), cents: 71240 },
			{ month: THIS_MONTH(), cents: 73000 },
		]);
	});

	it("counts an up and a down made at once, in either order", async () => {
		await budgetFromLastMonth(72000);
		await Promise.all([
			post("/budget/1/nudge/up"),
			post("/budget/1/nudge/down"),
		]);
		expect((await budgetRows()).at(-1)).toEqual({
			month: THIS_MONTH(),
			cents: 72000,
		});
	});

	it("says so and saves nothing when the budget is already as far as it goes", async () => {
		await budgetFromLastMonth(0);
		const res = await post("/budget/1/nudge/down");
		expect(res.status).toBe(200);
		expect(toast(res)).toMatchObject({ type: "info" });
		expect(toast(res)?.message).toContain("already $0");
		expect(await budgetRows()).toEqual([{ month: LAST_MONTH(), cents: 0 }]);
	});

	it("is not found for a category with no budget or an archived one, and saves nothing", async () => {
		await env.DB.prepare(
			"DELETE FROM budget_amounts WHERE category_id = 1",
		).run();
		expect((await post("/budget/1/nudge/up")).status).toBe(404);
		expect(await budgetRows()).toEqual([]);
		await budgetFromLastMonth(72000);
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		expect((await post("/budget/1/nudge/up")).status).toBe(404);
		expect(await budgetRows()).toEqual([{ month: LAST_MONTH(), cents: 72000 }]);
	});
});

describe("POST /savings-goal", () => {
	const goalFromLastMonth = (cents: number) =>
		env.DB.batch([
			env.DB.prepare("DELETE FROM savings_goal_amounts"),
			env.DB.prepare(
				"INSERT INTO savings_goal_amounts (effective_month, amount_cents) VALUES (?, ?)",
			).bind(LAST_MONTH(), cents),
		]);

	it("saves a new goal from this month on, leaving last month's alone", async () => {
		await goalFromLastMonth(20000);
		const res = await post("/savings-goal", { goal: "300" });
		expect(res.status).toBe(200);
		expect(await goalRows()).toEqual([
			{ month: LAST_MONTH(), cents: 20000 },
			{ month: THIS_MONTH(), cents: 30000 },
		]);
	});

	it("answers the same for the goal it already has, and saves nothing", async () => {
		await goalFromLastMonth(20000);
		const changed = await post("/savings-goal", { goal: "300" });
		await goalFromLastMonth(20000);
		const same = await post("/savings-goal", { goal: "200" });
		expect(same.status).toBe(200);
		expect(toast(same)).toEqual(toast(changed));
		expect(await goalRows()).toEqual([{ month: LAST_MONTH(), cents: 20000 }]);
	});

	it("saves nothing for $0 when there is no goal", async () => {
		await env.DB.prepare("DELETE FROM savings_goal_amounts").run();
		expect((await post("/savings-goal", { goal: "0" })).status).toBe(200);
		expect(await goalRows()).toEqual([]);
	});
});
