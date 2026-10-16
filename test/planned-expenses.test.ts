import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	linkPlanPayment,
	PLAN_UNDO_MS,
	plansSetAsideCents,
	restorePlanDelete,
} from "../src/db/planned-expenses";
import { removeSplit, saveEdit, saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { loadBillRows } from "../src/routes/bills";
import { splitRefusedError } from "../src/routes/transactions";
import { tidyName } from "../src/transactions/tidy-name";

const BASE = "http://tally.test";
const post = (path: string, form: Record<string, string>, htmx = true) =>
	exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			...(htmx ? { "HX-Request": "true" } : {}),
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

/** A bank payment (money out) in the current month, or in `month`, with a fixed id, plus the plan that may pay it. */
async function payment(
	id: number,
	amountCents: number,
	excluded = 0,
	month = MONTH,
) {
	await env.DB.prepare(
		"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded) SELECT ?,id,?,?,'DMV FIXTURE',? FROM accounts WHERE type!='cash' LIMIT 1",
	)
		.bind(id, dateIn(month), amountCents, excluded)
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

	it("the bill matcher's write skips a payment a plan takes after its read, so the run doesn't abort", async () => {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9708,'Registration bill',18000,3,'monthly','DMV FIXTURE')",
		).run();
		await payment(9707, 18000);
		// A plan takes the payment between the matcher's read and its write: the write's guard leaves it out.
		let raced = false;
		const db = {
			prepare: (query: string) => {
				const statement = env.DB.prepare(query);
				if (!query.startsWith("INSERT OR IGNORE INTO bill_payments"))
					return statement;
				return {
					bind: (...values: unknown[]) => ({
						run: async () => {
							raced = true;
							await plan("Car registration", 18000, MONTH, 9707);
							return statement.bind(...values).run();
						},
					}),
				} as unknown as D1PreparedStatement;
			},
		} as unknown as D1Database;
		expect(await matchBillPayments(db, TODAY)).toBe(0);
		expect(raced).toBe(true);
		const linked = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=9707 AND status='linked'",
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
		// Opened from the plan's page, so its sheet's close can name that page (opener=plan).
		expect(html).toMatch(
			new RegExp(
				`<a\\b(?=[^>]*hx-get="/plans/${id}/edit\\?opener=plan")(?=[^>]*hx-target="#sheet")[^>]*>\\s*Edit planned expense\\s*</a>`,
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

	it("unlinks a paid plan from its sheet opened on the plan's own page, which answers with that page under the sheet, now unpaid", async () => {
		const id = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9756, 18000),
		);
		const sheet = await post(`/plans/${id}/unlink`, { opener: "plan" });
		expect(sheet.headers.get("HX-Trigger")).toContain("Payment unlinked");
		const html = await sheet.text();
		expect(html).toContain('id="plan-sheet-title"');
		expect(html).not.toContain("Paid by");
		expect(html).toContain('id="edit-plan"');
		expect(html).toContain("Link a payment");
		expect(html).not.toContain('id="plan-expense"');
	});

	it("offers this month and the next eleven, plus only the plan's own earlier month, on a new plan's and an edit's Month", async () => {
		const own = monthsBefore(MONTH, 6);
		const id = await plan("Car registration", 18000, own);
		const offeredBy = async (path: string) => {
			const html = await (await exports.default.fetch(BASE + path)).text();
			const select =
				html.match(/<select id="plan-month"[\s\S]*?<\/select>/)?.[0] ?? "";
			return [...select.matchAll(/<option value="([^"]*)"/g)].map(
				(match) => match[1],
			);
		};
		const thisAndNext = Array.from({ length: 12 }, (_, i) =>
			monthsBefore(MONTH, -i),
		);
		expect(await offeredBy(`/plans/${id}/edit`)).toEqual([own, ...thisAndNext]);
		expect(await offeredBy("/plans/new")).toEqual(thisAndNext);
	});

	it("refuses a plan's month in the gap between its own month and this month's next eleven, and keeps the month", async () => {
		const own = monthsBefore(MONTH, 6);
		const id = await plan("Car registration", 18000, own);
		const gap = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: monthsBefore(MONTH, 3),
		});
		expect(await gap.text()).toContain("Choose a month.");
		const row = await env.DB.prepare(
			"SELECT month FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ month: string }>();
		expect(row?.month).toBe(own);
	});

	it("saves a plan in its own earlier month", async () => {
		const own = monthsBefore(MONTH, 6);
		const id = await plan("Car registration", 18000, own);
		const kept = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: own,
		});
		expect(kept.headers.get("HX-Trigger")).toContain("Saved Car registration.");
	});

	it("refuses an amount too large to store, for a new plan and an edit, and keeps the plan's amount", async () => {
		const huge = await post("/plans", {
			name: "Big plan",
			amount: "99999999999999999999",
			month: MONTH,
		});
		expect(await huge.text()).toContain(
			"Enter a smaller amount in dollars and cents.",
		);
		const created = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE name='Big plan'",
		).first<{ n: number }>();
		expect(created?.n).toBe(0);

		const id = await plan("Car registration", 18000, MONTH);
		for (const amount of ["99999999999999999999", `1${"0".repeat(400)}`]) {
			const edited = await post(`/plans/${id}`, {
				name: "Car registration",
				amount,
				month: MONTH,
			});
			expect(edited.status).toBe(200);
			expect(await edited.text()).toContain(
				"Enter a smaller amount in dollars and cents.",
			);
		}
		const row = await env.DB.prepare(
			"SELECT amount_cents AS a FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ a: number }>();
		expect(row?.a).toBe(18000);
	});

	it("refuses a plan name over 80 characters on create, and keeps the name on an edit", async () => {
		const created = await post("/plans", {
			name: "N".repeat(81),
			amount: "180",
			month: MONTH,
		});
		expect(await created.text()).toContain(
			"Keep the name under 80 characters.",
		);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE name=?",
		)
			.bind("N".repeat(81))
			.first<{ n: number }>();
		expect(count?.n).toBe(0);

		const id = await plan("Car registration", 18000, MONTH);
		const edited = await post(`/plans/${id}`, {
			name: "E".repeat(81),
			amount: "180",
			month: MONTH,
		});
		expect(await edited.text()).toContain("Keep the name under 80 characters.");
		const row = await env.DB.prepare(
			"SELECT name FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ name: string }>();
		expect(row?.name).toBe("Car registration");
	});

	it("saves a plan name of exactly 80 characters, on create and on edit", async () => {
		const created = await post("/plans", {
			name: "N".repeat(80),
			amount: "180",
			month: MONTH,
		});
		expect(created.headers.get("HX-Trigger")).toContain("Planned ");
		const id = await plan("Car registration", 18000, MONTH);
		const edited = await post(`/plans/${id}`, {
			name: "E".repeat(80),
			amount: "180",
			month: MONTH,
		});
		expect(edited.headers.get("HX-Trigger")).toContain("Saved ");
		const row = await env.DB.prepare(
			"SELECT name FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ name: string }>();
		expect(row?.name).toBe("E".repeat(80));
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

	it("keeps a plan's name ASCII-only in the HX-Trigger header, and the toast decodes it to the same words", async () => {
		const ok = await post("/plans", {
			name: "Mom’s car",
			amount: "$10.00",
			month: MONTH,
		});
		const header = ok.headers.get("HX-Trigger") ?? "";
		expect(header).not.toMatch(/[^\x20-\x7e]/);
		const trigger = JSON.parse(header) as { toast: { message: string } };
		expect(trigger.toast.message).toBe("Planned Mom’s car, $10.00.");
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

	it("without JavaScript, a payment that already pays a planned expense gets the refusal page with its reason in a role=alert, and no link", async () => {
		const other = await plan("Lawn service", 9000, MONTH);
		await payment(9720, 9000);
		await plan("Car registration", 9000, MONTH, 9720);
		const refused = await post(
			`/plans/${other}/link`,
			{ transaction_id: "9720" },
			false,
		);
		expect(refused.status).toBe(200);
		expect(refused.headers.get("Location")).toBeNull();
		expect(await refused.text()).toMatch(
			/role="alert"[^>]*>That payment already pays a planned expense\./,
		);
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE id=?",
		)
			.bind(other)
			.first<{ transaction_id: number | null }>();
		expect(row?.transaction_id).toBeNull();
	});

	it("without JavaScript, a payment that already pays a bill gets the refusal page with its reason in a role=alert, and no link", async () => {
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9721,'Gym',9000,3,'monthly','GYM FIXTURE')",
		).run();
		await payment(9722, 9000);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9721,?,9722,'user','linked')",
		)
			.bind(MONTH)
			.run();
		const other = await plan("Lawn service", 9000, MONTH);
		const refused = await post(
			`/plans/${other}/link`,
			{ transaction_id: "9722" },
			false,
		);
		expect(refused.status).toBe(200);
		expect(refused.headers.get("Location")).toBeNull();
		expect(await refused.text()).toMatch(
			/role="alert"[^>]*>That payment already pays a bill\./,
		);
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE id=?",
		)
			.bind(other)
			.first<{ transaction_id: number | null }>();
		expect(row?.transaction_id).toBeNull();
	});

	it("a link sent after the plan is paid says why on its paid page, with and without JavaScript, and links nothing", async () => {
		const paidBy = await payment(9724, 18000);
		const id = await plan("Car registration", 18000, MONTH, paidBy);
		await payment(9725, 18000);
		// 9724 is the plan's own payment, a resubmitted form: it pays the plan, so the plan's sentence must come before the payment's.
		for (const transaction of [paidBy, 9725]) {
			for (const htmx of [true, false]) {
				const refused = await post(
					`/plans/${id}/link`,
					{ transaction_id: String(transaction) },
					htmx,
				);
				expect(refused.status).toBe(200);
				expect(refused.headers.get("Location")).toBeNull();
				const html = await refused.text();
				expect(html).toContain("Paid by");
				expect(html).toMatch(
					/role="alert"[^>]*>Car registration is already paid\./,
				);
				expect(html).not.toContain("be linked. It may already pay");
				expect(html).not.toContain("already pays a planned expense");
			}
		}
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ transaction_id: number | null }>();
		expect(row?.transaction_id).toBe(paidBy);
	});

	it("without JavaScript, a link that is made redirects back to the plan's page and writes the link", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		await payment(9723, 18000);
		const linked = await post(
			`/plans/${id}/link`,
			{ transaction_id: "9723" },
			false,
		);
		expect(linked.status).toBe(303);
		expect(linked.headers.get("Location")).toBe(`/plans/${id}`);
		const row = await env.DB.prepare(
			"SELECT transaction_id FROM planned_expenses WHERE id=?",
		)
			.bind(id)
			.first<{ transaction_id: number | null }>();
		expect(row?.transaction_id).toBe(9723);
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
		expect(html).toContain('id="plan-expense"');

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

	it("an Unlink on a plan that is already unpaid claims no unlink: no toast, and the redrawn page or sheet shows it unpaid", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const onPage = await post(`/plans/${id}/unlink`, { from: "plan" });
		expect(onPage.headers.get("HX-Trigger")).toBeNull();
		const pageHtml = await onPage.text();
		expect(pageHtml).toContain('<h1 class="font-serif text-5xl');
		expect(pageHtml).toContain("Link a payment");
		// No toast and no announcement here, so the swapped page takes focus: on its Link a payment heading.
		const linkHeading =
			pageHtml.match(/<h2\b[^>]*id="plan-link-title"[^>]*>/)?.[0] ?? "";
		expect(linkHeading).toContain('tabindex="-1"');
		expect(linkHeading).toContain("autofocus");

		const onSheet = await post(`/plans/${id}/unlink`, {});
		expect(onSheet.headers.get("HX-Trigger")).toBeNull();
		const sheetHtml = await onSheet.text();
		expect(sheetHtml).toContain('id="plan-sheet-title"');
		expect(sheetHtml).not.toContain("Paid by");
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

	it("restores a plan unpaid, unlinked: true, when its payment was deleted during the Undo window, and a reused id links nothing", async () => {
		const tx = await payment(9780, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const now = Date.now();
		const token = await holdPlanDelete(env.DB, id, now);
		await env.DB.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(tx)
			.run();
		// A new transaction takes the deleted payment's id, as SQLite can hand a freed rowid out again.
		await env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,4200,'GROCERY REUSE FIXTURE' FROM accounts WHERE type!='cash' LIMIT 1",
		)
			.bind(tx, dateIn(MONTH))
			.run();
		expect(await restorePlanDelete(env.DB, token ?? "", now)).toEqual({
			name: "Car registration",
			unlinked: true,
		});
		const restored = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE name='Car registration'",
		).first<{ t: number | null }>();
		expect(restored?.t).toBeNull();
		const paying = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM planned_expenses WHERE transaction_id = ?",
		)
			.bind(tx)
			.first<{ n: number }>();
		expect(paying?.n).toBe(0);
	});

	it("an Undo that brings back a plan whose payment was deleted says its payment is no longer linked", async () => {
		const tx = await payment(9781, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		await env.DB.prepare("DELETE FROM transactions WHERE id = ?")
			.bind(tx)
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,4200,'GROCERY REUSE FIXTURE' FROM accounts WHERE type!='cash' LIMIT 1",
		)
			.bind(tx, dateIn(MONTH))
			.run();
		const restored = await post("/plans/undo-delete", { token });
		const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
		const words = "Restored Car registration. Its payment is no longer linked.";
		expect(trigger.toast.message).toBe(words);
		expect(trigger.announce).toBe(words);
	});

	it.each([
		{
			change: "became a credit",
			paymentId: 9782,
			apply: (id: number) =>
				env.DB.prepare(
					"UPDATE transactions SET amount_cents = -18000 WHERE id = ?",
				)
					.bind(id)
					.run(),
		},
		{
			change: "was marked income",
			paymentId: 9783,
			apply: (id: number) =>
				env.DB.prepare("UPDATE transactions SET flag_income = 1 WHERE id = ?")
					.bind(id)
					.run(),
		},
		{
			change: "moved outside the plan's month and the next",
			paymentId: 9784,
			apply: (id: number) =>
				env.DB.prepare("UPDATE transactions SET date = ? WHERE id = ?")
					.bind(dateIn(LAST_MONTH), id)
					.run(),
		},
	])(
		"an Undo whose plan's payment $change restores the plan unpaid and set aside again",
		async ({ paymentId, apply }) => {
			const tx = await payment(paymentId, 18000);
			const id = await plan("Car registration", 18000, MONTH, tx);
			const deleted = await post(`/plans/${id}/delete`, {});
			const token = (
				JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
					toast: { undo: string };
				}
			).toast.undo;
			await apply(tx);
			const restored = await post("/plans/undo-delete", { token });
			const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
			const words =
				"Restored Car registration. Its payment is no longer linked.";
			expect(trigger.toast.message).toBe(words);
			expect(trigger.announce).toBe(words);
			const row = await env.DB.prepare(
				"SELECT transaction_id AS t FROM planned_expenses WHERE name='Car registration'",
			).first<{ t: number | null }>();
			expect(row?.t).toBeNull();
			expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000);
		},
	);

	it("an Undo after the plan's payment was split brings the plan back on the whole payment, as a split keeps it", async () => {
		const tx = await payment(9785, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const deleted = await post(`/plans/${id}/delete`, {});
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 8000 },
				{ categoryId: 1, amountCents: 10000 },
			],
			"demo",
		);
		const restored = await post("/plans/undo-delete", { token });
		const trigger = JSON.parse(restored.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast.message).toBe("Restored Car registration.");
		expect(trigger.announce).toBe("Restored Car registration.");
		const row = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE name='Car registration'",
		).first<{ t: number | null }>();
		expect(row?.t).toBe(tx);
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(0);
	});
});

