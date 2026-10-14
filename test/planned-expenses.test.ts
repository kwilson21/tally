import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { summarizeMonth } from "../src/budget";

import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";

import { homeForecastDays } from "../src/db/home-forecast";
import { loadMonth } from "../src/db/month";
import { plansSetAsideCents } from "../src/db/planned-expenses";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const post = (path: string, form: Record<string, string>) =>
	exports.default.fetch(BASE + path, {
		method: "POST",

		headers: {
			Origin: BASE,
			"HX-Request": "true",
			"content-type": "application/x-www-form-urlencoded",
		},

		body: new URLSearchParams(form),
	});

// The month the tests plan in is the household's current month; the previous one is the month a plan ended in.
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const MONTH = TODAY.slice(0, 7);

const LAST_MONTH = monthsBefore(MONTH, 1);

const dateIn = (month: string) => `${month}-05`;

// The demo seed plans its own two; each test here plans what it needs, so it starts with none.
beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	await env.DB.prepare("DELETE FROM planned_expenses").run();
});

/** A bank payment (money out) in the current month, with a fixed id, plus the plan that may pay it. */
async function payment(id: number, amountCents: number, excluded = 0) {
	await env.DB.prepare(
		"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded) SELECT ?,id,?,?,'DMV FIXTURE',? FROM accounts WHERE type!='cash' LIMIT 1",
	)
		.bind(id, dateIn(MONTH), amountCents, excluded)
		.run();
	return id;
}

async function plan(
	name: string,
	amountCents: number,
	month: string,
	transactionId: number | null = null,
) {
	const row = await env.DB.prepare(
		"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES(?,?,?,?,'demo') RETURNING id",
	)
		.bind(name, amountCents, month, transactionId)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

describe("Safe to spend with planned expenses", () => {
	it("sets a plan aside with the savings goal, and not a plan for a later month", () => {
		const summary = summarizeMonth({
			month: MONTH,
			categories: [{ id: 1, name: "Groceries" }],
			amounts: [{ categoryId: 1, effectiveMonth: MONTH, amountCents: 140000 }],
			transactions: [{ categoryId: 1, amountCents: 46000, income: false }],
			unpaidDueBillsCents: 14200,
			savingsGoalCents: 10000,
			unpaidPlansCents: 18000,
		});

		// $1,400 budget - $460 spent - $142 bill due - $100 savings goal - $180 plan = $518
		expect(summary.safeToSpendCents).toBe(51800);

		expect(summary.savingsGoalCents).toBe(10000);
	});

	it("counts this month's unpaid plans and earlier unpaid ones, but not one linked to a payment", async () => {
		await plan("This month", 18000, MONTH);
		await plan("Earlier", 9000, LAST_MONTH);

		await plan("Later", 40000, monthsBefore(MONTH, -1));

		const paid = await payment(9701, 5000);
		await plan("Paid", 5000, MONTH, paid);
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000 + 9000);
	});
});

describe("planned payments in the budget", () => {
	it("counts an excluded payment once it is linked to a plan, and not before", async () => {
		await payment(9702, 18000, 1);
		const before = await loadMonth(env.DB, MONTH);
		const spentBefore = before.transactions.reduce(
			(sum, t) => sum + t.amountCents,
			0,
		);
		await plan("Car registration", 18000, MONTH, 9702);
		const after = await loadMonth(env.DB, MONTH);
		const spentAfter = after.transactions.reduce(
			(sum, t) => sum + t.amountCents,
			0,
		);
		expect(spentAfter - spentBefore).toBe(18000);
	});

	it("the forecast counts a plan's payment in spending, and never projects it forward", async () => {
		await payment(9703, 18000);
		await plan("Car registration", 18000, MONTH, 9703);
		const days = await homeForecastDays(env.DB, MONTH, `${MONTH}-20`);

		const day = days.find((row) => row.day === 5);
		// In spending so far (spentCents), in its own role, and so not in the everyday pace that is projected forward.
		expect(day?.planPaymentsCents).toBe(18000);
		expect(day?.spentCents).toBeGreaterThanOrEqual(18000);
		expect(day?.everydayCents ?? 0).toBeLessThan(
			(day?.spentCents ?? 0) - 17999,
		);
	});

	it("the bill matcher never links a payment a plan already pays", async () => {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9704,'Registration bill',18000,3,'monthly','DMV FIXTURE')",
		).run();
		await payment(9705, 18000);
		await plan("Car registration", 18000, MONTH, 9705);
		await matchBillPayments(env.DB, TODAY);
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=9705 AND status='linked'",
		).first<{ n: number }>();
		expect(linked?.n).toBe(0);
	});
});

