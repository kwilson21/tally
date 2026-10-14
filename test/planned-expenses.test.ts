import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { billTotalsForRows } from "../src/bills/totals";
import { summarizeMonth } from "../src/budget";

import {
	DEFAULT_TIME_ZONE,
	monthsBefore,
	shortMonthName,
	todayIn,
} from "../src/dates";

import { homeForecastDays } from "../src/db/home-forecast";
import { loadMonth } from "../src/db/month";
import {
	holdPlanDelete,
	PLAN_UNDO_MS,
	plansSetAsideCents,
	restorePlanDelete,
} from "../src/db/planned-expenses";
import { removeSplit, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { loadBillRows } from "../src/routes/bills";

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

const daysBefore = (days: number) =>
	new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000)
		.toISOString()
		.slice(0, 10);

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

/** Two money-out charges at one merchant 30 days apart and unlinked: Bills finds a possible bill from them. */
async function insertRepeatCharges() {
	await env.DB.prepare(
		"INSERT INTO merchants(raw_name,display_name,default_category_id,not_a_bill) VALUES('GYM REPEAT FIXTURE','Gym',4,0)",
	).run();
	for (const days of [40, 10]) {
		await env.DB.prepare(
			"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_id) SELECT id,?,1000,'GYM REPEAT FIXTURE',4 FROM accounts LIMIT 1",
		)
			.bind(daysBefore(days))
			.run();
	}
}