describe("editing a paid plan's month keeps its payment only while the payment can still pay that month (#202)", () => {
	const words = "Saved Car registration. Its payment is no longer linked.";
	const edit = (
		id: number,
		month: string,
		{ name = "Car registration", amount = "180", opener = false } = {},
	) =>
		post(`/plans/${id}`, {
			name,
			amount,
			month,
			...(opener ? { opener: "plan" } : {}),
		});
	const trigger = async (res: Response) =>
		JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
			toast: { message: string };
			announce: string;
		};
	const linkOf = async (id: number) =>
		(
			await env.DB.prepare(
				"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
			)
				.bind(id)
				.first<{ t: number | null }>()
		)?.t ?? null;

	it("a name-only or amount-only edit of a paid plan keeps its payment and says nothing about the link", async () => {
		const tx = await payment(9960, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const renamed = await edit(id, MONTH, { name: "Car registration" });
		expect((await trigger(renamed)).toast.message).toBe(
			"Saved Car registration.",
		);
		expect(await linkOf(id)).toBe(tx);
		const repriced = await edit(id, MONTH, { amount: "200" });
		expect((await trigger(repriced)).toast.message).toBe(
			"Saved Car registration.",
		);
		expect(await linkOf(id)).toBe(tx);
	});

	it("moving a paid plan to a month its payment still falls in keeps the payment", async () => {
		const next = monthsBefore(MONTH, -1);
		const tx = await payment(9961, 18000, 0, next);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const moved = await edit(id, next);
		expect((await trigger(moved)).toast.message).toBe(
			"Saved Car registration.",
		);
		expect(await linkOf(id)).toBe(tx);
	});

	it("moving a paid plan past its payment's month unlinks the payment and says so, on Bills and on the plan's page", async () => {
		const far = monthsBefore(MONTH, -11);
		const onBills = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9962, 18000),
		);
		const onPage = await plan(
			"Car registration",
			18000,
			MONTH,
			await payment(9963, 18000),
		);
		const fromBills = await trigger(await edit(onBills, far));
		expect(fromBills.toast.message).toBe(words);
		expect(fromBills.announce).toBe(words);
		const fromPage = await trigger(await edit(onPage, far, { opener: true }));
		expect(fromPage.toast.message).toBe(words);
		expect(fromPage.announce).toBe(words);
		expect(await linkOf(onBills)).toBeNull();
		expect(await linkOf(onPage)).toBeNull();
		expect(await plansSetAsideCents(env.DB, far)).toBe(36000);
	});

	it("moving a paid plan to the next month unlinks a payment from this month, which that month's window no longer takes", async () => {
		const next = monthsBefore(MONTH, -1);
		const tx = await payment(9964, 18000);
		const id = await plan("Car registration", 18000, MONTH, tx);
		const moved = await edit(id, next);
		expect((await trigger(moved)).toast.message).toBe(words);
		expect(await linkOf(id)).toBeNull();
	});

	it("an edit of an unpaid plan's month never says its link is gone", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const moved = await edit(id, monthsBefore(MONTH, -1));
		expect((await trigger(moved)).toast.message).toBe(
			"Saved Car registration.",
		);
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

	it("a bill on part 1 leaves part 2 to a plan: the picker lists part 2 and not part 1, and a link to part 2 is kept", async () => {
		const tx = await payment(9821, 30000);
		await saveSplit(
			env.DB,
			tx,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
		const { results } = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id",
		)
			.bind(tx)
			.all<{ id: number }>();
		const [part1, part2] = results.map((row) => row.id);
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9822,'Water',12000,3,'monthly','WATER FIXTURE')",
		).run();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9822,?,?,'user','linked')",
		)
			.bind(MONTH, part1)
			.run();
		const planId = await plan("Lawn service", 18000, MONTH);
		const picker = await (
			await exports.default.fetch(`${BASE}/plans/${planId}`)
		).text();
		expect(picker).toContain(`value="${part2}"`);
		expect(picker).not.toContain(`value="${part1}"`);

		await post(`/plans/${planId}/link`, { transaction_id: String(part2) });
		const linked = await env.DB.prepare(
			"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
		)
			.bind(planId)
			.first<{ t: number | null }>();
		expect(linked?.t).toBe(part2);
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

	describe("a plan paid by the whole of a payment that is later split stays on the whole payment (Codex 4279039340)", () => {
		// A $300 payment the plan pays whole, then split into a $120 and a $180 part.
		async function splitPaidPlan(paymentId: number) {
			const tx = await payment(paymentId, 30000);
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
			return { tx, planId };
		}
		const editPlan = (
			planId: number,
			fields: { name?: string; amount?: string },
		) =>
			post(`/plans/${planId}`, {
				name: "Car registration",
				amount: "180",
				month: MONTH,
				...fields,
			});
		const planTrigger = async (res: Response) =>
			JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
				toast: { message: string };
				announce: string;
			};
		const linkOf = async (planId: number) =>
			(
				await env.DB.prepare(
					"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
				)
					.bind(planId)
					.first<{ t: number | null }>()
			)?.t ?? null;

		it("a name-only edit of the plan keeps its link to the whole payment, and says nothing about the link", async () => {
			const { tx, planId } = await splitPaidPlan(9840);
			const renamed = await planTrigger(
				await editPlan(planId, { name: "Car rego" }),
			);
			expect(renamed.toast.message).toBe("Saved Car rego.");
			expect(renamed.announce).toBe("Saved Car rego.");
			expect(await linkOf(planId)).toBe(tx);
			expect(await plansSetAsideCents(env.DB, MONTH)).toBe(0);
		});

		it("an amount-only edit of the plan keeps its link to the whole payment, and says nothing about the link", async () => {
			const { tx, planId } = await splitPaidPlan(9841);
			const repriced = await planTrigger(
				await editPlan(planId, { amount: "200" }),
			);
			expect(repriced.toast.message).toBe("Saved Car registration.");
			expect(repriced.announce).toBe("Saved Car registration.");
			expect(await linkOf(planId)).toBe(tx);
			expect(await plansSetAsideCents(env.DB, MONTH)).toBe(0);
		});

		it("an Undo of the plan's delete brings it back on the whole payment, and the toast says only that it was restored", async () => {
			const { tx, planId } = await splitPaidPlan(9842);
			const deleted = await post(`/plans/${planId}/delete`, {});
			const token = (
				JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
					toast: { undo: string };
				}
			).toast.undo;
			const restored = await planTrigger(
				await post("/plans/undo-delete", { token }),
			);
			expect(restored.toast.message).toBe("Restored Car registration.");
			expect(restored.announce).toBe("Restored Car registration.");
			const row = await env.DB.prepare(
				"SELECT transaction_id AS t FROM planned_expenses WHERE name='Car registration'",
			).first<{ t: number | null }>();
			expect(row?.t).toBe(tx);
		});

		it("a new link to the split purchase is still refused, so a plan unpaid now can't take it", async () => {
			const tx = await payment(9843, 30000);
			await saveSplit(
				env.DB,
				tx,
				[
					{ categoryId: 1, amountCents: 12000 },
					{ categoryId: 1, amountCents: 18000 },
				],
				"demo",
			);
			const planId = await plan("Lawn service", 30000, MONTH);
			const refused = await post(`/plans/${planId}/link`, {
				transaction_id: String(tx),
			});
			expect(await refused.text()).toContain(
				"It may already pay a bill or a planned expense.",
			);
			expect(await linkOf(planId)).toBeNull();
			expect(await linkPlanPayment(env.DB, planId, tx)).toBe(false);
		});
	});
});

