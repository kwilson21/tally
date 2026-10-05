import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BIG_BILL_CENTS } from "../src/bills/guards";
import { matchBillPayments } from "../src/bills/match";
import {
	acceptPriceOffer,
	findPriceOffer,
	loadPriceOffers,
	pickPriceOffer,
} from "../src/bills/price-change";
import { summarizeMonth } from "../src/budget";
import {
	DEFAULT_TIME_ZONE,
	daysBefore,
	householdToday,
	shortDay,
	todayIn,
} from "../src/dates";
import { loadMonth } from "../src/db/month";
import { loadBillRows } from "../src/routes/bills";

// Spec §6.1 rule 4 and §8.5 "Bill matching" (decision 67; P36 B, decision 72): an excluded payment can
// pay a bill, and a payment from the same merchant outside ±10% is offered as "Price changed?" rather
// than matched or ignored. Nothing changes until a person accepts.

const BASE = "http://tally.test";
const post = (path: string, body: Record<string, string> = {}, htmx = true) =>
	exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(body),
	});
const get = async (path: string) =>
	(await exports.default.fetch(BASE + path)).text();

describe("pickPriceOffer", () => {
	const pay = (id: number, date: string, amountCents: number) => ({
		id,
		date,
		amountCents,
	});

	it("offers a payment inside the window and outside ±10%, never one the matcher would take", () => {
		expect(
			pickPriceOffer([pay(1, "2026-10-03", 1799)], "2026-10-02", 1549)?.id,
		).toBe(1);
		// Exactly 10% either way, and 9%: the matcher's, not an offer.
		for (const cents of [1100, 900, 1090, 1000, 910])
			expect(
				pickPriceOffer([pay(1, "2026-10-03", cents)], "2026-10-02", 1000),
			).toBeUndefined();
		// One cent past 10%, in either direction.
		for (const cents of [1101, 899])
			expect(
				pickPriceOffer([pay(1, "2026-10-03", cents)], "2026-10-02", 1000)?.id,
			).toBe(1);
	});

	it("keeps to the date window, money out, and a bill amount that can be confirmed", () => {
		const offer = (p: ReturnType<typeof pay>) =>
			pickPriceOffer([p], "2026-10-10", 1000);
		expect(offer(pay(1, "2026-10-05", 1500))?.id).toBe(1);
		expect(offer(pay(1, "2026-10-15", 1500))?.id).toBe(1);
		expect(offer(pay(1, "2026-10-04", 1500))).toBeUndefined();
		expect(offer(pay(1, "2026-10-16", 1500))).toBeUndefined();
		// A refund or a credit is money in: not a price.
		expect(offer(pay(1, "2026-10-10", -1500))).toBeUndefined();
		expect(offer(pay(1, "2026-10-10", 0))).toBeUndefined();
		// Over $100,000 a bill's amount has to be confirmed in its own form (decision 72, P45 A).
		expect(offer(pay(1, "2026-10-10", BIG_BILL_CENTS))?.id).toBe(1);
		expect(offer(pay(1, "2026-10-10", BIG_BILL_CENTS + 1))).toBeUndefined();
	});

	it("picks the closest date, then the closest amount, then the earliest id", () => {
		const picked = pickPriceOffer(
			[
				pay(4, "2026-10-12", 1200),
				pay(3, "2026-10-09", 1500),
				pay(2, "2026-10-09", 1200),
				pay(1, "2026-10-09", 1200),
			],
			"2026-10-10",
			1000,
		);
		expect(picked?.id).toBe(1);
		expect(
			pickPriceOffer(
				[pay(2, "2026-10-09", 1500), pay(1, "2026-10-11", 1200)],
				"2026-10-10",
				1000,
			)?.id,
		).toBe(1);
	});
});