describe("Safe to spend with planned expenses", () => {
	it("takes the plans' set-aside out alongside the savings goal", () => {
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

	it("takes a $180 plan out of Safe to spend with no savings goal: $1,400 - $460 - $142 - $180 = $618", () => {
		const summary = summarizeMonth({
			month: MONTH,
			categories: [{ id: 1, name: "Groceries" }],
			amounts: [{ categoryId: 1, effectiveMonth: MONTH, amountCents: 140000 }],
			transactions: [{ categoryId: 1, amountCents: 46000, income: false }],
			unpaidDueBillsCents: 14200,
			unpaidPlansCents: 18000,
		});
		expect(summary.safeToSpendCents).toBe(61800);
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

	it("the forecast moves a plan's payment out of everyday spending into its own role, so it is never projected forward", async () => {
		await payment(9703, 18000);
		const unlinked = await homeForecastDays(env.DB, MONTH, `${MONTH}-20`);
		const before = unlinked.find((row) => row.day === 5);

		await plan("Car registration", 18000, MONTH, 9703);
		const linked = await homeForecastDays(env.DB, MONTH, `${MONTH}-20`);
		const after = linked.find((row) => row.day === 5);

		// Still in spending so far, but no longer in the everyday pace that is projected forward.
		expect(before?.planPaymentsCents).toBe(0);
		expect(after?.planPaymentsCents).toBe(18000);
		expect(after?.spentCents).toBe(before?.spentCents);
		expect(after?.everydayCents).toBe((before?.everydayCents ?? 0) - 18000);
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

	it("an Undo after its ten seconds restores nothing", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const now = Date.now();
		const token = await holdPlanDelete(env.DB, id, now);
		expect(token).not.toBeNull();
		expect(
			await restorePlanDelete(env.DB, token ?? "", now + PLAN_UNDO_MS + 1),
		).toBeNull();
		const gone = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ n: number }>();
		expect(gone?.n).toBe(0);
	});

	it("a second Undo restores nothing", async () => {
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

	it("answers an Undo with the Bills page's #page root, where the toast's Undo swaps it in", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		const restored = await post("/plans/undo-delete", { token });
		const body = await restored.text();
		expect(body).toContain('id="page"');
		expect(body).toContain("Car registration");
	});

	it("says the plan's Band on Bills: the repeat-charge Band waits behind it, with Move to and Drop and a dot for each plan", async () => {
		await insertRepeatCharges();
		const before = await (await exports.default.fetch(`${BASE}/bills`)).text();
		// The control: with no plan waiting, the repeat charges are offered as a possible bill.
		expect(before).toContain("possible bill");

		const id = await plan("Car registration", 18000, LAST_MONTH);
		await plan("Lawn service", 9000, LAST_MONTH);
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();
		expect(html).not.toContain("possible bill");

		const band =
			html.match(
				/<section[^>]*aria-labelledby="plan-band-title"[\s\S]*?<\/section>/,
			)?.[0] ?? "";
		expect(band).toContain(`action="/plans/${id}/move"`);
		expect(band).toContain(`Move to ${shortMonthName(MONTH)}`);
		expect(band).toContain(`action="/plans/${id}/drop"`);
		expect(band.match(/size-2\.5 rounded-full/g)).toHaveLength(2);
		expect(band).toContain("1 of 2 planned expenses that weren&#39;t paid");
	});

	it("a planned row opens its sheet in place, as Plan an expense does", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();
		expect(html).toMatch(
			new RegExp(
				`<a\\b[^>]*href="/plans/${id}/edit"[^>]*hx-get="/plans/${id}/edit"`,
			),
		);
	});

	it("Cancel in the delete question goes back to the plan's sheet, not to its payment page", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}/delete`)
		).text();
		const cancel = html.match(/<a\b[^>]*>\s*Cancel\s*<\/a>/)?.[0] ?? "";
		expect(cancel).toContain(`href="/plans/${id}/edit"`);
		expect(cancel).toContain(`hx-get="/plans/${id}/edit"`);
		expect(cancel).toContain('hx-target="#sheet"');
	});

	it("names the edited plan in the sheet's heading for a screen reader, as Edit planned expense", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}/edit`)
		).text();
		expect(html).toMatch(
			/id="plan-sheet-title"[^>]*>\s*<span class="sr-only">Edit planned expense: <\/span>Car registration/,
		);
	});

	it("refuses a new plan in a month before this one, and still keeps a plan's own earlier month when it is saved", async () => {
		const past = await post("/plans", {
			name: "Old",
			amount: "20",
			month: "2020-01",
		});
		expect(await past.text()).toContain("Choose a month.");
		const old = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE name='Old'",
		).first<{ n: number }>();
		expect(old?.n).toBe(0);

		const id = await plan("Car registration", 18000, LAST_MONTH);
		const kept = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: LAST_MONTH,
		});
		expect(kept.headers.get("HX-Trigger")).toContain("Saved Car registration.");
	});

	it("opens the plan's sheet from its own page with Edit planned expense, as a bill's page does", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}`)
		).text();
		expect(html).toContain('id="sheet"');
		expect(html).toMatch(
			new RegExp(
				`<a\\b(?=[^>]*hx-get="/plans/${id}/edit")(?=[^>]*hx-target="#sheet")[^>]*>\\s*Edit planned expense\\s*</a>`,
			),
		);
	});

	it("the sheet's amount field shows the plan's cents, as the money input does", async () => {
		const id = await plan("Car registration", 18050, MONTH);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}/edit`)
		).text();
		expect(html).toContain('value="180.50"');
	});

	it("asks Delete Car registration, $180.00? before the plan is deleted", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}/delete`)
		).text();
		expect(html).toContain("Delete Car registration, $180.00?");
	});

	it("keeps Unlink out of the paid sheet's edit form, so Enter in a field saves, not unlinks", async () => {
		const id = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9750, 18000),
		);
		const html = await (
			await exports.default.fetch(`${BASE}/plans/${id}/edit`)
		).text();
		const edit =
			html.match(
				new RegExp(`<form[^>]*action="/plans/${id}"[\\s\\S]*?</form>`),
			)?.[0] ?? "";
		expect(edit).not.toBe("");
		const buttons = [
			...edit.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
		].map((match) => ({ attrs: match[1] ?? "", text: match[2] ?? "" }));
		// Unlink belongs to its own form (its `form` attribute), so it isn't the edit form's default button.
		const unlink = buttons.find((button) => button.text.includes("Unlink"));
		expect(unlink?.attrs).toContain('form="plan-unlink"');
		expect(unlink?.attrs).not.toContain("formaction");
		const owned = buttons.filter(
			(button) =>
				/type="submit"/.test(button.attrs) && !/\sform="/.test(button.attrs),
		);
		expect(owned[0]?.text).toContain("Save");

		const unlinkForm =
			html.match(/<form[^>]*id="plan-unlink"[^>]*>/)?.[0] ?? "";
		expect(unlinkForm).toContain(`action="/plans/${id}/unlink"`);
		expect(unlinkForm).toContain(`hx-post="/plans/${id}/unlink"`);
		// The unlink form comes after the edit form's close, not inside it.
		expect(html.indexOf('id="plan-unlink"')).toBeGreaterThan(
			html.indexOf("</form>", html.indexOf(`action="/plans/${id}"`)),
		);
	});

	it("totals Paid this month with the plans it lists, as the bills' paid total does", async () => {
		await plan("Car registration", 18000, MONTH, await payment(9740, 18000));
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();
		const billData = await loadBillRows(env.DB, TODAY);
		const bills = billTotalsForRows(
			MONTH,
			billData.rows.filter((bill) => bill.active),
		).groups.paidCents;
		const total = html.match(
			/>Paid this month<\/h2>[\s\S]*?<span class="ml-auto shrink-0">([^<]*)<\/span>/,
		)?.[1];
		expect(total).toBe(formatCents(bills + 18000));
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

	it("links a payment from the plan's page, and says which bill or plan a payment that can't be linked already pays", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		await payment(9706, 18000);
		const ok = await post(`/plans/${id}/link`, { transaction_id: "9706" });
		expect(ok.headers.get("HX-Trigger")).toContain("Payment linked");
		// Decision 101: linking stays on the plan's page, which now shows the plan paid, not Bills.
		const linkedPage = await ok.text();
		expect(linkedPage).toContain("Paid by");
		expect(linkedPage).toContain("Car registration");
		expect(linkedPage).not.toContain("Add a bill");

		// 9706 now pays Car registration, so a second plan can't take it: the picker never lists it, and a forced link says why.
		const other = await plan("Lawn service", 9000, MONTH);
		const refused = await post(`/plans/${other}/link`, {
			transaction_id: "9706",
		});
		expect(await refused.text()).toContain(
			"That payment already pays a planned expense.",
		);
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
		expect(await billed.text()).toContain("That payment already pays a bill.");
	});

	it("unlinks from the plan's own page, which answers with that page, unpaid, and says Payment unlinked", async () => {
		const id = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9753, 18000),
		);
		const page = await post(`/plans/${id}/unlink`, { from: "plan" });
		expect(page.headers.get("HX-Trigger")).toContain("Payment unlinked");
		const html = await page.text();
		expect(html).toContain('<h1 class="font-serif text-5xl');
		expect(html).toContain("Link a payment");
		expect(html).not.toContain("Paid by");

		const plain = await exports.default.fetch(`${BASE}/plans/${id}/unlink`, {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ from: "plan" }),
		});
		expect(plain.status).toBe(303);
		expect(plain.headers.get("location")).toBe(`/plans/${id}`);
	});

	it("unlinks from the paid sheet, which answers with Bills and the sheet open, now unpaid", async () => {
		const id = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9754, 18000),
		);
		const sheet = await post(`/plans/${id}/unlink`, {});
		expect(sheet.headers.get("HX-Trigger")).toContain("Payment unlinked");
		const html = await sheet.text();
		expect(html).toContain('id="plan-sheet-title"');
		expect(html).not.toContain("Paid by");
		expect(html).toContain('id="page"');

		const plain = await exports.default.fetch(`${BASE}/plans/${id}/unlink`, {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({}),
		});
		expect(plain.headers.get("location")).toBe("/bills");
	});

	it("restores a plan unpaid, and returns its name, when a bill took its payment during the Undo window", async () => {
		const tx = await payment(9755, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const now = Date.now();
		const token = await holdPlanDelete(env.DB, id, now);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9755, 'Club', 1800, 1, 'monthly', 1, 'CLUB')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9755, ?, ?, 'user', 'linked')",
			).bind(MONTH, tx),
		]);
		expect(await restorePlanDelete(env.DB, token ?? "", now)).toEqual({
			name: "Car registration",
			unlinked: true,
		});
		const restored = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE name='Car registration'",
		).first<{ t: number | null }>();
		expect(restored?.t).toBeNull();
	});

	it("restores a plan with its payment, unlinked: false, when nothing took the payment", async () => {
		const tx = await payment(9758, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const now = Date.now();
		const token = await holdPlanDelete(env.DB, id, now);
		expect(await restorePlanDelete(env.DB, token ?? "", now)).toEqual({
			name: "Car registration",
			unlinked: false,
		});
	});

	it("an Undo that brings a plan back unpaid says so in its toast and announcement", async () => {
		const tx = await payment(9770, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9771, 'Club', 1800, 1, 'monthly', 1, 'CLUB')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9771, ?, ?, 'user', 'linked')",
			).bind(MONTH, tx),
		]);
		const restored = await post("/plans/undo-delete", { token });
		const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
		const words = "Restored Car registration. Its payment is no longer linked.";
		expect(trigger.toast.message).toBe(words);
		expect(trigger.announce).toBe(words);
	});

	it("an Undo that keeps a plan's payment says only Restored, with no payment line", async () => {
		const tx = await payment(9772, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		const restored = await post("/plans/undo-delete", { token });
		const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast.message).toBe("Restored Car registration.");
		expect(trigger.announce).toBe("Restored Car registration.");
	});
});

describe("a plan pays a part of a split payment, as a bill does", () => {
	// A $300 payment split into a $120 and a $180 part, with no bill or plan on it yet.
	async function splitUnclaimedPayment() {
		const tx = await payment(9790, 30000);
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		const part = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id LIMIT 1",
		)
			.bind(tx)
			.first<{ id: number }>();
		return part?.id ?? 0;
	}

	it("the picker lists a part of a split payment, and a link to one is kept", async () => {
		const part = await splitUnclaimedPayment();
		const planId = await plan("Lawn service", 12000, MONTH);
		const picker = await (
			await exports.default.fetch(`${BASE}/plans/${planId}`)
		).text();
		expect(picker).toContain(`value="${part}"`);

		await post(`/plans/${planId}/link`, { transaction_id: String(part) });
		const linked = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
		)
			.bind(planId)
			.first<{ t: number | null }>();
		expect(linked?.t).toBe(part);
	});

	it("a re-split keeps a plan on the whole payment it pays, so it stays paid", async () => {
		const tx = await payment(9795, 30000);
		const planId = await plan("Car registration", 18000, MONTH, tx);
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 10000 },
				{ categoryId: 1, amountCents: 20000 },
			],
			"demo",
		);
		const kept = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
		)
			.bind(planId)
			.first<{ t: number | null }>();
		expect(kept?.t).toBe(tx);
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(0);
	});
});

describe("a split keeps a plan and a bill on parts, and Undo or Remove split leaves neither unpaid", () => {
	const splitInTwo = (tx: number, first: number, second: number) =>
		saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: first },
				{ categoryId: 1, amountCents: second },
			],
			"demo",
		);

	async function partIds(tx: number) {
		const { results } = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id",
		)
			.bind(tx)
			.all<{ id: number }>();
		return results.map((row) => row.id);
	}

	async function insertBill(id: number, name: string, amountCents: number) {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,?,?,3,'monthly',?)",
		)
			.bind(id, name, amountCents, `${name.toUpperCase()} FIXTURE`)
			.run();
	}

	async function linkBill(billId: number, transactionId: number) {
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','linked')",
		)
			.bind(billId, MONTH, transactionId)
			.run();
	}

	const paidBy = async (planId: number) =>
		(
			await env.DB.prepare(
				"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
			)
				.bind(planId)
				.first<{ t: number | null }>()
		)?.t ?? null;

	it("a re-split moves a plan on a part to the first part no bill took, so it stays paid", async () => {
		const tx = await payment(9800, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		await insertBill(9801, "Water", 12000);
		await linkBill(9801, first ?? 0);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);

		await splitInTwo(tx, 12000, 18000);
		const [newFirst, newSecond] = await partIds(tx);
		const bill = await env.DB.prepare(
			"SELECT transaction_id AS t FROM bill_payments WHERE bill_id = 9801 AND status = 'linked'",
		).first<{ t: number }>();
		// The bill keeps the part that matches its amount and category; the plan takes the next free part.
		expect(bill?.t).toBe(newFirst);
		expect(await paidBy(planId)).toBe(newSecond);
	});

	it("a re-split with new amounts keeps a plan on a part on the first part, still paid", async () => {
		const tx = await payment(9805, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);

		await splitInTwo(tx, 10000, 20000);
		const [newFirst] = await partIds(tx);
		expect(await paidBy(planId)).toBe(newFirst);
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(0);
	});

	it("Remove split puts a plan on a part back on the whole payment, still paid", async () => {
		const tx = await payment(9808, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);

		await removeSplit(env.DB, tx, "demo");
		expect(await paidBy(planId)).toBe(tx);
	});

	it("Remove split with a plan on each part resolves: one plan takes the whole payment, and the other is unlinked", async () => {
		const tx = await payment(9812, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		const one = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const two = await plan("Car registration", 18000, MONTH, second ?? 0);

		await expect(removeSplit(env.DB, tx, "demo")).resolves.toBeDefined();
		const payers = [await paidBy(one), await paidBy(two)];
		expect(payers.filter((t) => t === tx)).toHaveLength(1);
		expect(payers).toContain(null);
	});

	it("an Undo after a split with a bill on a part brings the plan back unpaid, never on the bill's money", async () => {
		const tx = await payment(9810, 30000);
		const planId = await plan("Car registration", 18000, MONTH, tx);
		const deleted = await post(`/plans/${planId}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		await splitInTwo(tx, 12000, 18000);
		const [first] = await partIds(tx);
		await insertBill(9811, "Water", 12000);
		await linkBill(9811, first ?? 0);

		const restored = await post("/plans/undo-delete", { token });
		const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast.message).toBe(
			"Restored Car registration. Its payment is no longer linked.",
		);
		const back = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE name = 'Car registration'",
		).first<{ t: number | null }>();
		expect(back?.t).toBeNull();
	});

	it("the database refuses a plan on a whole payment while a bill pays one of its parts", async () => {
		const tx = await payment(9815, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first] = await partIds(tx);
		await insertBill(9816, "Water", 12000);
		await linkBill(9816, first ?? 0);
		await expect(
			env.DB.prepare(
				"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Lawn service',9000,?,?,'demo')",
			)
				.bind(MONTH, tx)
				.run(),
		).rejects.toThrow("already pays a bill");
	});

	it("the database refuses a bill on a whole payment while a plan pays one of its parts", async () => {
		const tx = await payment(9818, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first] = await partIds(tx);
		await plan("Lawn service", 9000, MONTH, first ?? 0);
		await insertBill(9819, "Water", 12000);
		await expect(
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9819,?,?,'user','linked')",
			)
				.bind(MONTH, tx)
				.run(),
		).rejects.toThrow("already pays a planned expense");
	});

	it("a bill's link that loses a race to a plan's link is refused in its field, not as a failed request", async () => {
		const tx = await payment(9820, 18000);
		await insertBill(9821, "Registration fee", 18000);
		// The plan's link lands after the link's check and before its batch, and the migration's trigger then refuses the
		// bill's payment. The stand-in trigger raises the migration's own message, which the test reads from the schema, so
		// the route's catch and the words it shows stay tied to the real trigger.
		const live = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'bill_payment_not_a_planned_expense'",
		).first<{ sql: string }>();
		const message = /RAISE\(ABORT, '([^']+)'\)/.exec(live?.sql ?? "")?.[1];
		expect(message).toBe("That payment already pays a planned expense.");
		await env.DB.prepare(
			`CREATE TRIGGER race_plan_link BEFORE INSERT ON bill_payments WHEN NEW.transaction_id = 9820 BEGIN SELECT RAISE(ABORT, '${message}'); END`,
		).run();
		try {
			const refused = await post("/bills/9821/link", {
				transaction_id: String(tx),
				period: MONTH,
				opened_period: MONTH,
			});
			expect(refused.status).toBe(200);
			expect(await refused.text()).toContain(
				"That payment already pays a planned expense.",
			);
		} finally {
			await env.DB.prepare("DROP TRIGGER race_plan_link").run();
		}
	});
});