describe("a split keeps a plan on a part only as it keeps a bill's payment (decision 99)", () => {
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

	it("a re-split with no part of the plan's amount unlinks it and sets it aside, as a bill's payment is unlinked", async () => {
		const tx = await payment(9805, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);

		await splitInTwo(tx, 10000, 20000);
		expect(await paidBy(planId)).toBeNull();
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000);
	});

	it("a re-split keeps two plans of one amount each on a part of that amount, one part apiece", async () => {
		const tx = await payment(9816, 36000);
		await splitInTwo(tx, 18000, 18000);
		const [first, second] = await partIds(tx);
		const one = await plan("Lawn service", 18000, MONTH, first ?? 0);
		const two = await plan("Car registration", 18000, MONTH, second ?? 0);

		await splitInTwo(tx, 18000, 18000);
		const [newFirst, newSecond] = await partIds(tx);
		expect(await paidBy(one)).toBe(newFirst);
		expect(await paidBy(two)).toBe(newSecond);
	});

	/** A database whose `batch` is `around` instead of the real one, so a test can race the save's batch. */
	const batchAround = (
		around: (statements: D1PreparedStatement[]) => Promise<D1Result[]>,
	) =>
		new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch") return around;
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as unknown as D1Database;

	/** Runs `race` on the database just before the save's batch, as a competing save would, so the save reads first. */
	const racingWith = (race: string, bind: (number | null)[]) =>
		batchAround(async (statements) => {
			await env.DB.prepare(race)
				.bind(...bind)
				.run();
			return env.DB.batch(statements);
		});

	const KEEP_TWO = [
		{ categoryId: 1, amountCents: 12000 },
		{ categoryId: 1, amountCents: 18000 },
	];

	it("a plan that a competing save unlinks after the read stays unlinked and set aside, and the save goes through (#202)", async () => {
		const tx = await payment(9818, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = NULL WHERE id = ?",
			[planId],
		);

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(true);
		expect(await paidBy(planId)).toBeNull();
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000);
	});

	it("a plan that a competing save relinks to another payment after the read stays there (#202)", async () => {
		const tx = await payment(9820, 30000);
		const other = await payment(9821, 18000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			[other, planId],
		);

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(true);
		expect(await paidBy(planId)).toBe(other);
	});

	it("refuses a re-split when a competing save links a plan to an old part after the read, and changes nothing (Codex 4277155952)", async () => {
		const tx = await payment(9824, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const before = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			[second ?? 0, planId],
		);

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(false);
		expect(result.planLinked).toBe(true);
		// The plan keeps its old part, and no part was added or removed, so the parent wasn't re-marked either.
		expect(await paidBy(planId)).toBe(second);
		expect(await partIds(tx)).toEqual(before);
	});

	it("a re-split after that refusal keeps the plan on the new part of its amount, so it stays paid (Codex 4277155952)", async () => {
		const tx = await payment(9825, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			[second ?? 0, planId],
		);
		await saveSplit(racing, tx, KEEP_TWO, "demo");

		const retry = await saveSplit(env.DB, tx, KEEP_TWO, "demo");
		expect(retry.saved).toBe(true);
		expect(retry.planLinked).toBeUndefined();
		const [, newSecond] = await partIds(tx);
		expect(await paidBy(planId)).toBe(newSecond);
	});

	it("says a split refused because a plan was linked to a part is not an amount change (Codex 4277155952)", () => {
		expect(splitRefusedError(true)).toBe(
			"A planned expense was just linked to one of these parts. Check the parts and save again.",
		);
		expect(splitRefusedError(false)).toBe(
			"The bank just changed this amount. Check the parts and save again.",
		);
	});

	it("says a split refused because a bill payment on a part changed is not an amount change (#638)", () => {
		expect(splitRefusedError(false, true)).toBe(
			"A bill payment on one of these parts just changed. Check the parts and save again.",
		);
	});

	it("an ordinary re-split carries a plan on the first part to the new part of its amount (#573)", async () => {
		const tx = await payment(9830, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first] = await partIds(tx);
		const planId = await plan("Lawn service", 12000, MONTH, first ?? 0);

		const result = await saveSplit(env.DB, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(true);
		expect(result.planLinked).toBeUndefined();
		const [newFirst] = await partIds(tx);
		expect(await paidBy(planId)).toBe(newFirst);
	});

	it("refuses a re-split when a competing save moves a plan from one old part to another after the read, and changes nothing (#573)", async () => {
		const tx = await payment(9832, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		const planId = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const before = await partIds(tx);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			[second ?? 0, planId],
		);

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(false);
		expect(result.planLinked).toBe(true);
		// The plan stays on the part it is linked to now, never on the new 12000 part that A's pairing names.
		expect(await paidBy(planId)).toBe(second);
		expect(await partIds(tx)).toEqual(before);

		// The retry reads the plan on its part, so the plan takes the new part that follows it.
		const retry = await saveSplit(env.DB, tx, KEEP_TWO, "demo");
		expect(retry.saved).toBe(true);
		const [, newSecond] = await partIds(tx);
		expect(await paidBy(planId)).toBe(newSecond);
	});

	it("refuses a re-split when a competing save moves one plan onto the part another plan left after the read (#573)", async () => {
		const tx = await payment(9834, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		// transaction_id is unique, so the race must free the second part before the other plan takes it: the plan created
		// first is the one the race visits first.
		const onSecond = await plan("Car registration", 18000, MONTH, second ?? 0);
		const onFirst = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const before = await partIds(tx);
		const racing = racingWith(
			"UPDATE planned_expenses SET transaction_id = CASE id WHEN ?1 THEN ?2 ELSE NULL END WHERE id IN (?1, ?3)",
			[onFirst, second ?? 0, onSecond],
		);

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(false);
		expect(result.planLinked).toBe(true);
		expect(await paidBy(onFirst)).toBe(second);
		expect(await paidBy(onSecond)).toBeNull();
		expect(await partIds(tx)).toEqual(before);
	});

	it("refuses a re-split when a plan moved after the read, even if it moves again right after the failed batch (#573, Codex 4289357375)", async () => {
		const tx = await payment(9836, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		const planId = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const before = await partIds(tx);
		const movePlan = (part: number) =>
			env.DB.prepare(
				"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			)
				.bind(part, planId)
				.run();
		// The plan moves after the read and the batch fails; the plan moves back before the save looks at the failure.
		const racing = batchAround(async (statements) => {
			await movePlan(second ?? 0);
			try {
				return await env.DB.batch(statements);
			} catch (error) {
				await movePlan(first ?? 0);
				throw error;
			}
		});

		const result = await saveSplit(racing, tx, KEEP_TWO, "demo");
		expect(result.saved).toBe(false);
		expect(result.planLinked).toBe(true);
		expect(await paidBy(planId)).toBe(first);
		expect(await partIds(tx)).toEqual(before);
	});

	it("rethrows a batch failure for another reason while a plan also moved, not the planned-expense refusal (#573, Codex 4289357375)", async () => {
		const tx = await payment(9838, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		const planId = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const failure = new Error("D1_ERROR: network connection lost");
		const racing = batchAround(async () => {
			await env.DB.prepare(
				"UPDATE planned_expenses SET transaction_id = ? WHERE id = ?",
			)
				.bind(second ?? 0, planId)
				.run();
			throw failure;
		});

		await expect(saveSplit(racing, tx, KEEP_TWO, "demo")).rejects.toBe(failure);
	});

	it("Remove split unlinks a plan on a part and sets it aside, as it does a bill on a part", async () => {
		const tx = await payment(9808, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [, second] = await partIds(tx);
		const planId = await plan("Lawn service", 18000, MONTH, second ?? 0);

		await removeSplit(env.DB, tx, "demo");
		expect(await paidBy(planId)).toBeNull();
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000);
	});

	it("Remove split keeps a plan on the whole payment, which the split never held, so it stays paid", async () => {
		const tx = await payment(9814, 30000);
		const planId = await plan("Lawn service", 18000, MONTH, tx);
		await splitInTwo(tx, 12000, 18000);

		await removeSplit(env.DB, tx, "demo");
		expect(await paidBy(planId)).toBe(tx);
	});

	it("Remove split unlinks a plan on each part and sets both aside, as it does bills on parts", async () => {
		const tx = await payment(9812, 30000);
		await splitInTwo(tx, 12000, 18000);
		const [first, second] = await partIds(tx);
		const one = await plan("Lawn service", 12000, MONTH, first ?? 0);
		const two = await plan("Car registration", 18000, MONTH, second ?? 0);

		await expect(removeSplit(env.DB, tx, "demo")).resolves.toBeDefined();
		expect(await paidBy(one)).toBeNull();
		expect(await paidBy(two)).toBeNull();
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(30000);
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

describe("the plan picker lists every payment that can pay the plan", () => {
	it("lists all 25 eligible payments in the plan's month, not only the first 20", async () => {
		const planId = await plan("Car registration", 18000, MONTH);
		const ids: number[] = [];
		for (let i = 0; i < 25; i++) ids.push(await payment(9900 + i, 1000 + i));
		const picker = await (
			await exports.default.fetch(`${BASE}/plans/${planId}`)
		).text();
		for (const id of ids) expect(picker).toContain(`value="${id}"`);
	});
});

describe("a payer with no name of its own shows the bank's text, tidied, as bills do", () => {
	it("names a candidate and a linked payment by the tidied bank text, never null", async () => {
		const tidied = tidyName("DMV FIXTURE");
		const tx = await payment(9830, 18000);
		const planId = await plan("Car registration", 18000, MONTH);
		const picker = await (
			await exports.default.fetch(`${BASE}/plans/${planId}`)
		).text();
		expect(picker).toContain(`${tidied} · `);
		expect(picker).not.toContain("null");

		await post(`/plans/${planId}/link`, { transaction_id: String(tx) });
		const page = await (
			await exports.default.fetch(`${BASE}/plans/${planId}`)
		).text();
		expect(page).toContain(`Paid by ${tidied}`);
		const edit = await (
			await exports.default.fetch(`${BASE}/plans/${planId}/edit`)
		).text();
		expect(edit).toMatch(new RegExp(`Paid by</span>\\s*${tidied} · `));
		expect(edit).not.toContain("null");
	});
});

describe("a plan's answer names its address: Bills, or the plan's own page after an edit from it", () => {
	it("answers with Bills' address after a create, an edit from Bills, a delete, a drop, a move and an Undo", async () => {
		const created = await post("/plans", {
			name: "Lawn service",
			amount: "90",
			month: MONTH,
		});
		expect(created.headers.get("HX-Push-Url")).toBe("/bills");

		const id = await plan("Car registration", 18000, MONTH);
		const edited = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: MONTH,
		});
		expect(edited.headers.get("HX-Push-Url")).toBe("/bills");

		const deleted = await post(`/plans/${id}/delete`, {});
		expect(deleted.headers.get("HX-Push-Url")).toBe("/bills");
		const token = (
			JSON.parse(deleted.headers.get("HX-Trigger") ?? "{}") as {
				toast: { undo: string };
			}
		).toast.undo;
		const undone = await post("/plans/undo-delete", { token });
		expect(undone.headers.get("HX-Push-Url")).toBe("/bills");

		const dropped = await plan("Old one", 9000, LAST_MONTH);
		expect(
			(await post(`/plans/${dropped}/drop`, {})).headers.get("HX-Push-Url"),
		).toBe("/bills");
		const moved = await plan("Older one", 9000, LAST_MONTH);
		expect(
			(await post(`/plans/${moved}/move`, {})).headers.get("HX-Push-Url"),
		).toBe("/bills");
	});

	it("answers with the plan's own address after an edit from its page, and with Bills' after an edit from Bills", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const fromPage = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: MONTH,
			opener: "plan",
		});
		expect(fromPage.headers.get("HX-Push-Url")).toBe(`/plans/${id}`);
		const fromBills = await post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: MONTH,
		});
		expect(fromBills.headers.get("HX-Push-Url")).toBe("/bills");
	});
});