describe("Bills' Planned group, Band and sheet", () => {
	it("lists unpaid plans under Planned with this month's total", async () => {
		await plan("Car registration", 18000, MONTH);
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();
		expect(html).toContain("Planned");
		expect(html).toContain("Car registration");
		expect(html).toContain("Set aside for ");
		expect(html).toContain("$180.00 this month");
		expect(html).toContain("Plan an expense");
	});

	it("asks about one unpaid plan from an earlier month, and Move to this month moves it", async () => {
		const id = await plan("Car registration", 18000, LAST_MONTH);
		await plan("Lawn service", 9000, LAST_MONTH);
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();

		expect(html).toContain("Car registration wasn&#39;t paid");
		expect(html).toContain("1 of 2 planned expenses that weren&#39;t paid");

		const moved = await post(`/plans/${id}/move`, {});
		expect(moved.headers.get("HX-Trigger")).toContain("Moved Car registration");
		const row = await env.DB.prepare(
			"SELECT month FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ month: string }>();
		expect(row?.month).toBe(MONTH);
	});

	it("drops a plan through the same ten-second Undo as a delete, and Undo writes it back", async () => {
		const id = await plan("Car registration", 18000, LAST_MONTH);
		const dropped = await post(`/plans/${id}/drop`, {});
		const trigger = JSON.parse(dropped.headers.get("HX-Trigger") ?? "{}") as {
			toast: { undo: string; undoExpiresInMs: number; message: string };
		};
		expect(trigger.toast.message).toBe("Dropped Car registration, $180.00.");
		expect(trigger.toast.undoExpiresInMs).toBe(10000);
		const gone = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ n: number }>();
		expect(gone?.n).toBe(0);
		const restored = await post("/plans/undo-delete", {
			token: trigger.toast.undo,
		});
		expect(restored.headers.get("HX-Trigger")).toContain(
			"Restored Car registration.",
		);
		const back = await env.DB.prepare(
			"SELECT name FROM planned_expenses WHERE name='Car registration'",
		).first();
		expect(back).not.toBeNull();
	});

	it("an Undo after its ten seconds, or a second Undo, restores nothing", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		await post("/plans/undo-delete", { token });
		const again = await post("/plans/undo-delete", { token });
		expect(again.headers.get("HX-Trigger")).toContain("Undo expired");
	});

	it("creates a plan from the sheet, and refuses an empty name with a field error", async () => {
		const bad = await post("/plans", { name: "", amount: "180", month: MONTH });
		expect(await bad.text()).toContain("Say what it");
		const ok = await post("/plans", {
			name: "Car registration",
			amount: "$180.00",
			month: MONTH,
		});
		expect(ok.headers.get("HX-Trigger")).toContain(
			"Planned Car registration, $180.00.",
		);
		const row = await env.DB.prepare(
			"SELECT amount_cents AS a FROM planned_expenses WHERE name='Car registration'",
		).first<{ a: number }>();
		expect(row?.a).toBe(18000);
	});

	it("links a payment from the plan's page, and says why a payment that pays a bill can't be linked", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		await payment(9706, 18000);
		const ok = await post(`/plans/${id}/link`, { transaction_id: "9706" });
		expect(ok.headers.get("HX-Trigger")).toContain("Payment linked");

		// 9706 now pays Car registration, so a second plan can't take it: the picker never lists it, and a forced link says why.
		const other = await plan("Lawn service", 9000, MONTH);
		const refused = await post(`/plans/${other}/link`, {
			transaction_id: "9706",
		});
		expect(await refused.text()).toContain("can&#39;t be linked");
		const bill = await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9708,'Gym',9000,3,'monthly','GYM FIXTURE') RETURNING id",
		).first();
		expect(bill).not.toBeNull();
		await payment(9707, 9000);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9708,?,9707,'user','linked')",
		)
			.bind(MONTH)
			.run();
		const billed = await post(`/plans/${other}/link`, {
			transaction_id: "9707",
		});
		expect(await billed.text()).toContain("can&#39;t be linked");
	});
});

describe("a bill can't take a payment a plan pays", () => {
	it("refuses the bill's link by hand, with the planned expense's words", async () => {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9709,'Registration fee',18000,3,'monthly','DMV FIXTURE')",
		).run();
		await payment(9710, 18000);
		await plan("Car registration", 18000, MONTH, 9710);
		const refused = await post("/bills/9709/link", {
			transaction_id: "9710",
			period: MONTH,
			opened_period: MONTH,
		});
		expect(await refused.text()).toContain("already pays a planned expense");
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=9710",
		).first<{ n: number }>();
		expect(linked?.n).toBe(0);
	});
});