describe("a bill can't take a payment a plan pays", () => {
	// A $300 payment pays a $180 plan. Splitting it keeps the plan on the payment (decision 82: a split part counts as its
	// parent's payment), so the parts are not free to pay a bill, by hand, in the picker, through the matcher or in the DB.
	async function splitPlanPayment() {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9711,'Registration fee',12000,3,'monthly','DMV FIXTURE')",
		).run();
		const tx = await payment(9712, 30000);
		const planId = await plan("Car registration", 18000, MONTH, tx);
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		const parts = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id",
		)
			.bind(tx)
			.all<{ id: number }>();
		return { tx, planId, part: parts.results[0]?.id ?? 0 };
	}

	it("keeps the plan on the split payment, and refuses a bill's link to one of its parts", async () => {
		const { tx, planId, part } = await splitPlanPayment();
		const kept = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
		)
			.bind(planId)
			.first<{ t: number }>();
		expect(kept?.t).toBe(tx);

		const refused = await post("/bills/9711/link", {
			transaction_id: String(part),
			period: MONTH,
			opened_period: MONTH,
		});
		expect(await refused.text()).toContain("already pays a planned expense");
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=?",
		)
			.bind(part)
			.first<{ n: number }>();
		expect(linked?.n).toBe(0);
	});

	it("the database refuses a bill payment on a part of a payment a plan pays", async () => {
		const { part } = await splitPlanPayment();
		await expect(
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9711,?,?,'user','linked')",
			)
				.bind(MONTH, part)
				.run(),
		).rejects.toThrow("already pays a planned expense");
	});

	it("the database refuses a plan on a part of a payment a bill pays", async () => {
		const tx = await payment(9713, 30000);
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9714,'Gym',12000,3,'monthly','GYM FIXTURE')",
		).run();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9714,?,?,'user','linked')",
		)
			.bind(MONTH, tx)
			.run();
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		const part = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id DESC LIMIT 1",
		)
			.bind(tx)
			.first<{ id: number }>();
		// The bill is linked to the whole payment, which the split leaves on its parent (paysBillSql), so every part is paid.
		await expect(
			env.DB.prepare(
				"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES('Lawn service',9000,?,?,'demo')",
			)
				.bind(MONTH, part?.id ?? 0)
				.run(),
		).rejects.toThrow("already pays a bill");
	});

	it("refuses a plan's link by hand to a part of a payment a bill pays", async () => {
		const tx = await payment(9715, 30000);
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9716,'Gym',12000,3,'monthly','GYM FIXTURE')",
		).run();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9716,?,?,'user','linked')",
		)
			.bind(MONTH, tx)
			.run();
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		const part = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id LIMIT 1",
		)
			.bind(tx)
			.first<{ id: number }>();
		const planId = await plan("Lawn service", 9000, MONTH);
		const refused = await post(`/plans/${planId}/link`, {
			transaction_id: String(part?.id ?? 0),
		});
		expect(await refused.text()).toContain("That payment already pays a bill.");
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE transaction_id IS NOT NULL",
		).first<{ n: number }>();
		expect(linked?.n).toBe(0);
	});

	it("the bill matcher and the picker skip a part of a payment a plan pays", async () => {
		const { part } = await splitPlanPayment();
		await matchBillPayments(env.DB, TODAY);
		const matched = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=?",
		)
			.bind(part)
			.first<{ n: number }>();
		expect(matched?.n).toBe(0);

		// Another plan's picker never lists the part either, and linking it there is refused.
		const other = await plan("Lawn service", 12000, MONTH);
		const picker = await (
			await exports.default.fetch(`${BASE}/plans/${other}`)
		).text();
		expect(picker).not.toContain(`value="${part}"`);
		const refused = await post(`/plans/${other}/link`, {
			transaction_id: String(part),
		});
		expect(await refused.text()).toContain(
			"That payment already pays a planned expense.",
		);
	});

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