describe("a save whose plan is deleted mid-save says it is gone, not saved (Codex 4278749957)", () => {
	const gone = "That planned expense is already gone.";
	const save = (id: number, opener: boolean) =>
		post(`/plans/${id}`, {
			name: "Car registration",
			amount: "180",
			month: MONTH,
			...(opener ? { opener: "plan" } : {}),
		});

	it.each([
		{ origin: "the plan's own page", opener: true },
		{ origin: "Bills", opener: false },
	])(
		"a save from $origin that finds its plan gone answers with the gone toast, with no Saved and no plan address",
		async ({ opener }) => {
			const id = await plan("Car registration", 18000, MONTH);
			// Another request deletes the plan after this save read it and before the save writes it.
			const realBatch = env.DB.batch.bind(env.DB);
			const spy = vi
				.spyOn(env.DB, "batch")
				.mockImplementationOnce(async (statements) => {
					await env.DB.prepare("DELETE FROM planned_expenses WHERE id = ?")
						.bind(id)
						.run();
					return realBatch(statements);
				});
			const answer = await save(id, opener).finally(() => spy.mockRestore());

			expect(
				JSON.parse(answer.headers.get("HX-Trigger") ?? "{}").toast,
			).toEqual({ message: gone, type: "error" });
			expect(answer.headers.get("HX-Trigger")).not.toContain("Saved");
			expect(answer.headers.get("HX-Push-Url")).toBe("/bills");
			const left = await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM planned_expenses WHERE id = ?",
			)
				.bind(id)
				.first<{ n: number }>();
			expect(left?.n).toBe(0);
		},
	);
});