describe("bill matching and price changes", () => {
	const today = todayIn(DEFAULT_TIME_ZONE);
	// A monthly bill due in three days, paid yesterday: its occurrence is the one Bills shows (Due in the
	// next 7 days), and the payment is inside the ±5-day window. Three days ahead, not behind, so the
	// bill never slips to the next month's occurrence early in a month.
	const due = daysBefore(today, -3);
	const period = due.slice(0, 7);
	const paidOn = daysBefore(today, 1);
	const paidLabel = shortDay(paidOn, today);

	async function seed(
		bill: {
			amount: number;
			active?: number;
			merchant?: string;
			dueDate?: string;
		} = {
			amount: 10000,
		},
		payments: {
			id: number;
			amount: number;
			date?: string;
			raw?: string;
			excluded?: number;
			source?: string | null;
		}[] = [],
	) {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO accounts(id,name,type,balance_cents) VALUES(1,'Checking','depository',0)",
			),
			env.DB.prepare(
				"INSERT INTO merchants(raw_name,display_name) VALUES('NETFLIX.COM','Netflix')",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,active) VALUES(1,'Netflix',?,?,'monthly',?,?)",
			).bind(
				bill.amount,
				Number((bill.dueDate ?? due).slice(8, 10)),
				bill.merchant ?? "NETFLIX.COM",
				bill.active ?? 1,
			),
			...payments.map((p) =>
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source) VALUES(?,1,?,?,?,?,?)",
				).bind(
					p.id,
					p.date ?? paidOn,
					p.amount,
					p.raw ?? "NETFLIX.COM",
					p.excluded ?? 0,
					p.source ?? null,
				),
			),
		]);
	}
	const billRow = async () =>
		await env.DB.prepare("SELECT amount_cents FROM bills WHERE id=1").first<{
			amount_cents: number;
		}>();
	const rows = async (table: string, where = "1=1") =>
		(await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).all())
			.results;
	/** What the page showed, in integer cents: the bill's amount and the charge's (a payment at a new price: $100.00, $115.00). */
	const SEEN = { bill_cents: "10000", charge_cents: "11500" };
	const accept = (
		transaction: number,
		htmx = true,
		seen: Record<string, string> = SEEN,
	) =>
		post(
			`/bills/1/occurrences/${period}/price/accept`,
			{ transaction_id: String(transaction), ...seen },
			htmx,
		);
	const dismiss = (transaction: number, htmx = true) =>
		post(
			`/bills/1/occurrences/${period}/price/dismiss`,
			{ transaction_id: String(transaction) },
			htmx,
		);

	beforeEach(() => seed());

	describe("an excluded payment pays a bill", () => {
		beforeEach(() =>
			seed({ amount: 185000, merchant: "ZELLE LANDLORD" }, [
				{
					id: 1,
					amount: 185000,
					raw: "ZELLE LANDLORD",
					excluded: 1,
					source: "jev",
				},
			]),
		);

		/** Home's own sum: the month's counted spending, and what's set aside for unpaid bills due. */
		async function home() {
			// An early payment counts in the month the bank dated it (spec §6).
			const month = paidOn.slice(0, 7);
			const category = (await env.DB.prepare(
				"SELECT id FROM categories ORDER BY id LIMIT 1",
			).first<{ id: number }>()) as { id: number };
			await env.DB.batch([
				env.DB.prepare("DELETE FROM budget_amounts"),
				env.DB.prepare(
					"INSERT INTO budget_amounts(category_id,effective_month,amount_cents) VALUES(?,?,?)",
				).bind(category.id, month, 500000),
			]);
			const data = await loadMonth(env.DB, month);
			const bills = await loadBillRows(env.DB, today);
			const setAside = bills.rows
				.filter(
					(b) => b.active && (b.status === "due" || b.status === "overdue"),
				)
				.reduce((sum, b) => sum + b.amountCents, 0);
			return {
				summary: summarizeMonth({
					month,
					...data,
					unpaidDueBillsCents: setAside,
				}),
				setAside,
				status: bills.rows[0]?.status,
			};
		}

		it("pays the rent bill and counts once: as spending, no longer as set aside", async () => {
			// Before: the bill is due and set aside, and the excluded payment isn't spending.
			let now = await home();
			expect(now.status).toBe("due");
			expect(now.setAside).toBe(185000);
			expect(now.summary.totalSpentCents).toBe(0);
			expect(now.summary.safeToSpendCents).toBe(500000 - 185000);

			expect(await matchBillPayments(env.DB, today)).toBe(1);
			expect(
				await rows("bill_payments", "status='linked' AND transaction_id=1"),
			).toHaveLength(1);
			// The matcher isn't a person, so the put-back leaves no source.
			expect(
				await rows(
					"transactions",
					"id=1 AND excluded=0 AND excluded_source IS NULL",
				),
			).toHaveLength(1);

			// After: the bill is paid, so nothing is set aside, and the payment is spending, once.
			now = await home();
			expect(now.status).toBe("paid");
			expect(now.setAside).toBe(0);
			expect(now.summary.totalSpentCents).toBe(185000);
			expect(now.summary.safeToSpendCents).toBe(500000 - 185000);
		});

		it("is offered in the hand-link picker, marked Excluded, and linking it puts it back", async () => {
			const picker = await get(`/bills/1/occurrences/${period}/link`);
			expect(picker).toContain('name="transaction_id" value="1"');
			expect(picker).toContain("Excluded");

			const res = await post("/bills/1/link", {
				transaction_id: "1",
				period,
				opened_period: period,
			});
			expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
				toast: { message: "Payment linked", type: "success" },
				announce: "Payment linked",
			});
			expect(
				await rows("bill_payments", "status='linked' AND matched_by='user'"),
			).toHaveLength(1);
			expect(
				await rows(
					"transactions",
					"id=1 AND excluded=0 AND excluded_source='user'",
				),
			).toHaveLength(1);
			const after = await home();
			expect(after.status).toBe("paid");
			expect(after.summary.totalSpentCents).toBe(185000);
		});

		it("leaves it excluded when the link is refused", async () => {
			const stillExcluded = async () =>
				await rows(
					"transactions",
					"id=1 AND excluded=1 AND excluded_source='jev'",
				);
			const link = () =>
				post("/bills/1/link", {
					transaction_id: "1",
					period,
					opened_period: period,
				});
			// The month already has another payment: the link is refused, and the payment stays out.
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(2,1,?,185000,'ZELLE LANDLORD')",
				).bind(paidOn),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,2,'user','linked')",
				).bind(period),
			]);
			expect(await (await link()).text()).toContain("already linked");
			expect(await stillExcluded()).toHaveLength(1);

			// The payment is already linked to the bill, and someone excluded it again: a second link
			// is refused too, and doesn't undo that.
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,1,'user','linked')",
				).bind(period),
			]);
			expect(await (await link()).text()).toContain("already linked");
			expect(await stillExcluded()).toHaveLength(1);
		});
	});

	describe("a payment at a new price", () => {
		beforeEach(() => seed({ amount: 10000 }, [{ id: 1, amount: 11500 }]));

		it("is offered, not matched: a 15% rise changes nothing by itself", async () => {
			expect(await matchBillPayments(env.DB, today)).toBe(0);
			expect(await rows("bill_payments")).toEqual([]);
			expect((await billRow())?.amount_cents).toBe(10000);

			// The bill's row, still under its status heading, asks and says what was paid.
			const bills = await get("/bills");
			expect(bills).toContain("Price changed?");
			expect(bills).toContain(`Paid $115.00 on ${paidLabel}`);
			const group =
				bills.split("Due in the next 7 days")[1]?.split("</section>")[0] ?? "";
			expect(group).toContain("Netflix");
			expect(group).toContain("Price changed?");
			// The row keeps the bill's own amount, and the caption lines are ink, then muted.
			expect(group).toContain("$100.00");
			expect(group).toContain(
				'<span class="block leading-6">Price changed?</span>',
			);
			expect(group).toContain(
				`<span class="block leading-6 text-muted">Paid $115.00 on ${paidLabel}</span>`,
			);

			// The bill's page offers the update and the dismissal, and the matcher left it alone.
			const page = await get("/bills/1");
			expect(page).toContain(
				`Netflix charged $115.00 on ${paidLabel}, not $100.00.`,
			);
			expect(page).toContain("Update the bill to $115.00");
			expect(page).toContain("Not this bill");
			expect(await rows("bill_payments")).toEqual([]);
			expect((await billRow())?.amount_cents).toBe(10000);
		});

		it("asks under Overdue too, when the bill was due before the payment", async () => {
			const overdue = daysBefore(today, 2);
			await seed({ amount: 10000, dueDate: overdue }, [
				{ id: 1, amount: 11500, date: daysBefore(today, 1) },
			]);
			const bills = await get("/bills");
			const group = bills.split("Overdue")[1]?.split("</section>")[0] ?? "";
			expect(group).toContain("Netflix");
			expect(group).toContain("Price changed?");
			const page = await get("/bills/1");
			expect(page).toContain("Netflix charged $115.00");
			expect(page).toContain("Overdue");
		});

		it("keeps the two actions on the one newest row, with nothing else offered", async () => {
			const page = await get("/bills/1");
			expect(page.match(/Update the bill to/g)).toHaveLength(1);
			expect(page.match(/Not this bill/g)).toHaveLength(1);
			expect(page).toContain(`/bills/1/occurrences/${period}/price/accept`);
			expect(page).toContain(`/bills/1/occurrences/${period}/price/dismiss`);
		});

		it("accepting links the payment and updates the amount", async () => {
			const res = await accept(1);
			expect(res.status).toBe(200);
			expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
				toast: { message: "Bill updated to $115.00", type: "success" },
				announce: "Bill updated to $115.00 and the payment linked",
			});
			expect(await rows("bill_payments")).toEqual([
				expect.objectContaining({
					bill_id: 1,
					period,
					transaction_id: 1,
					matched_by: "user",
					status: "linked",
				}),
			]);
			expect((await billRow())?.amount_cents).toBe(11500);
			// The page that comes back no longer asks, and the bill is Paid.
			const html = await res.text();
			expect(html).not.toContain("Update the bill to");
			expect(html).not.toContain("Not this bill");
			expect(html).toContain("$115.00 a month");
			expect(await get("/bills")).not.toContain("Price changed?");
			expect(
				(await loadBillRows(env.DB, await householdToday(env.DB))).rows[0]
					?.status,
			).toBe("paid");
		});

		it("works for a yearly bill, keyed by its year", async () => {
			await env.DB.prepare(
				"UPDATE bills SET frequency='yearly',anchor_month=? WHERE id=1",
			)
				.bind(Number(due.slice(5, 7)))
				.run();
			const year = due.slice(0, 4);
			const page = await get("/bills/1");
			expect(page).toContain("Updating the bill links that payment");
			expect(page).toContain("$115.00 a year.");
			expect(page).toContain(`/bills/1/occurrences/${year}/price/accept`);
			const res = await post(`/bills/1/occurrences/${year}/price/accept`, {
				transaction_id: "1",
				...SEEN,
			});
			expect(res.status).toBe(200);
			expect(await rows("bill_payments", `period='${year}'`)).toHaveLength(1);
			expect((await billRow())?.amount_cents).toBe(11500);
		});

		it("accepts without JavaScript too, going back to the bill's page", async () => {
			const res = await accept(1, false);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/bills/1");
			expect((await billRow())?.amount_cents).toBe(11500);
		});

		it("puts an excluded payment back in the budget when it's accepted", async () => {
			await env.DB.prepare(
				"UPDATE transactions SET excluded=1,excluded_source='plaid' WHERE id=1",
			).run();
			expect(await get("/bills")).toContain("Price changed?");
			expect((await accept(1)).status).toBe(200);
			expect(
				await rows(
					"transactions",
					"id=1 AND excluded=0 AND excluded_source='user'",
				),
			).toHaveLength(1);
			expect((await billRow())?.amount_cents).toBe(11500);
		});

		it("lets the matcher fill the other months at the new price after an accept", async () => {
			// Last month's charge was the new price too, and was never matched at the old one.
			const earlier = daysBefore(due, 30);
			await env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(2,1,?,11500,'NETFLIX.COM')",
			)
				.bind(earlier)
				.run();
			await accept(1);
			const linked = await rows("bill_payments", "status='linked'");
			expect(linked.map((r) => r.transaction_id).sort()).toEqual([1, 2]);
		});

		it("dismissing keeps the bill and the payment as they were, and the offer doesn't come back", async () => {
			const res = await dismiss(1);
			expect(res.status).toBe(200);
			expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
				toast: { message: "Left the bill at $100.00", type: "success" },
				announce: "Price change dismissed. The bill stays $100.00.",
			});
			expect(await rows("bill_payments")).toEqual([
				expect.objectContaining({
					bill_id: 1,
					period,
					transaction_id: 1,
					matched_by: "user",
					status: "dismissed",
				}),
			]);
			expect((await billRow())?.amount_cents).toBe(10000);
			expect(await res.text()).not.toContain("Update the bill to");

			// Not on Bills, not on the page, not after the matcher or a sync runs again.
			expect(await get("/bills")).not.toContain("Price changed?");
			expect(await get("/bills/1")).not.toContain("Update the bill to");
			expect(await matchBillPayments(env.DB, today)).toBe(0);
			expect(await get("/bills")).not.toContain("Price changed?");
			// The occurrence is back to a plain unpaid one, with the usual link action.
			expect(await get("/bills/1")).toContain("Link a payment");
		});

		it("dismissing twice records it once", async () => {
			await dismiss(1);
			await dismiss(1);
			expect(await rows("bill_payments", "status='dismissed'")).toHaveLength(1);
		});

		it("offers another payment for the same month after one is dismissed", async () => {
			await dismiss(1);
			await env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(2,1,?,12000,'NETFLIX.COM')",
			)
				.bind(paidOn)
				.run();
			const page = await get("/bills/1");
			expect(page).toContain("Netflix charged $120.00");
		});

		it("refuses an offer that isn't there now, and changes nothing", async () => {
			for (const send of [accept, dismiss]) {
				// Not this bill's payment at all.
				await env.DB.prepare(
					"INSERT OR IGNORE INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9,1,?,11500,'OTHER SHOP')",
				)
					.bind(paidOn)
					.run();
				const res = await send(9);
				expect(await res.text()).toContain("isn&#39;t on offer");
				expect(res.headers.get("HX-Trigger")).toBeNull();
			}
			expect(await rows("bill_payments")).toEqual([]);
			expect((await billRow())?.amount_cents).toBe(10000);
			// A missing bill is a 404, and a month that isn't the current one has no offer.
			expect(
				(
					await post(`/bills/99/occurrences/${period}/price/accept`, {
						transaction_id: "1",
					})
				).status,
			).toBe(404);
			const wrongMonth = await post(
				"/bills/1/occurrences/2020-01/price/accept",
				{
					transaction_id: "1",
				},
			);
			expect(await wrongMonth.text()).toContain("isn&#39;t on offer");
			expect((await billRow())?.amount_cents).toBe(10000);
		});

		it("says so when the offer went away since the page was drawn", async () => {
			// The bill was edited to the new price in the meantime, so the matcher took the payment.
			await env.DB.prepare("UPDATE bills SET amount_cents=11500").run();
			await matchBillPayments(env.DB, today);
			const res = await accept(1);
			const html = await res.text();
			expect(html).toContain('role="alert"');
			expect(html).toContain("isn&#39;t on offer");
			expect((await billRow())?.amount_cents).toBe(11500);
			expect(res.headers.get("HX-Trigger")).toBeNull();
		});

		it("takes the amount from the payment itself, never from the form", async () => {
			const res = await post(`/bills/1/occurrences/${period}/price/accept`, {
				transaction_id: "1",
				amount: "1.00",
				...SEEN,
			});
			expect(res.status).toBe(200);
			expect((await billRow())?.amount_cents).toBe(11500);
		});

		describe("a page that has gone stale", () => {
			const untouched = async () => {
				expect(await rows("bill_payments")).toEqual([]);
				expect(
					await rows(
						"transactions",
						"id=1 AND excluded=1 AND excluded_source='jev'",
					),
				).toHaveLength(1);
			};
			beforeEach(() =>
				env.DB.prepare(
					"UPDATE transactions SET excluded=1,excluded_source='jev' WHERE id=1",
				).run(),
			);

			it("can't save a price over a bill that was edited after the offer showed", async () => {
				// The page showed $100.00 against $115.00; the bill became $200.00 since. $115.00 is still far
				// enough from it to be on offer, but the person never saw that.
				await env.DB.prepare("UPDATE bills SET amount_cents=20000").run();
				expect(await get("/bills/1")).toContain("not $200.00.");
				const res = await accept(1);
				const html = await res.text();
				expect(html).toContain('role="alert"');
				expect(html).toContain("isn&#39;t on offer");
				expect(res.headers.get("HX-Trigger")).toBeNull();
				expect((await billRow())?.amount_cents).toBe(20000);
				await untouched();
			});

			it("can't save a charge that was corrected after the offer showed", async () => {
				await env.DB.prepare(
					"UPDATE transactions SET amount_cents=12000 WHERE id=1",
				).run();
				const res = await accept(1);
				expect(await res.text()).toContain("isn&#39;t on offer");
				expect((await billRow())?.amount_cents).toBe(10000);
				await untouched();
				// What the page shows now, $120.00, is what it saves.
				const fresh = await accept(1, true, {
					bill_cents: "10000",
					charge_cents: "12000",
				});
				expect(fresh.headers.get("HX-Trigger")).toContain("Bill updated");
				expect((await billRow())?.amount_cents).toBe(12000);
			});

			it("needs the prices it was drawn with, and takes only whole cents", async () => {
				const stale: Record<string, string>[] = [
					{},
					{ bill_cents: "10000" },
					{ charge_cents: "11500" },
					{ bill_cents: "100.00", charge_cents: "115.00" },
					{ bill_cents: "10000.5", charge_cents: "11500" },
					{ bill_cents: "", charge_cents: "" },
				];
				for (const seen of stale) {
					const res = await accept(1, true, seen);
					expect(await res.text()).toContain("isn&#39;t on offer");
				}
				expect((await billRow())?.amount_cents).toBe(10000);
				await untouched();
			});

			it("draws the prices into the form, as integer cents", async () => {
				const page = await get("/bills/1");
				expect(page).toContain('name="bill_cents" value="10000"');
				expect(page).toContain('name="charge_cents" value="11500"');
			});
		});

		describe("accepting when the offer goes stale between the check and the write", () => {
			const offer = {
				transactionId: 1,
				date: paidOn,
				amountCents: 11500,
				merchant: "Netflix",
			};
			const accepts = () =>
				acceptPriceOffer(env.DB, 1, period, offer, 10000, "demo");
			const unchanged = async (excluded = 1) => {
				expect((await billRow())?.amount_cents).toBe(10000);
				expect(
					await rows("transactions", `id=1 AND excluded=${excluded}`),
				).toHaveLength(1);
			};
			beforeEach(() =>
				env.DB.prepare(
					"UPDATE transactions SET excluded=1,excluded_source='jev' WHERE id=1",
				).run(),
			);

			it("links, un-excludes and updates the amount together when it still holds", async () => {
				expect(await accepts()).toBe(true);
				expect(await rows("bill_payments", "status='linked'")).toHaveLength(1);
				expect((await billRow())?.amount_cents).toBe(11500);
				expect(
					await rows(
						"transactions",
						"id=1 AND excluded=0 AND excluded_source='user'",
					),
				).toHaveLength(1);
			});

			it("changes nothing when another tab already linked this payment to this month", async () => {
				await env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,1,'user','linked')",
				)
					.bind(period)
					.run();
				expect(await accepts()).toBe(false);
				await unchanged();
				expect(await rows("bill_payments")).toHaveLength(1);
			});

			it("changes nothing when another payment already pays this month", async () => {
				await env.DB.batch([
					env.DB.prepare(
						"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(2,1,?,10000,'NETFLIX.COM')",
					).bind(paidOn),
					env.DB.prepare(
						"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,2,'user','linked')",
					).bind(period),
				]);
				expect(await accepts()).toBe(false);
				await unchanged();
			});

			it("changes nothing when the bill's amount was edited, or the charge corrected", async () => {
				await env.DB.prepare("UPDATE bills SET amount_cents=20000").run();
				expect(await accepts()).toBe(false);
				expect((await billRow())?.amount_cents).toBe(20000);
				expect(await rows("bill_payments")).toEqual([]);
				expect(await rows("transactions", "id=1 AND excluded=1")).toHaveLength(
					1,
				);

				await env.DB.batch([
					env.DB.prepare("UPDATE bills SET amount_cents=10000"),
					env.DB.prepare(
						"UPDATE transactions SET amount_cents=12000 WHERE id=1",
					),
				]);
				expect(await accepts()).toBe(false);
				await unchanged();
				expect(await rows("bill_payments")).toEqual([]);
			});
		});
	});

	describe("an offer is for one unpaid occurrence, one payment, and a payment nobody has claimed", () => {
		const bill = {
			id: 1,
			amountCents: 10000,
			merchantRawName: "NETFLIX.COM",
			merchantRawText: 0,
			period,
			dueDate: due,
		};

		it("is made only for an active bill whose occurrence is due or overdue", async () => {
			await seed({ amount: 10000 }, [{ id: 1, amount: 11500 }]);
			for (const status of ["due", "overdue"] as const) {
				expect(
					(await findPriceOffer(env.DB, { ...bill, active: true, status }))
						?.transactionId,
				).toBe(1);
			}
			// Paid already, still weeks away, or an inactive bill: nothing to ask.
			for (const [active, status] of [
				[true, "paid"],
				[true, "upcoming"],
				[false, "due"],
				[false, "overdue"],
			] as const)
				expect(
					await findPriceOffer(env.DB, { ...bill, active, status }),
				).toBeUndefined();
			const all = await loadPriceOffers(env.DB, [
				{ ...bill, id: 1, active: true, status: "paid" },
				{ ...bill, id: 2, active: true, status: "upcoming" },
				{ ...bill, id: 3, active: false, status: "overdue" },
				{ ...bill, id: 4, active: true, status: "due" },
			]);
			expect([...all.keys()]).toEqual([4]);
		});

		it("is one payment: the closest by date, then by amount, shown once", async () => {
			await seed({ amount: 10000 }, [
				{ id: 1, amount: 11500, date: daysBefore(due, 4) },
				{ id: 2, amount: 13000, date: daysBefore(due, 2) },
				{ id: 3, amount: 12000, date: daysBefore(due, 2) },
				{ id: 4, amount: 14000, date: daysBefore(due, -2) },
			]);
			const page = await get("/bills/1");
			expect(page.match(/Update the bill to/g)).toHaveLength(1);
			// Three are two days away; of those the closest amount, $120.00, not $130.00 or $140.00.
			expect(page).toContain("Update the bill to $120.00");
			expect(await get("/bills")).toContain(
				`Paid $120.00 on ${shortDay(daysBefore(due, 2), today)}`,
			);
		});

		it("is never a charge another bill has already claimed", async () => {
			await seed({ amount: 10000 }, [
				{ id: 1, amount: 11500 },
				{ id: 2, amount: 12000, date: daysBefore(paidOn, 1) },
			]);
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(2,'Netflix kids',12000,?,'monthly','NETFLIX.COM')",
				).bind(Number(due.slice(8, 10))),
				// The other bill's own payment for that month is the closer charge, and is linked to it.
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(2,?,1,'auto','linked')",
				).bind(period),
			]);
			const page = await get("/bills/1");
			expect(page).not.toContain("Update the bill to $115.00");
			expect(page).toContain("Update the bill to $120.00");
			// And once that one is claimed too, nothing is left to ask about.
			await env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(3,'Netflix 4K',12000,?,'monthly','NETFLIX.COM')",
			)
				.bind(Number(due.slice(8, 10)))
				.run();
			await env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(3,?,2,'auto','linked')",
			)
				.bind(period)
				.run();
			expect(await get("/bills/1")).not.toContain("Update the bill to");
		});
	});

	describe("a payment that isn't an offer", () => {
		const offered = async () =>
			(await get("/bills")).includes("Price changed?");

		it("still matches a 9% change as today, and asks nothing", async () => {
			await seed({ amount: 10000 }, [{ id: 1, amount: 10900 }]);
			expect(await matchBillPayments(env.DB, today)).toBe(1);
			expect(await rows("bill_payments", "status='linked'")).toHaveLength(1);
			expect(await offered()).toBe(false);
			expect(await get("/bills/1")).not.toContain("Update the bill to");
		});

		it("is not offered when it's the wrong merchant, outside the window, or money in", async () => {
			await seed({ amount: 10000 }, [
				{ id: 1, amount: 11500, raw: "SOMEONE ELSE" },
				{ id: 2, amount: 11500, date: daysBefore(due, 6) },
				{ id: 3, amount: -11500 },
				{ id: 4, amount: 0 },
			]);
			expect(await offered()).toBe(false);
			expect(await get("/bills/1")).not.toContain("Price changed?");
		});

		it("is not offered over $100,000, which the bill's own form confirms", async () => {
			await seed({ amount: 10000 }, [{ id: 1, amount: BIG_BILL_CENTS + 1 }]);
			expect(await offered()).toBe(false);
		});

		it("is not offered once the month has a payment, for an inactive bill, or one already claimed", async () => {
			await seed({ amount: 10000 }, [
				{ id: 1, amount: 11500 },
				{ id: 2, amount: 10000 },
			]);
			await matchBillPayments(env.DB, today);
			expect(await offered()).toBe(false);

			await seed({ amount: 10000, active: 0 }, [{ id: 1, amount: 11500 }]);
			expect(await offered()).toBe(false);

			await seed({ amount: 10000 }, [{ id: 1, amount: 11500 }]);
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(2,'Streaming',11500,1,'monthly','OTHER')",
				),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(2,'2020-01',1,'user','linked')",
				),
			]);
			expect(await offered()).toBe(false);
		});

		it("follows a bill saved under the bank's raw text, and a bill's own key", async () => {
			await seed({ amount: 10000, merchant: "NETFLIX.COM" }, []);
			await env.DB.batch([
				env.DB.prepare("UPDATE bills SET merchant_raw_text=1 WHERE id=1"),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,merchant_name) VALUES(1,1,?,11500,'NETFLIX.COM 866','Netflix')",
				).bind(paidOn),
			]);
			// A flagged bill matches by raw name only: this charge's raw name differs, so no offer.
			expect(await offered()).toBe(false);
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE bills SET merchant_raw_text=0,merchant_raw_name='Netflix' WHERE id=1",
				),
			]);
			// A key bill matches the Plaid merchant name.
			expect(await offered()).toBe(true);
		});
	});
});