describe("a payment that pays a planned expense, on its own page and in the lists", () => {
	it("says in the edit panel that an excluded payment counts while it pays a planned expense", async () => {
		const tx = await payment(9760, 18000, 1);
		await plan("Car registration", 18000, MONTH, tx);
		const html = await (
			await exports.default.fetch(`${BASE}/transactions/${tx}`)
		).text();
		expect(html).toContain(
			"It pays a planned expense, so it counts in the budget.",
		);
	});

	it("says in the save toast that an excluded payment still counts while it pays a planned expense", async () => {
		const tx = await payment(9765, 18000);
		await plan("Car registration", 18000, MONTH, tx);
		const saved = await exports.default.fetch(`${BASE}/transactions/${tx}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				excluded: "1",
				note: "",
				back: "/transactions",
			}),
		});
		const trigger = JSON.parse(saved.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.announce).toContain(
			"It still counts while it pays a planned expense.",
		);
	});

	it("names the plan on its payment's row: paid Car registration", async () => {
		const tx = await payment(9761, 18000);
		// The list shows 25 rows, newest first, so the payment is dated today to sit on the first page.
		await env.DB.prepare("UPDATE transactions SET date = ? WHERE id = ?")
			.bind(TODAY, tx)
			.run();
		await plan("Car registration", 18000, MONTH, tx);
		const html = await (
			await exports.default.fetch(`${BASE}/transactions`)
		).text();
		expect(html).toContain("paid Car registration");
	});

	it("holds nothing when the plan to delete is already gone", async () => {
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_delete_holds",
		).first<{ n: number }>();
		expect(await holdPlanDelete(env.DB, 987654)).toBeNull();
		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_delete_holds",
		).first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
	});
});

describe("excluding a payment that a bill or a plan pays", () => {
	const exclude = (ids: number[]) =>
		exports.default.fetch(`${BASE}/transactions/select/exclude`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams([
				...ids.map((id) => ["ids", String(id)] as [string, string]),
				["back", "/transactions"],
			]),
		});

	const announced = async (ids: number[]) => {
		const trigger = JSON.parse(
			(await exclude(ids)).headers.get("HX-Trigger") ?? "{}",
		);
		expect(trigger.toast.message).toBe(trigger.announce);
		return trigger.announce as string;
	};

	it("says a plan's payment still counts, and counts bills and plans together in one sentence", async () => {
		const billPaid = await payment(9770, 1200);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, category_id, merchant_raw_name) VALUES (9770, 'Club', 1200, 1, 'monthly', 1, 'CLUB')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9770, ?, ?, 'user', 'linked')",
			).bind(MONTH, billPaid),
		]);
		const planPaid = await payment(9771, 18000);
		await plan("Car registration", 18000, MONTH, planPaid);
		const unlinked = await payment(9772, 500);

		expect(await announced([planPaid])).toBe(
			"Excluded 1 transaction. It still counts while it pays a planned expense.",
		);
		expect(await announced([billPaid, planPaid])).toBe(
			"Excluded 2 transactions. 2 still count while they pay a bill or a planned expense.",
		);
		// The unlinked payment is excluded but doesn't count toward the sentence.
		expect(await announced([billPaid, planPaid, unlinked])).toBe(
			"Excluded 3 transactions. 2 still count while they pay a bill or a planned expense.",
		);
	});
});