describe("a cash entry's date that takes its plan's payment out of the plan's month unlinks the plan (Codex 4279039333)", () => {
	const CASH_NAME = "PLAN CASH FIXTURE";
	const unlinkedWords = (name: string) =>
		`Saved ${tidyName(name)}. Its payment is no longer linked.`;
	const linkOf = async (planId: number) =>
		(
			await env.DB.prepare(
				"SELECT transaction_id AS t FROM planned_expenses WHERE id = ?",
			)
				.bind(planId)
				.first<{ t: number | null }>()
		)?.t ?? null;
	const editCash = (id: number, date: string, amount: string) =>
		post(`/transactions/${id}`, { date, amount, back: "/transactions" });
	const trigger = async (res: Promise<Response>) =>
		JSON.parse((await res).headers.get("HX-Trigger") ?? "{}") as {
			toast: { message: string };
			announce: string;
		};
	/** A cash entry in the cash account, as Add cash stores one, dated `date`. */
	async function cashEntry(amountCents: number, date: string) {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO accounts (name,type) VALUES ('Cash','cash') ON CONFLICT(type) WHERE type='cash' DO NOTHING",
			),
			env.DB.prepare(
				`INSERT INTO transactions (account_id,date,amount_cents,raw_name,category_id,category_source,flag_income,updated_by)
				SELECT id,?,?,?,1,'user',0,'demo' FROM accounts WHERE type='cash'`,
			).bind(date, amountCents, CASH_NAME),
		]);
		const row = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = ? ORDER BY id DESC LIMIT 1",
		)
			.bind(CASH_NAME)
			.first<{ id: number }>();
		return row?.id ?? 0;
	}
	const splitInTwo = (id: number) =>
		saveSplit(
			env.DB,
			id,
			[
				{ categoryId: 1, amountCents: 12000 },
				{ categoryId: 1, amountCents: 18000 },
			],
			"demo",
		);
	/** A $50 refund from the bank account, linked to the cash entry `id` (the refund a cash amount can't drop below). */
	const refundOf = (id: number, refundId: number) =>
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,refund_of_id,flag_income) SELECT ?,id,?,-5000,'REFUND FIXTURE',?,0 FROM accounts WHERE type!='cash' LIMIT 1",
		)
			.bind(refundId, dateIn(MONTH), id)
			.run();

	it("moving a cash entry's date to the month before its plan's unlinks the plan, and the save says so", async () => {
		const id = await cashEntry(18000, dateIn(MONTH));
		const planId = await plan("Car registration", 18000, MONTH, id);
		const moved = await trigger(editCash(id, dateIn(LAST_MONTH), "180"));
		expect(moved.toast.message).toBe(unlinkedWords(CASH_NAME));
		expect(moved.announce).toBe(unlinkedWords(CASH_NAME));
		expect(await linkOf(planId)).toBeNull();
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(18000);
	});

	it("moving a cash entry's date within the plan's month keeps the link, and the save says nothing about it", async () => {
		const id = await cashEntry(18000, dateIn(MONTH));
		const planId = await plan("Car registration", 18000, MONTH, id);
		const moved = await trigger(editCash(id, `${MONTH}-02`, "180"));
		expect(moved.toast.message).toBe(`Saved ${tidyName(CASH_NAME)}`);
		expect(moved.announce).toBe(`Saved ${tidyName(CASH_NAME)}.`);
		expect(await linkOf(planId)).toBe(id);
	});

	it("moving a split cash entry out of the plan's month unlinks the plan on its part, because the parts' dates follow", async () => {
		const id = await cashEntry(30000, dateIn(MONTH));
		await splitInTwo(id);
		const part = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id DESC LIMIT 1",
			)
				.bind(id)
				.first<{ id: number }>()
		)?.id as number;
		const planId = await plan("Car registration", 18000, MONTH, part);
		const moved = await trigger(editCash(id, dateIn(LAST_MONTH), "300"));
		expect(moved.toast.message).toBe(unlinkedWords(CASH_NAME));
		expect(moved.announce).toBe(unlinkedWords(CASH_NAME));
		expect(await linkOf(planId)).toBeNull();
	});

	it("a plan linked to a cash entry before the entry was split keeps its link on a move within the month, and unlinks on a move out", async () => {
		const id = await cashEntry(30000, dateIn(MONTH));
		const planId = await plan("Car registration", 18000, MONTH, id);
		await splitInTwo(id);
		const within = await trigger(editCash(id, `${MONTH}-02`, "300"));
		expect(within.toast.message).toBe(`Saved ${tidyName(CASH_NAME)}`);
		expect(await linkOf(planId)).toBe(id);
		const out = await trigger(editCash(id, dateIn(LAST_MONTH), "300"));
		expect(out.toast.message).toBe(unlinkedWords(CASH_NAME));
		expect(await linkOf(planId)).toBeNull();
	});

	it("a refused cash save, with an amount below its linked refunds, unlinks nothing", async () => {
		const id = await cashEntry(18000, dateIn(MONTH));
		const planId = await plan("Car registration", 18000, MONTH, id);
		await refundOf(id, 9850);
		const refused = await editCash(id, dateIn(LAST_MONTH), "40");
		expect(refused.status).toBe(422);
		expect(await linkOf(planId)).toBe(id);
	});

	it("a save refused by the batch's gate unlinks nothing either, though the route's own check let it through", async () => {
		const id = await cashEntry(18000, dateIn(MONTH));
		const planId = await plan("Car registration", 18000, MONTH, id);
		await refundOf(id, 9851);
		const result = await saveEdit(
			env.DB,
			id,
			{
				categoryId: null,
				alwaysForMerchant: false,
				displayName: null,
				note: null,
				excluded: false,
				income: false,
				creditReviewed: false,
				cashDate: dateIn(LAST_MONTH),
				cashAmountCents: 4000,
			},
			"demo",
		);
		expect(result).toEqual({
			saved: false,
			cashError: "refund",
			refundCents: 5000,
		});
		expect(await linkOf(planId)).toBe(id);
	});
});
