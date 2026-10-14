import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchBillPayments } from "../src/bills/match";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import {
	correctCashSplit,
	getTransaction,
	saveEdit,
	saveSplit,
} from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { entryKeyOf } from "../src/transactions/cash";
import { CashForm } from "../src/views/cash-form";

const BASE = "http://tally.test";

async function request(path: string, init?: RequestInit) {
	const res = await exports.default.fetch(BASE + path, init);
	return { res, html: await res.text() };
}

beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

describe("adding cash", () => {
	it("shows the Add cash control and an accessible sheet", async () => {
		const list = await request("/transactions");
		expect(list.html).toMatch(
			/href="\/transactions\/cash\/new\?back=[^"]+"[^>]*>[\s\S]*?Add cash<\/a>/,
		);
		const { html } = await request("/transactions/cash/new");
		const form = html.slice(html.indexOf('id="cash-title"'));
		expect(html).toContain("Add cash spending");
		expect(html).toContain("<title>Add cash · Tally</title>");
		expect(html).toContain(`max="${todayIn(DEFAULT_TIME_ZONE)}"`);
		expect(html).not.toContain('name="direction"');
		expect(html).not.toContain("Money in");
		expect(html).toContain('name="amount"');
		expect(html).toContain('name="merchant"');
		expect(html).toContain(">Where</label>");
		expect(form.indexOf('name="amount"')).toBeLessThan(
			form.indexOf('name="date"'),
		);
		expect(form.indexOf('name="date"')).toBeLessThan(
			form.indexOf('name="category"'),
		);
		expect(form.indexOf('name="category"')).toBeLessThan(
			form.indexOf('name="note"'),
		);
	});

	it("opens Add cash with an empty amount, as Add a bill does", async () => {
		const { html } = await request("/transactions/cash/new");
		const amount = html.match(/<input [^>]*id="cash-amount"[^>]*>/)?.[0] ?? "";
		expect(amount).toContain('name="amount"');
		expect(amount).toContain('value=""');
		expect(html).not.toContain('value="20.00"');
	});

	it("refuses Add cash with no amount, saying so in role=alert, and saves nothing", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const post = (body: string) =>
			request("/transactions/cash", {
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body,
			});
		const missing = await post(
			new URLSearchParams({
				date: today,
				merchant: "No amount market",
				category: "1",
			}).toString(),
		);
		const blank = await post(
			new URLSearchParams({
				date: today,
				amount: "",
				merchant: "No amount market",
				category: "1",
			}).toString(),
		);
		for (const { res, html } of [missing, blank]) {
			expect(res.status).toBe(422);
			expect(html).toMatch(
				/<p id="cash-amount-error" role="alert"[^>]*>Enter an amount in dollars and cents\.<\/p>/,
			);
		}
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='No amount market'",
			).first(),
		).toEqual({ n: 0 });
	});

	it("creates one guarded Cash account and inserts integer cents with the Access actor", async () => {
		await env.DB.prepare(
			"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE type='cash')",
		).run();
		await env.DB.prepare("DELETE FROM accounts WHERE type='cash'").run();
		const post = () =>
			request("/transactions/cash", {
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					date: todayIn(DEFAULT_TIME_ZONE),
					amount: "20.45",
					merchant: "Farmers market",
					category: "1",
					note: "Peaches",
				}),
			});
		const [{ res }] = await Promise.all([post(), post()]);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Added Farmers market", type: "success" },
			announce: "Added $20.45 cash spending at Farmers market.",
		});
		const account = await env.DB.prepare(
			"SELECT * FROM accounts WHERE type='cash'",
		).all();
		expect(account.results).toHaveLength(1);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Farmers market'",
				).first<{ n: number }>()
			)?.n,
		).toBe(2);
		expect(account.results[0]).toMatchObject({
			name: "Cash",
			plaid_item_id: null,
			plaid_account_id: null,
		});
		const tx = await env.DB.prepare(
			"SELECT amount_cents, plaid_transaction_id, category_source, flag_income, updated_by FROM transactions WHERE raw_name='Farmers market'",
		).first();
		expect(tx).toMatchObject({
			amount_cents: 2045,
			plaid_transaction_id: null,
			category_source: "user",
			flag_income: 0,
			updated_by: "demo",
		});
	});

	it("validates impossible and future dates, unsafe amounts, and other fields", async () => {
		const { res, html } = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "date=2026-02-31&amount=90071992547409.92&merchant=&category=999",
		});
		expect(res.status).toBe(422);
		expect((html.match(/role="alert"/g) ?? []).length).toBeGreaterThanOrEqual(
			3,
		);
		expect(html).toContain("Choose today or an earlier date.");
		expect(html).toContain("Enter a smaller amount in dollars and cents.");
	});

	it("rejects cash dates more than ten years before today and accepts the boundary", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const dateYearsBack = (years: number) =>
			`${String(Number(today.slice(0, 4)) - years).padStart(4, "0")}${today.slice(4)}`;
		for (const [date, accepted, message] of [
			[dateYearsBack(10), true, ""],
			[dateYearsBack(11), false, "Choose a date within the last 10 years."],
			[
				`${String(Number(today.slice(0, 4)) + 1).padStart(4, "0")}${today.slice(4)}`,
				false,
				"Choose today or an earlier date.",
			],
		] as const) {
			const { res, html } = await request("/transactions/cash", {
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					date,
					amount: "20",
					merchant: "Date check",
					category: "1",
					note: "",
				}),
			});
			if (accepted) expect(res.status).toBe(200);
			else {
				expect(res.status).toBe(422);
				expect(html).toContain(message);
			}
		}
	});

	it("says why a non-number amount and an empty Where are wrong", async () => {
		const { html } = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "date=2026-01-02&amount=abc&merchant=&category=1",
		});
		expect(html).toContain("Enter an amount in dollars and cents.");
		expect(html).not.toContain("Enter an amount greater than zero.");
		expect(html).toContain("Enter where you spent it.");
	});

	it("refuses an amount of zero on Add cash and saves nothing", async () => {
		const { res, html } = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "0.00",
				merchant: "Zero add cash",
				category: "1",
			}),
		});
		expect(res.status).toBe(422);
		expect(html).toContain("Enter an amount greater than zero.");
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Zero add cash'",
			).first(),
		).toEqual({ n: 0 });
	});

	it("refreshes Add cash with the list when filters change in place", async () => {
		const { html } = await request("/transactions?month=all");
		const link = html.match(/<a[^>]*id="add-cash"[^>]*>/)?.[0] ?? "";
		expect(link).toContain(
			'href="/transactions/cash/new?back=%2Ftransactions%3Fmonth%3Dall"',
		);
		expect(html.match(/hx-select-oob="[^"]*#add-cash:outerHTML/g)?.length).toBe(
			2,
		);
	});

	it("returns to the filtered list after save, close, and cancel", async () => {
		const back = "/transactions?category=1&amp;month=all";
		const sheet = await request(
			`/transactions/cash/new?back=${encodeURIComponent("/transactions?category=1&month=all")}`,
		);
		// Closing, or Cancel, returns focus to Add cash (#87).
		expect(sheet.html).toContain(`href="${back}&amp;focus=add-cash"`);
		expect(sheet.html).toContain(`name="back" value="${back}"`);
		const { res } = await request("/transactions/cash", {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "8",
				merchant: "Filtered cash",
				category: "1",
				note: "",
				back: "/transactions?category=1&month=all",
			}),
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe(
			"/transactions?category=1&month=all",
		);
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents FROM transactions WHERE raw_name='Filtered cash'",
				).first<{ amount_cents: number }>()
			)?.amount_cents,
		).toBe(800);
		const saved = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "9",
				merchant: "Filtered htmx cash",
				category: "1",
				note: "",
				back: "/transactions?category=1&month=all",
			}),
		});
		expect(saved.res.headers.get("HX-Push-Url")).toBe(
			"/transactions?category=1&month=all",
		);
		expect(saved.html).toContain("Filtered htmx cash");
		expect(saved.html).not.toContain("Thai Palace");
	});
});

describe("cash lifecycle", () => {
	const createBillLinkedCash = async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const month = today.slice(0, 7);
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today,
				amount: "18.50",
				merchant: "Bill-linked cash",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Bill-linked cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9600,'Linked cash bill',1850,5,'monthly',1,'BILL-LINKED CASH')",
		).run();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9600,?,?,'user','linked')",
		)
			.bind(month, id)
			.run();

		return { id, today, month };
	};
	const saveCashEdit = (id: number, date: string, amount: string) =>
		request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ date, amount, back: "/transactions" }),
		});
	const linkedPayment = (id: number) =>
		env.DB.prepare(
			"SELECT bill_id,period,transaction_id,status FROM bill_payments WHERE transaction_id=?",
		)
			.bind(id)
			.first();

	it("date edit keeps the bill link", async () => {
		const { id, today, month } = await createBillLinkedCash();
		const yesterday = new Date(`${today}T00:00:00Z`);
		yesterday.setUTCDate(yesterday.getUTCDate() - 1);
		const earlierDate = yesterday.toISOString().slice(0, 10);
		const saved = await saveCashEdit(id, earlierDate, "18.50");
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT date FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ date: earlierDate });
		expect(await linkedPayment(id)).toEqual({
			bill_id: 9600,
			period: month,
			transaction_id: id,
			status: "linked",
		});
	});

	it("amount edit keeps the bill link", async () => {
		const { id, today, month } = await createBillLinkedCash();
		const saved = await saveCashEdit(id, today, "20.00");
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, date FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({ amount_cents: 2000, date: today });
		expect(await linkedPayment(id)).toEqual({
			bill_id: 9600,
			period: month,
			transaction_id: id,
			status: "linked",
		});
	});

	it("edits a cash entry's date and amount in the edit panel", async () => {
		const created = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: "2026-10-01",
				amount: "18.50",
				merchant: "Editable cash",
				category: "1",
			}),
		});
		expect(created.res.status).toBe(200);
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Editable cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		const monthSummary = async () => {
			const data = await loadMonth(env.DB, "2026-10");
			return summarizeMonth({
				month: "2026-10",
				categories: data.categories,
				amounts: data.amounts,
				transactions: data.transactions,
				unpaidDueBillsCents: 0,
			}).totalSpentCents;
		};
		const spentBefore = await monthSummary();
		const panel = await request(`/transactions/${id}`);
		expect(panel.html).toContain("Cash · you entered this");
		expect(panel.html).toContain(`name="amount"`);
		expect(panel.html).toContain(`name="date"`);
		const saved = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: "2026-10-02",
				amount: "20.00",
				back: "/transactions",
			}),
		});
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT date,amount_cents FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({ date: "2026-10-02", amount_cents: 2000 });
		expect((await monthSummary()) - spentBefore).toBe(150);
	});

	const createCash = async (merchant: string, amount: string) => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount,
				merchant,
				category: "1",
			}),
		});
		return (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name=? ORDER BY id DESC LIMIT 1",
			)
				.bind(merchant)
				.first<{ id: number }>()
		)?.id as number;
	};

	it("refuses an amount of zero in the edit panel and keeps the amount", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const id = await createCash("Zero edit cash", "18.50");
		const { res, html } = await saveCashEdit(id, today, "0.00");
		expect(res.status).toBe(422);
		expect(html).toContain("Enter an amount greater than zero.");
		expect(
			await env.DB.prepare("SELECT amount_cents FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ amount_cents: 1850 });
	});

	it("saves a cash entry's category, note, date and amount from one Save", async () => {
		const id = await createCash("One save cash", "18.50");
		const saved = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: "2026-10-02",
				amount: "20.00",
				category: "5",
				note: "One save note",
				back: "/transactions",
			}),
		});
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT date, amount_cents, note, category_id, category_source FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({
			date: "2026-10-02",
			amount_cents: 2000,
			note: "One save note",
			category_id: 5,
			category_source: "user",
		});
	});

	it("saves nothing in the panel, its category included, when the amount is refused", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const id = await createCash("Refused panel cash", "20.00");
		await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,?, -1500, 'Refused panel refund', ?, 1 FROM transactions WHERE id=?",
		)
			.bind(today, id, id)
			.run();
		const refused = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today,
				amount: "10.00",
				category: "5",
				back: "/transactions",
			}),
		});
		expect(refused.res.status).toBe(422);
		expect(refused.html).toContain(
			"Linked refunds add up to $15.00, so the amount can&#39;t be less than that.",
		);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents, category_id FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({ amount_cents: 2000, category_id: 1 });
	});

	it("treats a cash entry deleted while it is being saved as an error, not a refund refusal", async () => {
		const id = await createCash("Vanishing cash", "18.50");
		const db = {
			prepare: env.DB.prepare.bind(env.DB),
			batch: async (statements: D1PreparedStatement[]) => {
				await env.DB.prepare("DELETE FROM transactions WHERE id = ?")
					.bind(id)
					.run();
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		await expect(
			saveEdit(
				db,
				id,
				{
					categoryId: null,
					alwaysForMerchant: false,
					displayName: null,
					note: null,
					excluded: false,
					income: false,
					creditReviewed: false,
					cashDate: "2026-10-02",
					cashAmountCents: 2000,
				},
				"synthetic-test",
			),
		).rejects.toThrow(`No transaction ${id}`);
	});

	it("refuses future cash edit dates and bank date and amount changes", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "18.50",
				merchant: "Future guard",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Future guard' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		const tomorrow = new Date(`${todayIn(DEFAULT_TIME_ZONE)}T00:00:00Z`);
		tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
		const future = tomorrow.toISOString().slice(0, 10);
		const rejected = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: future,
				amount: "18.50",
				back: "/transactions",
			}),
		});
		expect(rejected.res.status).toBe(422);
		expect(rejected.html).toContain("Choose today or an earlier date.");
		const bankRow = await env.DB.prepare(
			"SELECT t.id, p.institution_name AS bank FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN plaid_items p ON p.id=a.plaid_item_id LIMIT 1",
		).first<{ id: number; bank: string }>();
		const bankId = bankRow?.id as number;
		const bankPanel = await request(`/transactions/${bankId}`);
		expect(bankPanel.html).toContain(
			`From ${bankRow?.bank}. Its date and amount stay as the bank sent them. If something&#39;s off, you can split it, exclude it, or count it in another month.`,
		);
		const bank = await env.DB.prepare(
			"SELECT date,amount_cents FROM transactions WHERE id=?",
		)
			.bind(bankId)
			.first();
		await request(`/transactions/${bankId}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: future,
				amount: "1.00",
				back: "/transactions",
			}),
		});
		expect(
			await env.DB.prepare(
				"SELECT date,amount_cents FROM transactions WHERE id=?",
			)
				.bind(bankId)
				.first(),
		).toEqual(bank);
	});

	it("keeps split parts with a cash entry date and refuses an amount that differs", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "18.50",
				merchant: "Split edit",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Split edit' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		await saveSplit(
			env.DB,
			id,
			[
				{ amountCents: 900, categoryId: 1 },
				{ amountCents: 950, categoryId: 2 },
			],
			"demo",
		);
		const rejected = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "20.00",
				back: "/transactions",
			}),
		});
		expect(rejected.res.status).toBe(422);
		expect(rejected.html).toContain(
			"The parts add up to $18.50. Change them to match $20.00.",
		);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE parent_id=?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
		const tomorrow = new Date(`${todayIn(DEFAULT_TIME_ZONE)}T00:00:00Z`);
		tomorrow.setUTCDate(tomorrow.getUTCDate() - 1);
		const moved = tomorrow.toISOString().slice(0, 10);
		const saved = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: moved,
				amount: "18.50",
				back: "/transactions",
			}),
		});
		expect(saved.res.status).toBe(200);
		expect(
			(
				await env.DB.prepare(
					"SELECT DISTINCT date FROM transactions WHERE parent_id=?",
				)
					.bind(id)
					.all()
			).results,
		).toEqual([{ date: moved }]);
	});

	describe("linking a split cash entry in the same save as its amount", () => {
		type LinkRow = { amountCents: number; refundOfId: number | null };
		const linkState = async (id: number) => ({
			parent: await env.DB.prepare(
				"SELECT amount_cents AS amountCents, refund_of_id AS refundOfId FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first<LinkRow>(),
			parts: (
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents, refund_of_id AS refundOfId FROM transactions WHERE parent_id = ? ORDER BY id",
				)
					.bind(id)
					.all<LinkRow>()
			).results,
		});
		/** A $90.00 cash entry split into $60.00 and $30.00, and a $100.00 cash purchase to link it to. */
		const splitAndPurchase = async () => {
			const id = await createCash("Link split cash", "90.00");
			await saveSplit(
				env.DB,
				id,
				[
					{ amountCents: 6000, categoryId: 1 },
					{ amountCents: 3000, categoryId: 5 },
				],
				"demo",
			);
			return { id, purchase: await createCash("Link purchase cash", "100.00") };
		};
		/** The panel's save that links the entry to the purchase and sets its amount to `cashAmountCents`. */
		const linkAndSetAmount = (
			id: number,
			purchase: number,
			cashAmountCents: number,
		) =>
			saveEdit(
				env.DB,
				id,
				{
					categoryId: null,
					alwaysForMerchant: false,
					displayName: null,
					nameChanged: false,
					note: null,
					excluded: false,
					income: false,
					creditReviewed: false,
					refundOfId: purchase,
					cashDate: todayIn(DEFAULT_TIME_ZONE),
					cashAmountCents,
				},
				"demo",
			);

		it("saves nothing when the parts don't add up to the new amount: the refund stays unlinked and the parts keep theirs", async () => {
			const { id, purchase } = await splitAndPurchase();
			const before = await linkState(id);
			// $100.00 is not what the parts add up to ($90.00); the route answers that with "The parts add up to $90.00. Change them to match $100.00."
			expect(await linkAndSetAmount(id, purchase, 10000)).toEqual({
				saved: false,
				cashError: "split",
				amountCents: 9000,
			});
			expect(await linkState(id)).toEqual(before);
			expect(before.parent?.refundOfId).toBeNull();
			expect(before.parts.map((part) => part.refundOfId)).toEqual([null, null]);
		});

		it("links the entry and its parts to the purchase when the parts add up to the new amount", async () => {
			const { id, purchase } = await splitAndPurchase();
			expect(await linkAndSetAmount(id, purchase, 9000)).toEqual({
				saved: true,
			});
			expect(await linkState(id)).toEqual({
				parent: { amountCents: 9000, refundOfId: purchase },
				parts: [
					{ amountCents: 6000, refundOfId: purchase },
					{ amountCents: 3000, refundOfId: purchase },
				],
			});
		});
	});

	it("a split cash part's panel has no cash fields, and a category save on it keeps the entry", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "20.00",
				merchant: "Split part cash",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Split part cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		await saveSplit(
			env.DB,
			id,
			[
				{ amountCents: 900, categoryId: 1 },
				{ amountCents: 1100, categoryId: 2 },
			],
			"demo",
		);
		const part = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE parent_id=? ORDER BY id LIMIT 1",
			)
				.bind(id)
				.first<{ id: number }>()
		)?.id as number;
		const panel = await request(`/transactions/${part}`);
		expect(panel.res.status).toBe(200);
		expect(panel.html).not.toContain(`name="amount"`);
		expect(panel.html).not.toContain(`name="date"`);
		expect(panel.html).not.toContain("Cash · you entered this");
		expect(panel.html).toContain("$9.00");
		const saved = await request(`/transactions/${part}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ category: "2", back: "/transactions" }),
		});
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT category_id FROM transactions WHERE id=?")
				.bind(part)
				.first(),
		).toEqual({ category_id: 2 });
		expect(
			await env.DB.prepare("SELECT amount_cents FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ amount_cents: 2000 });
	});

	it("refuses an edited date more than ten years before today, and accepts the boundary", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "18.50",
				merchant: "Ten year cash",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Ten year cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		const today = todayIn(DEFAULT_TIME_ZONE);
		const tenYearsBefore = (days: number) => {
			const day = new Date(`${today}T00:00:00Z`);
			day.setUTCFullYear(day.getUTCFullYear() - 10);
			day.setUTCDate(day.getUTCDate() + days);
			return day.toISOString().slice(0, 10);
		};
		const tooOld = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: tenYearsBefore(-1),
				amount: "18.50",
				back: "/transactions",
			}),
		});
		expect(tooOld.res.status).toBe(422);
		expect(tooOld.html).toContain("Choose a date within the last 10 years.");
		const boundary = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: tenYearsBefore(0),
				amount: "18.50",
				back: "/transactions",
			}),
		});
		expect(boundary.res.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT date FROM transactions WHERE id=?")
				.bind(id)
				.first(),
		).toEqual({ date: tenYearsBefore(0) });
	});

	it("counts a cash entry in the month of its edited date", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const previousMonthEnd = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
		previousMonthEnd.setUTCDate(0);
		const oldDate = previousMonthEnd.toISOString().slice(0, 10);
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: oldDate,
				amount: "18.50",
				merchant: "Month move cash",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Month move cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		const loadSpent = async () => {
			const data = await loadMonth(env.DB, today.slice(0, 7));
			return summarizeMonth({
				month: today.slice(0, 7),
				categories: data.categories,
				amounts: data.amounts,
				transactions: data.transactions,
				unpaidDueBillsCents: 0,
			}).totalSpentCents;
		};
		const before = await loadSpent();
		await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today,
				amount: "18.50",
				back: "/transactions",
			}),
		});
		expect((await loadSpent()) - before).toBe(1850);
	});

	it("keeps a cash entry's linked refund and refuses reducing its amount below that refund", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "20.00",
				merchant: "Refund guard cash",
				category: "1",
			}),
		});
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Refund guard cash' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,?, -1500, 'Cash refund', ?, 1 FROM transactions WHERE id=?",
		)
			.bind(todayIn(DEFAULT_TIME_ZONE), id, id)
			.run();
		const tooSmall = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "10.00",
				back: "/transactions",
			}),
		});
		expect(tooSmall.res.status).toBe(422);
		expect(tooSmall.html).toContain(
			"Linked refunds add up to $15.00, so the amount can&#39;t be less than that.",
		);
		const yesterday = new Date(`${todayIn(DEFAULT_TIME_ZONE)}T00:00:00Z`);
		yesterday.setUTCDate(yesterday.getUTCDate() - 1);
		const date = yesterday.toISOString().slice(0, 10);
		const moved = await request(`/transactions/${id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date,
				amount: "20.00",
				back: "/transactions",
			}),
		});
		expect(moved.res.status).toBe(200);
		expect(
			(
				await env.DB.prepare(
					"SELECT date,refund_of_id FROM transactions WHERE raw_name='Cash refund' ORDER BY id DESC LIMIT 1",
				).first<{ refund_of_id: number | null }>()
			)?.refund_of_id,
		).toBe(id);
	});

	it("uses the cash-delete toast wording for a split entry and Undo restores its parent and parts", async () => {
		const name = "Split market";
		const created = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "20.00",
				merchant: name,
				category: "1",
			}),
		});
		expect(created.res.status).toBe(200);
		const entry = await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name=? ORDER BY id DESC LIMIT 1",
		)
			.bind(name)
			.first<{ id: number }>();
		if (!entry) throw new Error("created cash entry missing");

		const split = await request(`/transactions/${entry.id}/split`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "part_category=1&part_category=2&part_amount=7.25&part_amount=12.75&back=%2Ftransactions",
		});
		expect(split.res.status).toBe(200);
		const before = {
			parent: await env.DB.prepare("SELECT * FROM transactions WHERE id=?")
				.bind(entry.id)
				.first(),
			parts: (
				await env.DB.prepare(
					"SELECT * FROM transactions WHERE parent_id=? ORDER BY id",
				)
					.bind(entry.id)
					.all()
			).results,
		};
		expect(before.parts).toHaveLength(2);

		const deleted = await request(`/transactions/${entry.id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=%2Ftransactions&confirm=1",
		});
		const feedback = JSON.parse(deleted.res.headers.get("HX-Trigger") ?? "{}");
		expect(deleted.res.status).toBe(200);
		expect(feedback.toast.message).toBe("Deleted Split market, $20.00.");
		expect(feedback.announce).toBe(
			"Deleted Split market, $20.00. Undo for 10 seconds.",
		);
		expect(feedback.toast.undo).toEqual(expect.any(String));

		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				token: feedback.toast.undo,
				back: "/transactions",
			}),
		});
		expect(restored.res.status).toBe(200);
		const restoredParent = await env.DB.prepare(
			"SELECT * FROM transactions WHERE raw_name=? AND is_split=1 ORDER BY id DESC LIMIT 1",
		)
			.bind(name)
			.first<Record<string, unknown>>();
		const restoredParts = (
			await env.DB.prepare(
				"SELECT * FROM transactions WHERE parent_id=? ORDER BY id",
			)
				.bind(restoredParent?.id)
				.all<Record<string, unknown>>()
		).results;
		const withoutIds = ({
			id: _id,
			parent_id: _parentId,
			...row
		}: Record<string, unknown>) => row;
		expect(restoredParent).not.toBeNull();
		expect(withoutIds(restoredParent as Record<string, unknown>)).toEqual(
			withoutIds(before.parent as Record<string, unknown>),
		);
		expect(restoredParts.map(withoutIds)).toEqual(
			(before.parts as Record<string, unknown>[]).map(withoutIds),
		);
	});

	it("is left out of Accounts and net worth", async () => {
		await env.DB.prepare(
			"UPDATE accounts SET balance_cents=99999999 WHERE type='cash'",
		).run();
		const { html } = await request("/accounts");
		expect(html).toContain("$15,768");
		expect(html).not.toContain("$1,015,768");
		expect(html).not.toContain("$999,999.99");
	});

	it("shows Accounts' empty state when cash is all there is", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE type<>'cash')",
			),
			env.DB.prepare("DELETE FROM accounts WHERE type<>'cash'"),
			env.DB.prepare("DELETE FROM plaid_items"),
		]);
		const { html } = await request("/accounts");
		expect(html).toContain("No banks linked yet.");
	});

	it("can be edited, excluded, and split", async () => {
		const cash = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' LIMIT 1",
		).first<{ id: number }>();
		expect(cash).not.toBeNull();
		await request(`/transactions/${cash?.id}`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "category=2&merchant=Cash+market&note=changed&excluded=1&back=%2Ftransactions",
		});
		expect(
			await env.DB.prepare(
				"SELECT raw_name,category_id,note,excluded FROM transactions WHERE id=?",
			)
				.bind(cash?.id)
				.first(),
		).toMatchObject({ category_id: 2, note: "changed", excluded: 1 });
		await request(`/transactions/${cash?.id}/split`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "part_category=1&part_category=2&part_amount=10&part_amount=10&back=%2Ftransactions",
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM transactions WHERE parent_id=?",
				)
					.bind(cash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});

	it("hides and rejects delete for a split part, then confirms and cascades a parent delete", async () => {
		const cash = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' LIMIT 1",
		).first<{ id: number }>();
		await request(`/transactions/${cash?.id}/split`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "part_category=1&part_category=2&part_amount=10&part_amount=10&back=%2Ftransactions",
		});
		const part = await env.DB.prepare(
			"SELECT id FROM transactions WHERE parent_id=? LIMIT 1",
		)
			.bind(cash?.id)
			.first<{ id: number }>();
		expect((await request(`/transactions/${part?.id}`)).html).not.toContain(
			"Delete cash transaction",
		);
		expect(
			(
				await request(`/transactions/${part?.id}/delete`, {
					method: "POST",
					headers: {
						Origin: BASE,
						"content-type": "application/x-www-form-urlencoded",
					},
					body: "back=/transactions&confirm=1",
				})
			).res.status,
		).toBe(404);
		const bill = await env.DB.prepare(
			"SELECT id FROM bills WHERE id NOT IN (SELECT bill_id FROM bill_payments WHERE period='2026-10' AND status='linked') LIMIT 1",
		).first<{
			id: number;
		}>();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, '2026-10', ?, 'user', 'linked')",
		)
			.bind(bill?.id, cash?.id)
			.run();
		const refund = await env.DB.prepare(`INSERT INTO transactions
			(account_id,date,amount_cents,raw_name,refund_of_id,flag_income,updated_by)
			SELECT id, '2026-10-06', -500, 'Cash refund', ?, 0, 'demo'
			FROM accounts WHERE type!='cash' LIMIT 1`)
			.bind(cash?.id)
			.run();
		const refundId = Number(refund.meta.last_row_id);
		const sheet = await request(`/transactions/${cash?.id}`);
		expect(sheet.html).toContain("Delete cash transaction");
		const bank = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type!='cash' LIMIT 1",
		).first<{ id: number }>();
		expect((await request(`/transactions/${bank?.id}`)).html).not.toContain(
			"Delete cash transaction",
		);
		const confirm = await request(`/transactions/${cash?.id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=/transactions",
		});
		expect(confirm.html).not.toContain("This can&#39;t be undone.");
		expect(confirm.html).toContain(">Keep it</a>");
		const safeBeforeDelete = (await request("/")).html
			.match(/Safe to spend<\/p>\s*<p[^>]*>(.*?)<\/p>/s)?.[1]
			?.trim();
		const deleted = await request(`/transactions/${cash?.id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=/transactions&confirm=1",
		});
		const feedback = JSON.parse(deleted.res.headers.get("HX-Trigger") ?? "{}");
		expect(deleted.res.status).toBe(200);
		expect(feedback.toast).toMatchObject({
			message: "Deleted Farmers market, $20.00.",
			undo: expect.any(String),
		});
		// The announcer says what was deleted and how long Undo lasts; focus goes to Undo (toast.js).
		expect(feedback.announce).toBe(
			"Deleted Farmers market, $20.00. Undo for 10 seconds.",
		);
		expect(
			await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
				.bind(cash?.id)
				.first(),
		).toBeNull();
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM transactions WHERE parent_id=?",
				)
					.bind(cash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				token: feedback.toast.undo,
				back: "/transactions",
			}),
		});
		expect(restored.res.status).toBe(200);
		expect(
			JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Farmers market is back.");
		const restoredCash = await env.DB.prepare(
			"SELECT id, raw_name, amount_cents, date FROM transactions WHERE raw_name='Farmers market' AND is_split=1 ORDER BY id DESC LIMIT 1",
		).first<{
			id: number;
			raw_name: string;
			amount_cents: number;
			date: string;
		}>();
		expect(restoredCash).toMatchObject({
			raw_name: "Farmers market",
			amount_cents: 2000,
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM transactions WHERE parent_id=?",
				)
					.bind(restoredCash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
		expect(
			(
				await env.DB.prepare("SELECT refund_of_id FROM transactions WHERE id=?")
					.bind(refundId)
					.first<{ refund_of_id: number }>()
			)?.refund_of_id,
		).toBe(restoredCash?.id);
		expect(
			(await request("/")).html
				.match(/Safe to spend<\/p>\s*<p[^>]*>(.*?)<\/p>/s)?.[1]
				?.trim(),
		).toBe(safeBeforeDelete);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM bill_payments WHERE transaction_id=?",
				)
					.bind(restoredCash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
		const reused = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				token: feedback.toast.undo,
				back: "/transactions",
			}),
		});
		expect(
			JSON.parse(reused.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("That cash entry is already back.");
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) n FROM transactions WHERE id=?")
					.bind(restoredCash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
	});

	it("refuses expired and unknown undo tokens without changing the deleted entry", async () => {
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Farmers market' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id;
		const deleted = await request(`/transactions/${id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=%2Ftransactions&confirm=1",
		});
		const token = JSON.parse(deleted.res.headers.get("HX-Trigger") ?? "{}")
			.toast.undo as string;
		await env.DB.prepare(
			"UPDATE cash_delete_holds SET created_at=? WHERE token=?",
		)
			.bind(Date.now() - 10_001, token)
			.run();
		for (const value of [token, crypto.randomUUID()]) {
			const refused = await request("/transactions/undo-cash-delete", {
				method: "POST",
				headers: {
					Origin: BASE,
					"HX-Request": "true",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ token: value, back: "/transactions" }),
			});
			expect(
				JSON.parse(refused.res.headers.get("HX-Trigger") ?? "{}").toast.type,
			).toBe("error");
			expect(
				JSON.parse(refused.res.headers.get("HX-Trigger") ?? "{}").toast.message,
			).toBe("Undo expired. The cash entry stays deleted.");
			// Both an expired and an unknown token name the Undo they answer (#444).
			expect(
				JSON.parse(refused.res.headers.get("HX-Trigger") ?? "{}").toast
					.undoDone,
			).toBe(value);
			expect(
				await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
					.bind(id)
					.first(),
			).toBeNull();
		}
	});

	it("restores the entry and its bill link beside the month's other payment", async () => {
		const id = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Farmers market' ORDER BY id DESC LIMIT 1",
			).first<{ id: number }>()
		)?.id;
		const bill = await env.DB.prepare(
			"SELECT id, name FROM bills WHERE id NOT IN (SELECT bill_id FROM bill_payments WHERE period='2026-10' AND status='linked') LIMIT 1",
		).first<{ id: number; name: string }>();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, '2026-10', ?, 'user', 'linked')",
		)
			.bind(bill?.id, id)
			.run();
		const deleted = await request(`/transactions/${id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=%2Ftransactions&confirm=1",
		});
		const token = JSON.parse(deleted.res.headers.get("HX-Trigger") ?? "{}")
			.toast.undo as string;
		const otherTransaction = await env.DB.prepare(
			"SELECT id FROM transactions WHERE id!=? LIMIT 1",
		)
			.bind(id)
			.first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, '2026-10', ?, 'user', 'linked')",
		)
			.bind(bill?.id, otherTransaction?.id)
			.run();
		const restored = await request("/transactions/undo-cash-delete", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ token, back: "/transactions" }),
		});
		const message = JSON.parse(restored.res.headers.get("HX-Trigger") ?? "{}")
			.toast.message;
		// A month takes more than one payment (decision 101), so the entry's payment comes back beside the other one.
		expect(message).toBe("Restored Farmers market.");
		expect(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Farmers market' ORDER BY id DESC LIMIT 1",
			).first(),
		).not.toBeNull();
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM bill_payments WHERE bill_id=? AND period='2026-10' AND status='linked'",
				)
					.bind(bill?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM bill_payments WHERE transaction_id=?",
				)
					.bind(id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	describe("asking before a cash entry is deleted (decision 84, Q57 B)", () => {
		const form = { "content-type": "application/x-www-form-urlencoded" };
		const ask = (id: number, back = "/transactions") =>
			request(`/transactions/${id}/delete`, {
				method: "POST",
				headers: { Origin: BASE, "HX-Request": "true", ...form },
				body: new URLSearchParams({ back }),
			});
		const farmersMarket = async () =>
			(
				await env.DB.prepare(
					"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.raw_name='Farmers market'",
				).first<{ id: number }>()
			)?.id as number;
		const dialog = (html: string) =>
			html.slice(html.indexOf('role="dialog"'), html.lastIndexOf("</section>"));
		const deleteForm = (html: string, id: number) => {
			const from = html.indexOf(`action="/transactions/${id}/delete"`);
			return html.slice(from, html.indexOf("</form>", from));
		};

		it("asks one sentence with the name and amount, where Cancel and Save were", async () => {
			const id = await farmersMarket();
			const { html } = await ask(id);
			expect(html).toContain("Delete Farmers market, $20.00?");
			// The edit form's own Cancel and Save are not there while it asks.
			expect(html).not.toContain('id="edit-save"');
			expect(html).not.toContain(">Save</span>");
			expect(html).not.toContain(">Cancel</a>");
			expect(html).not.toContain("Delete this cash entry?");
			expect(html).not.toContain("Delete cash transaction");
			// The question comes after the edit form's fields and is the end of the sheet.
			expect(html.indexOf("Rename or add a note")).toBeLessThan(
				html.indexOf("Delete Farmers market, $20.00?"),
			);
		});

		it("has Delete as the one primary button, in the delete form, and Keep it beside it", async () => {
			const id = await farmersMarket();
			const { html } = await ask(id);
			const deleting = deleteForm(html, id);
			expect(deleting).toContain('name="confirm" value="1"');
			expect(deleting).toContain("grid-cols-2");
			expect(deleting).toMatch(
				/<button[^>]*type="submit"[^>]*class="[^"]*bg-ink[^"]*"[^>]*>Delete<\/button>/,
			);
			expect(deleting).toMatch(
				new RegExp(
					`<a[^>]*href="/transactions/${id}"[^>]*class="[^"]*border-ink[^"]*"[^>]*>Keep it</a>`,
				),
			);
			// One submit button in the whole sheet that can be pressed: Delete.
			expect(
				dialog(html)
					.match(/<button[^>]*type="submit"[^>]*>/g)
					?.filter((b) => !/\sdisabled[\s>=]/.test(b)),
			).toHaveLength(1);
			expect(dialog(html).match(/<button[^>]*bg-ink/g)).toHaveLength(1);
			// Both are 44px targets.
			expect(deleting.match(/min-h-11/g)).toHaveLength(2);
		});

		it("can't save the edit form with Enter while it asks: the form's default button is disabled", async () => {
			const id = await farmersMarket();
			const { html } = await ask(id);
			const from = html.indexOf(`action="/transactions/${id}"`);
			const editing = html.slice(from, html.indexOf("</form>", from));
			// Enter in a text field presses the form's first submit button; a disabled one sends nothing.
			const first = editing.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
			expect(first).toMatch(/\sdisabled[\s>=]/);
			expect(first).toMatch(/\shidden[\s>=]/);
		});

		it("Keep it goes back to this entry's edit sheet with the same filters, as Cancel did", async () => {
			const id = await farmersMarket();
			const { html } = await ask(id, "/transactions?q=farmers");
			const keep = html.match(/<a[^>]*>Keep it<\/a>/)?.[0] ?? "";
			expect(keep).toContain(`href="/transactions/${id}?q=farmers"`);
			expect(keep).toContain(`hx-get="/transactions/${id}?q=farmers"`);
			expect(keep).toContain('hx-target="#page"');
			expect(keep).toContain('hx-select="#page"');
			expect(keep).toContain('hx-swap="outerHTML"');
		});

		it("announces the swap by moving focus to the question, not the title", async () => {
			const id = await farmersMarket();
			const { html } = await ask(id);
			const question =
				html.match(/<p[^>]*>Delete Farmers market, \$20\.00\?/)?.[0] ?? "";
			expect(question).toContain("autofocus");
			expect(question).toContain('tabindex="-1"');
			// Focusing it scrolls Delete and Keep it into view with it on a phone.
			expect(question).toContain("scroll-mb-24");
			expect(html.match(/<h2 id="edit-title"[^>]*>/)?.[0]).not.toContain(
				"autofocus",
			);
			// Only one thing takes focus, or htmx would pick the first.
			expect(html.match(/autofocus/g)).toHaveLength(1);
		});

		it("Keep it brings the normal sheet back, with Cancel and Save and the title focused", async () => {
			const id = await farmersMarket();
			const { html } = await request(`/transactions/${id}`, {
				headers: { "HX-Request": "true" },
			});
			expect(html).toContain('id="edit-save"');
			expect(html).toContain(">Save</span>");
			expect(html).toContain(">Cancel</a>");
			expect(html).toContain("Delete cash transaction");
			expect(html).not.toContain("This can&#39;t be undone.");
			expect(html).not.toContain(">Keep it</a>");
			expect(html.match(/<h2 id="edit-title"[^>]*>/)?.[0]).toContain(
				"autofocus",
			);
		});

		it("keeps the entry until Delete is pressed", async () => {
			const id = await farmersMarket();
			await ask(id);
			expect(
				await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
					.bind(id)
					.first(),
			).not.toBeNull();
		});
	});

	it("is counted by Home and budgets", async () => {
		const cash = await env.DB.prepare(
			"SELECT amount_cents FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND category_id=1 LIMIT 1",
		).first<{ amount_cents: number }>();
		expect(cash?.amount_cents).toBe(2000);
		const month = await loadMonth(
			env.DB,
			todayIn(DEFAULT_TIME_ZONE).slice(0, 7),
		);
		expect(month.transactions).toContainEqual(
			expect.objectContaining({
				categoryId: 1,
				amountCents: 2000,
				income: false,
			}),
		);
		expect((await request("/")).html).toMatch(/\$395\s+of\s+\$700/);
	});

	it("is never touched by a Plaid sync", async () => {
		const key = btoa("01234567890123456789012345678901");
		const encrypted = await encryptToken("token", key);
		const item = await env.DB.prepare(
			"INSERT INTO plaid_items(access_token_encrypted,institution_name,linked_by,plaid_item_id) VALUES(?,'Sync bank','demo','sync-bank') RETURNING id",
		)
			.bind(encrypted)
			.first<{ id: number }>();
		const cashBefore = await env.DB.prepare(
			"SELECT * FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE type='cash')",
		).all();
		const fetchImpl = vi.fn(
			async (url: RequestInfo | URL) =>
				new Response(
					JSON.stringify(
						String(url).endsWith("/accounts/get")
							? { accounts: [] }
							: {
									added: [],
									modified: [],
									removed: [{ transaction_id: "cash" }],
									next_cursor: "done",
									has_more: false,
								},
					),
					{ headers: { "content-type": "application/json" } },
				),
		);
		await syncItem(
			{ ...env, TOKEN_ENCRYPTION_KEY: key },
			item?.id as number,
			fetchImpl,
		);
		expect(
			(
				await env.DB.prepare(
					"SELECT * FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE type='cash')",
				).all()
			).results,
		).toEqual(cashBefore.results);
	});
});

describe("adding cash twice by retrying (a lost reply, a failed render)", () => {
	const KEY = "6f1c2a52-8c0e-4b5f-9d3a-0a1b2c3d4e5f";
	const post = (fields: Record<string, string>) =>
		request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				amount: "20.45",
				date: todayIn(DEFAULT_TIME_ZONE),
				merchant: "Retried market",
				category: "1",
				note: "",
				...fields,
			}),
		});
	const recorded = async () =>
		(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE raw_name='Retried market'",
			).first<{ n: number }>()
		)?.n;

	it("carries a one-time key in the form, new every time the form is drawn", async () => {
		const keyOf = (html: string) =>
			html.match(/<input type="hidden" name="entry_key" value="([^"]+)"/)?.[1];
		const first = keyOf((await request("/transactions/cash/new")).html);
		const second = keyOf((await request("/transactions/cash/new")).html);
		const uuid =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(first).toMatch(uuid);
		expect(second).toMatch(uuid);
		expect(second).not.toBe(first);
	});

	it("records one transaction when the same form is posted twice, and both answers are a success", async () => {
		const first = await post({ entry_key: KEY });
		const again = await post({ entry_key: KEY });
		expect(first.res.status).toBe(200);
		expect(again.res.status).toBe(200);
		const toast = (res: Response) =>
			JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		expect(toast(again.res)).toEqual(toast(first.res));
		expect(toast(again.res).toast.message).toBe("Added Retried market");
		expect(await recorded()).toBe(1);
	});

	const ofKey = (key = KEY) =>
		env.DB.prepare(
			"SELECT id, date, amount_cents, raw_name, category_id, note, is_split FROM transactions WHERE entry_key = ?",
		)
			.bind(key)
			.all<{
				id: number;
				date: string;
				amount_cents: number;
				raw_name: string;
				category_id: number;
				note: string | null;
				is_split: number;
			}>();

	it("changes nothing when the same key is posted again with different values: one row, the first values, and the reply names what was really saved", async () => {
		const first = await post({
			entry_key: KEY,
			note: "Peaches",
			amount: "20.45",
		});
		const saved = (await ofKey()).results;
		expect(saved).toHaveLength(1);
		// The reply was lost; the person changes the still-open form and taps Add again.
		const again = await post({
			entry_key: KEY,
			amount: "31.10",
			merchant: "Retried market, corrected",
			category: "2",
			date: "2026-10-02",
			note: "",
		});
		expect(again.res.status).toBe(200);
		expect((await ofKey()).results).toEqual(saved);
		expect(saved[0]).toMatchObject({
			amount_cents: 2045,
			raw_name: "Retried market",
			category_id: 1,
			note: "Peaches",
		});
		const triggers = (res: Response) =>
			JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		// The second reply is the first's: the stored row's words, not the form's.
		expect(triggers(again.res)).toEqual({
			toast: { message: "Added Retried market", type: "success" },
			announce: "Added $20.45 cash spending at Retried market.",
		});
		expect(triggers(again.res)).toEqual(triggers(first.res));
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'Retried market%'",
				).first<{ n: number }>()
			)?.n,
		).toBe(1);
	});

	it("leaves a split entry untouched by a repeat: the parent and its parts keep their amounts", async () => {
		await post({ entry_key: KEY, amount: "20.00" });
		const parent = (await ofKey()).results[0];
		const split = await saveSplit(
			env.DB,
			parent?.id as number,
			[
				{ categoryId: 1, amountCents: 1200 },
				{ categoryId: 2, amountCents: 800 },
			],
			"test",
		);
		expect(split.saved).toBe(true);
		const parts = () =>
			env.DB.prepare(
				"SELECT amount_cents, category_id FROM transactions WHERE parent_id = ? ORDER BY amount_cents",
			)
				.bind(parent?.id)
				.all();
		const before = await parts();
		expect(before.results).toHaveLength(2);
		const again = await post({ entry_key: KEY, amount: "99.00" });
		expect(again.res.status).toBe(200);
		const after = (await ofKey()).results;
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			id: parent?.id,
			amount_cents: 2000,
			is_split: 1,
		});
		expect((await parts()).results).toEqual(before.results);
		// The reply tells the truth about the saved entry, split or not.
		expect(
			JSON.parse(again.res.headers.get("HX-Trigger") ?? "{}").announce,
		).toBe("Added $20.00 cash spending at Retried market.");
	});

	it("records one transaction when the two posts arrive at once", async () => {
		const [a, b] = await Promise.all([
			post({ entry_key: KEY }),
			post({ entry_key: KEY }),
		]);
		expect([a.res.status, b.res.status]).toEqual([200, 200]);
		expect(await recorded()).toBe(1);
	});

	it("records a second transaction for a second form, even with the same words", async () => {
		await post({ entry_key: KEY });
		await post({ entry_key: "0b9d2f1e-3c4a-4d5e-8f60-71829a3b4c5d" });
		expect(await recorded()).toBe(2);
	});

	it("keeps the key to itself: it's a guard, never shown on the list", async () => {
		await post({ entry_key: KEY });
		const { html } = await request("/transactions");
		expect(html).not.toContain(KEY);
	});

	it.each([
		["a key that isn't a UUID", "not-a-uuid"],
		["an empty key", ""],
		["a key that is too long", `${KEY}${KEY}`],
	])("doesn't guard a post with %s, so it still saves", async (_label, key) => {
		await post({ entry_key: key });
		await post({ entry_key: key });
		expect(await recorded()).toBe(2);
	});

	it("doesn't guard a post with no key at all, as before", async () => {
		await post({});
		await post({});
		expect(await recorded()).toBe(2);
	});

	it("draws a fresh key when it sends the form back with an error", async () => {
		const { res, html } = await post({ entry_key: KEY, merchant: "" });
		expect(res.status).toBe(422);
		const key = html.match(
			/<input type="hidden" name="entry_key" value="([^"]+)"/,
		)?.[1];
		expect(key).toBeTruthy();
		expect(key).not.toBe(KEY);
		expect(await recorded()).toBe(0);
	});
});

describe("entryKeyOf", () => {
	it("accepts a UUID in either case and gives it back in lower case", () => {
		expect(entryKeyOf("6F1C2A52-8C0E-4B5F-9D3A-0A1B2C3D4E5F")).toBe(
			"6f1c2a52-8c0e-4b5f-9d3a-0a1b2c3d4e5f",
		);
	});

	it.each([
		null,
		undefined,
		"",
		"abc",
		" 6f1c2a52-8c0e-4b5f-9d3a-0a1b2c3d4e5f",
		5,
	])("gives nothing for %j", (raw) => {
		expect(entryKeyOf(raw)).toBeNull();
	});
});

describe("the cash form's Category group", () => {
	const form = async (category?: string) =>
		String(
			await CashForm({
				values: {
					amount: "5.00",
					date: "2026-10-05",
					merchant: "Bake sale",
					category: "",
					note: "",
				},
				errors: category ? { category } : {},
				categories: [
					{ id: 1, name: "Groceries", icon: "groceries", color: "cat-blue" },
				],
				today: "2026-10-05",
			}),
		);

	it("spaces its error 8px under the chips, as the chips sit 8px under the legend", async () => {
		const html = await form("Pick a category from the list.");
		// A legend is not a flex item, so a flex gap would not space it from the chips: both use mt-2.
		expect(html).toMatch(
			/<fieldset aria-describedby="cash-category-error"><legend>Category<\/legend><div class="mt-2 flex flex-wrap gap-2">/,
		);
		expect(html).toContain(
			'<p id="cash-category-error" role="alert" class="mt-2 text-sm text-over">Pick a category from the list.</p>',
		);
	});

	it("draws no error line when there is no error", async () => {
		const html = await form();
		expect(html).toMatch(
			/<fieldset><legend>Category<\/legend><div class="mt-2 flex flex-wrap gap-2">/,
		);
		expect(html).not.toContain("cash-category-error");
	});
});

describe("changing a split cash entry's parts (Change the parts)", () => {
	const today = () => todayIn(DEFAULT_TIME_ZONE);
	const post = (path: string, fields: [string, string][], htmx = true) =>
		request(path, {
			method: "POST",
			redirect: "manual",
			headers: {
				Origin: BASE,
				...(htmx ? { "HX-Request": "true" } : {}),
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
		});
	const idByName = async (merchant: string) =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name=? ORDER BY id DESC LIMIT 1",
			)
				.bind(merchant)
				.first<{ id: number }>()
		)?.id as number;
	const partsOf = async (id: number) =>
		(
			await env.DB.prepare(
				"SELECT id, category_id AS categoryId, amount_cents AS amountCents FROM transactions WHERE parent_id=? ORDER BY id",
			)
				.bind(id)
				.all<{ id: number; categoryId: number; amountCents: number }>()
		).results;
	const stateOf = async (id: number) => ({
		parent: await env.DB.prepare(
			"SELECT amount_cents AS amountCents, is_split AS isSplit FROM transactions WHERE id=?",
		)
			.bind(id)
			.first(),
		parts: await partsOf(id),
		refund: await env.DB.prepare(
			"SELECT refund_of_id AS refundOfId, amount_cents AS amountCents FROM transactions WHERE raw_name='Part refund'",
		).first(),
	});
	const spentThisMonth = async () => {
		const month = today().slice(0, 7);
		const data = await loadMonth(env.DB, month);
		return summarizeMonth({
			month,
			categories: data.categories,
			amounts: data.amounts,
			transactions: data.transactions,
			unpaidDueBillsCents: 0,
		}).totalSpentCents;
	};
	/**
	 * A $90.00 cash entry split into Groceries $60.00 (part A) and Household $30.00 (part B), with a
	 * $20.00 refund linked to B.
	 */
	const splitCash = async (merchant: string) => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today(),
				amount: "90.00",
				merchant,
				category: "1",
			}),
		});
		const id = await idByName(merchant);
		await saveSplit(
			env.DB,
			id,
			[
				{ amountCents: 6000, categoryId: 1 },
				{ amountCents: 3000, categoryId: 5 },
			],
			"demo",
		);
		const [a, b] = await partsOf(id);
		await env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,date,-2000,'Part refund',?,1 FROM transactions WHERE id=?",
		)
			.bind(b?.id, id)
			.run();
		return { id, a: a?.id as number, b: b?.id as number };
	};
	const BILL = 9950;
	/** How many of the bill's payments this month are the person's own Not this one on the transaction. */
	const dismissalsOn = async (transactionId: number) =>
		(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = ? AND period = ? AND transaction_id = ? AND matched_by = 'user' AND status = 'dismissed'",
			)
				.bind(BILL, today().slice(0, 7), transactionId)
				.first<{ n: number }>()
		)?.n;
	/** A monthly $30.00 bill paid by the cash entries of `merchant`, due on today's day of the month. */
	const insertCashBill = (bill: number, merchant: string) =>
		env.DB.prepare(
			"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (?, 'Cash bill', 3000, ?, 'monthly', NULL, NULL, ?, 1)",
		)
			.bind(bill, Number(today().slice(8, 10)), merchant)
			.run();
	/** A person's own Not this one on a transaction, for the bill's payment this month. */
	const notThisOne = (bill: number, transactionId: number) =>
		env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, ?, ?, 'user', 'dismissed')",
		)
			.bind(bill, today().slice(0, 7), transactionId)
			.run();
	/** Saves (or adds a part to) the correction sheet: a posted total of $100.00 over the saved $90.00. */
	const correction = (
		id: number,
		parts: [string, string, string][],
		{
			extra = [],
			total = "10000",
			amountWas = "9000",
		}: { extra?: [string, string][]; total?: string; amountWas?: string } = {},
	) =>
		post(`/transactions/${id}/split`, [
			["back", "/transactions"],
			["total", total],
			["amount_was", amountWas],
			...extra,
			...parts.flatMap(([partId, category, amount]) => [
				["part_id", partId] as [string, string],
				["part_category", category] as [string, string],
				["part_amount", amount] as [string, string],
			]),
		]);
	/** The saved parts, A and B, each at its own amount. */
	const savedParts = (a: number, b: number): [string, string, string][] => [
		[String(a), "1", "60.00"],
		[String(b), "5", "40.00"],
	];

	it("offers Change the parts when an amount breaks the parts, and saves nothing", async () => {
		const { id } = await splitCash("Parts refusal");
		const before = await stateOf(id);
		const { res, html } = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "100.00"],
			["back", "/transactions"],
		]);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"The parts add up to $90.00. Change them to match $100.00.",
		);
		expect(html).toMatch(
			/<button(?=[^>]*name="change_parts")(?=[^>]*value="1")[^>]*>Change the parts<\/button>/,
		);
		expect(html).not.toContain("split?total=");
		expect(await stateOf(id)).toEqual(before);
	});

	it("offers Change the parts when the parts change between the check and the save, and saves nothing more", async () => {
		const { id, a, b } = await splitCash("Parts change in save");
		const realBatch = env.DB.batch.bind(env.DB);
		// Another save moves part B to $40.00 after the check, in the save's own batch.
		const spy = vi
			.spyOn(env.DB, "batch")
			.mockImplementationOnce(async (statements) => {
				await env.DB.prepare(
					"UPDATE transactions SET amount_cents = 4000 WHERE id = ?",
				)
					.bind(b)
					.run();
				return realBatch(statements);
			});
		let batches = 0;
		const answer = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "90.00"],
			["back", "/transactions"],
		]).finally(() => {
			batches = spy.mock.calls.length;
			spy.mockRestore();
		});
		expect(batches).toBe(1);
		expect(answer.res.status).toBe(422);
		expect(answer.html).toContain(
			"The parts add up to $100.00. Change them to match $90.00.",
		);
		expect(answer.html).toMatch(
			/<button(?=[^>]*name="change_parts")(?=[^>]*value="1")[^>]*>Change the parts<\/button>/,
		);
		expect(answer.html).not.toContain("split?total=");
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 4000 },
		]);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ amountCents: 9000 });
	});

	it("offers no Change the parts for another amount error, or on a split entry that isn't refused", async () => {
		const { id } = await splitCash("No parts link");
		const zero = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "0"],
			["back", "/transactions"],
		]);
		expect(zero.res.status).toBe(422);
		expect(zero.html).toContain("Enter an amount greater than zero.");
		expect(zero.html).not.toContain("Change the parts");
		const panel = await request(`/transactions/${id}?back=%2Ftransactions`);
		expect(panel.res.status).toBe(200);
		expect(panel.html).not.toContain("Change the parts");
	});

	it("keeps the Change the parts sheet, with its new total, when a save is refused because the entry became income", async () => {
		const { id, a, b } = await splitCash("Income refusal");
		await env.DB.prepare("UPDATE transactions SET flag_income = 1 WHERE id = ?")
			.bind(id)
			.run();
		const { res, html } = await correction(id, savedParts(a, b));
		expect(res.status).toBe(422);
		expect(html).toContain("Income can&#39;t be split.");
		expect(html).toMatch(/<input[^>]*name="total"[^>]*value="10000"/);
		expect(html).toMatch(/<input[^>]*name="amount_was"[^>]*value="9000"/);
		// The amount under the title is the new total, as on the sheet that was posted.
		const shown = html.match(
			/id="split-title"[\s\S]*?<p class="font-serif text-4xl font-semibold">([^<]*)<\/p>/,
		)?.[1];
		expect(shown).toBe(formatCents(10000, { signed: true }));
	});

	it("opens the split with the new total, the saved parts and the mismatch and live lines", async () => {
		const { id, a, b } = await splitCash("Sheet");
		const { res, html } = await request(
			`/transactions/${id}/split?total=10000&back=%2Ftransactions`,
		);
		expect(res.status).toBe(200);
		// The amount under the title is the new total, not the saved $90.00.
		const shown = html.match(
			/id="split-title"[\s\S]*?<p class="font-serif text-4xl font-semibold">([^<]*)<\/p>/,
		)?.[1];
		expect(shown).toBe(formatCents(10000, { signed: true }));
		expect(shown).not.toBe(formatCents(9000, { signed: true }));
		expect(html).toMatch(/<option value="1" selected[^>]*>Groceries<\/option>/);
		expect(html).toMatch(/<option value="5" selected[^>]*>Household<\/option>/);
		expect(html).toContain('value="60.00"');
		expect(html).toContain('value="30.00"');
		expect(html).toMatch(
			new RegExp(`<input[^>]*name="part_id"[^>]*value="${a}"`),
		);
		expect(html).toMatch(
			new RegExp(`<input[^>]*name="part_id"[^>]*value="${b}"`),
		);
		expect(html).toMatch(/<input[^>]*name="total"[^>]*value="10000"/);
		expect(html).toMatch(/<input[^>]*name="amount_was"[^>]*value="9000"/);
		expect(html).toContain(
			"The parts add up to $90.00. Change them to match $100.00.",
		);
		expect(html).toContain("$10.00 left to assign");
	});

	it("says what is left against the new total as the parts change", async () => {
		const { id } = await splitCash("Live line");
		const left = await post(`/transactions/${id}/split/line`, [
			["total", "10000"],
			["part_amount", "60.00"],
			["part_amount", "30.00"],
		]);
		expect(left.html).toContain("$10.00 left to assign");
		const full = await post(`/transactions/${id}/split/line`, [
			["total", "10000"],
			["part_amount", "60.00"],
			["part_amount", "40.00"],
		]);
		expect(full.html).toContain("Adds up to $100.00");
	});

	it("saves the new total and the corrected parts together, keeping the split and the refund on its part", async () => {
		const { id, a, b } = await splitCash("Save corrected");
		const before = await spentThisMonth();
		const { res } = await correction(id, savedParts(a, b));
		expect(res.status).toBe(200);
		const trigger = JSON.parse(res.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast.type).toBe("success");
		expect(trigger.toast.message).toMatch(/^Split /);
		expect(trigger.toast.message).not.toContain("no longer linked");
		expect(trigger.announce).toMatch(/^Saved split for /);
		expect(trigger.announce).not.toContain("no longer linked");
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents, is_split AS isSplit FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({ amountCents: 10000, isSplit: 1 });
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 4000 },
		]);
		expect(
			await env.DB.prepare(
				"SELECT refund_of_id AS refundOfId FROM transactions WHERE raw_name='Part refund'",
			).first(),
		).toEqual({ refundOfId: b });
		expect((await spentThisMonth()) - before).toBe(1000);
	});

	/** The entry's own row, as the panel's save writes it, with the name the app shows for it. */
	const parentOf = async (id: number) => ({
		...(await env.DB.prepare(
			"SELECT amount_cents AS amountCents, date, note, excluded, kind FROM transactions WHERE id = ?",
		)
			.bind(id)
			.first()),
		displayName: (await getTransaction(env.DB, id))?.displayName,
	});
	const shiftDay = (date: string, days: number) => {
		const shifted = new Date(`${date}T00:00:00Z`);
		shifted.setUTCDate(shifted.getUTCDate() + days);
		return shifted.toISOString().slice(0, 10);
	};
	const unescapeAttribute = (value: string) =>
		value
			.replaceAll("&quot;", '"')
			.replaceAll("&#39;", "'")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&");
	/** The hidden fields in markup, as name and value, with the entities an attribute escapes undone. */
	const hiddenFields = (html: string): [string, string][] =>
		[
			...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g),
		].map(([, name = "", value = ""]): [string, string] => [
			name,
			unescapeAttribute(value),
		]);
	const pendingIn = (html: string) =>
		hiddenFields(html)
			.filter(([name]) => name === "pending_edit")
			.map(([, value]) => value);
	/** The hidden fields the edit panel of entry `id` draws, as its form posts them. */
	const panelFields = async (id: number) => {
		const { html } = await request(`/transactions/${id}?back=%2Ftransactions`);
		const start = html.indexOf(`action="/transactions/${id}"`);
		const end = html.indexOf(`action="/transactions/${id}/delete"`, start);
		return hiddenFields(html.slice(start, end));
	};
	const shownTotal = (html: string) =>
		html.match(
			/id="split-title"[\s\S]*?<p class="font-serif text-4xl font-semibold">([^<]*)<\/p>/,
		)?.[1];

	it("keeps the panel's other changes through Change the parts and saves them with the corrected parts", async () => {
		const { id, a, b } = await splitCash("Panel changes");
		const before = await parentOf(id);
		const earlier = shiftDay(today(), -2);
		const edits: [string, string][] = [
			["date", earlier],
			["amount", "100.00"],
			// A typed name counts only with Type your own ticked (decision 101).
			["name_pick", "own"],
			["merchant", "Corner Market"],
			["note", "Farmers market\nand bakery"],
			["excluded", "1"],
			["kind", "one_off"],
		];
		const drawn = (await panelFields(id)).filter(
			([name]) => !edits.some(([edit]) => edit === name),
		);
		const fields = [...drawn, ...edits];
		const pending = new URLSearchParams(fields).toString();

		const sheet = await post(`/transactions/${id}`, [
			...fields,
			["change_parts", "1"],
		]);
		expect(sheet.res.status).toBe(200);
		expect(shownTotal(sheet.html)).toBe(formatCents(10000, { signed: true }));
		expect(hiddenFields(sheet.html)).toEqual(
			expect.arrayContaining([
				["total", "10000"],
				["amount_was", "9000"],
				["part_id", String(a)],
				["part_id", String(b)],
			]),
		);
		expect(pendingIn(sheet.html)).toEqual([pending]);
		expect(await parentOf(id)).toEqual(before);

		const added = await correction(id, savedParts(a, b), {
			extra: [
				["add", "1"],
				["pending_edit", pending],
			],
		});
		expect(added.res.status).toBe(200);
		expect(added.html).toContain(
			`name="pending_edit" value="${pending.replaceAll("&", "&amp;")}"`,
		);
		expect(pendingIn(added.html)).toEqual([pending]);
		expect(
			hiddenFields(added.html).filter(([name]) => name === "part_id"),
		).toHaveLength(3);

		const saved = await correction(id, savedParts(a, b), {
			extra: [["pending_edit", pending]],
		});
		expect(saved.res.status).toBe(200);
		const trigger = JSON.parse(saved.res.headers.get("HX-Trigger") ?? "{}");
		expect(trigger.toast).toEqual({
			message: "Saved Corner Market",
			type: "success",
		});
		expect(trigger.announce).toMatch(/^Saved Corner Market\./);
		expect(await parentOf(id)).toEqual({
			amountCents: 10000,
			date: earlier,
			note: "Farmers market\nand bakery",
			excluded: 1,
			kind: "one_off",
			displayName: "Corner Market",
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT id, category_id AS categoryId, amount_cents AS amountCents, date, excluded FROM transactions WHERE parent_id = ? ORDER BY id",
				)
					.bind(id)
					.all()
			).results,
		).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000, date: earlier, excluded: 1 },
			{ id: b, categoryId: 5, amountCents: 4000, date: earlier, excluded: 1 },
		]);
		expect(
			await env.DB.prepare(
				"SELECT refund_of_id AS refundOfId FROM transactions WHERE raw_name='Part refund'",
			).first(),
		).toEqual({ refundOfId: b });
	});

	it("Change the parts with an amount that already matches the parts saves the panel as usual", async () => {
		const { id } = await splitCash("Matching amount");
		const { res, html } = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "90.00"],
			["name_pick", "own"],
			["merchant", "Corner Market"],
			["back", "/transactions"],
			["change_parts", "1"],
		]);
		expect(res.status).toBe(200);
		expect(html).not.toContain('id="split-title"');
		expect(
			JSON.parse(res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Saved Corner Market");
		expect(await parentOf(id)).toMatchObject({
			amountCents: 9000,
			displayName: "Corner Market",
		});
	});

	it("a refused correction keeps the pending edit", async () => {
		const { id, a, b } = await splitCash("Refused correction");
		const before = await parentOf(id);
		const pending = new URLSearchParams([
			["back", "/transactions"],
			["date", today()],
			["amount", "100.00"],
			["merchant", "Corner Market"],
			["note", "Farmers market\nand bakery"],
			["excluded", "1"],
		]).toString();

		// The parts add up to $90.00, not the new $100.00 total.
		const short = await correction(
			id,
			[
				[String(a), "1", "60.00"],
				[String(b), "5", "30.00"],
			],
			{ extra: [["pending_edit", pending]] },
		);
		expect(short.res.status).toBe(422);
		expect(pendingIn(short.html)).toEqual([pending]);
		expect(await parentOf(id)).toEqual(before);

		// Part 2's linked refund ($20.00) is more than its new $10.00.
		const refund = await correction(
			id,
			[
				[String(a), "1", "90.00"],
				[String(b), "5", "10.00"],
			],
			{ extra: [["pending_edit", pending]] },
		);
		expect(refund.res.status).toBe(422);
		expect(refund.html).toContain(
			"Linked refunds add up to $20.00, so part 2 can&#39;t be less than that.",
		);
		expect(pendingIn(refund.html)).toEqual([pending]);
		expect(await parentOf(id)).toEqual(before);
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 3000 },
		]);
	});

	it("a pending edit the panel then refuses reopens the panel with its error and the posted values", async () => {
		const { id, a, b } = await splitCash("Refused panel");
		const tomorrow = shiftDay(today(), 1);
		const pending = new URLSearchParams([
			["back", "/transactions"],
			["date", tomorrow],
			["amount", "100.00"],
			["merchant", "Corner Market"],
			["note", "Farmers market\nand bakery"],
			["excluded", "1"],
			["kind", "one_off"],
		]).toString();

		const { res, html } = await correction(id, savedParts(a, b), {
			extra: [["pending_edit", pending]],
		});
		// The correction saved the amount and the parts; the panel refused the future date.
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ amountCents: 10000 });
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 4000 },
		]);
		expect(res.status).toBe(422);
		expect(html).toContain("Choose today or an earlier date.");
		expect(html).toContain(`value="${tomorrow}"`);
		expect(html).toContain("Farmers market\nand bakery");
		expect(html).toMatch(/name="merchant"[^>]*value="Corner Market"/);
		expect(await parentOf(id)).toMatchObject({
			date: today(),
			excluded: 0,
		});
	});

	it("redirects a plain browser save back to the list", async () => {
		const { id, a, b } = await splitCash("Plain save");
		const { res } = await post(
			`/transactions/${id}/split`,
			[
				["back", "/transactions"],
				["total", "10000"],
				["amount_was", "9000"],
				["part_id", String(a)],
				["part_category", "1"],
				["part_amount", "60.00"],
				["part_id", String(b)],
				["part_category", "5"],
				["part_amount", "40.00"],
			],
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/transactions");
	});

	it("still refuses parts that don't add up to the new total, and saves nothing", async () => {
		const { id, a, b } = await splitCash("Still refused");
		const before = await stateOf(id);
		const { res, html } = await correction(id, [
			[String(a), "1", "60.00"],
			[String(b), "5", "30.00"],
		]);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"The parts must add up exactly to the transaction amount.",
		);
		expect(await stateOf(id)).toEqual(before);
	});

	it("refuses a part that a linked refund is more than, and saves nothing", async () => {
		const { id, a, b } = await splitCash("Part guard");
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -2500 WHERE refund_of_id = ?",
		)
			.bind(b)
			.run();
		const before = await stateOf(id);
		const { res, html } = await correction(id, [
			[String(a), "1", "80.00"],
			[String(b), "5", "20.00"],
		]);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"Linked refunds add up to $25.00, so part 2 can&#39;t be less than that.",
		);
		expect(await stateOf(id)).toEqual(before);
	});

	it("adds a part and keeps the total, the saved parts and their refund, then saves a third part", async () => {
		const { id, a, b } = await splitCash("Add part");
		const added = await correction(
			id,
			[
				[String(a), "1", "60.00"],
				[String(b), "5", "30.00"],
			],
			{ extra: [["add", "1"]] },
		);
		expect(added.res.status).toBe(200);
		expect(added.html).toMatch(/<input[^>]*name="total"[^>]*value="10000"/);
		expect(added.html).toMatch(/<input[^>]*name="amount_was"[^>]*value="9000"/);
		expect(added.html).toMatch(
			new RegExp(`<input[^>]*name="part_id"[^>]*value="${a}"`),
		);
		expect(added.html).toMatch(
			new RegExp(`<input[^>]*name="part_id"[^>]*value="${b}"`),
		);
		expect(added.html).toMatch(/<input[^>]*name="part_id"[^>]*value=""/);
		expect(added.html).toContain(
			"The parts add up to $90.00. Change them to match $100.00.",
		);
		expect((added.html.match(/name="part_id"/g) ?? []).length).toBe(3);
		const saved = await correction(id, [
			[String(a), "1", "60.00"],
			[String(b), "5", "30.00"],
			["", "2", "10.00"],
		]);
		expect(saved.res.status).toBe(200);
		const parts = await partsOf(id);
		expect(parts).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 3000 },
			{ id: expect.any(Number), categoryId: 2, amountCents: 1000 },
		]);
		expect(parts[2]?.id).toBeGreaterThan(b);
		expect(
			await env.DB.prepare(
				"SELECT refund_of_id AS refundOfId FROM transactions WHERE raw_name='Part refund'",
			).first(),
		).toEqual({ refundOfId: b });
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents FROM transactions WHERE id=?",
			)
				.bind(id)
				.first(),
		).toEqual({ amountCents: 10000 });
	});

	it("is only for a split cash entry, with a whole, positive total, and otherwise is not found", async () => {
		const { id, a, b } = await splitCash("Not allowed");
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today(),
				amount: "12.00",
				merchant: "Plain cash",
				category: "1",
			}),
		});
		const plain = await idByName("Plain cash");
		const bank = (
			await env.DB.prepare(
				"SELECT t.id FROM transactions t JOIN accounts ac ON ac.id = t.account_id WHERE ac.type <> 'cash' AND t.parent_id IS NULL AND t.is_split = 0 AND t.flag_income = 0 ORDER BY t.id LIMIT 1",
			).first<{ id: number }>()
		)?.id as number;
		const before = await stateOf(id);
		for (const target of [bank, a, plain]) {
			expect(
				(await request(`/transactions/${target}/split?total=10000`)).res.status,
			).toBe(404);
			expect((await correction(target, savedParts(a, b))).res.status).toBe(404);
		}
		for (const total of ["0", "-10000", "10000.5", "abc", ""]) {
			expect(
				(await request(`/transactions/${id}/split?total=${total}`)).res.status,
			).toBe(404);
			expect(
				(await correction(id, savedParts(a, b), { total })).res.status,
			).toBe(404);
		}
		expect(
			(await correction(id, savedParts(a, b), { amountWas: "abc" })).res.status,
		).toBe(404);
		expect(await stateOf(id)).toEqual(before);
	});

	it("is not found when a posted part id isn't a whole number, in the save or in Add a part, and saves nothing", async () => {
		const { id, a } = await splitCash("Bad part id");
		const before = await stateOf(id);
		const tampered: [string, string, string][] = [
			[String(a), "1", "60.00"],
			["abc", "5", "40.00"],
		];
		expect((await correction(id, tampered)).res.status).toBe(404);
		expect(
			(await correction(id, tampered, { extra: [["add", "1"]] })).res.status,
		).toBe(404);
		expect(await stateOf(id)).toEqual(before);
	});

	it("saves nothing when the posted parts or the amount are out of date, and the save is an error", async () => {
		const { id, a, b } = await splitCash("Out of date");
		const before = await stateOf(id);
		const foreign = (
			await env.DB.prepare(
				"SELECT t.id FROM transactions t WHERE t.parent_id IS NULL AND t.is_split = 0 AND t.id <> ? ORDER BY t.id LIMIT 1",
			)
				.bind(id)
				.first<{ id: number }>()
		)?.id as number;
		const cases: { name: string; run: () => Promise<{ res: Response }> }[] = [
			{
				name: "a saved part is missing",
				run: () =>
					correction(id, [
						[String(a), "1", "60.00"],
						["", "5", "40.00"],
					]),
			},
			{
				name: "a part id that isn't one of its parts is posted",
				run: () =>
					correction(id, [
						[String(a), "1", "60.00"],
						[String(b), "5", "30.00"],
						[String(foreign), "2", "10.00"],
					]),
			},
			{
				name: "a saved part is posted twice",
				run: () =>
					correction(id, [
						[String(a), "1", "60.00"],
						[String(a), "5", "40.00"],
					]),
			},
			{
				name: "the parent's amount is no longer the one drawn",
				run: () => correction(id, savedParts(a, b), { amountWas: "8000" }),
			},
		];
		for (const testCase of cases) {
			const { res } = await testCase.run();
			expect(res.status, testCase.name).toBe(500);
			expect(await stateOf(id), testCase.name).toEqual(before);
		}
	});

	it("refuses a correction when a part was added at the same moment, and writes nothing from it", async () => {
		const { id, a, b } = await splitCash("Racing part");
		const db = {
			prepare: env.DB.prepare.bind(env.DB),
			batch: async (statements: D1PreparedStatement[]) => {
				// Another same-total correction lands first: part A is $50.00 and a $10.00 part is added.
				await env.DB.prepare(
					"UPDATE transactions SET amount_cents = 5000 WHERE id = ?",
				)
					.bind(a)
					.run();
				await env.DB.prepare(
					`INSERT INTO transactions
					(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, parent_id, updated_by)
				SELECT account_id, date, 1000, raw_name, merchant_name, 1, 'user', id, 'demo' FROM transactions WHERE id = ?`,
				)
					.bind(id)
					.run();
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		await expect(
			correctCashSplit(
				db,
				id,
				{
					totalCents: 10000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 6000 },
						{ id: b, categoryId: 5, amountCents: 4000 },
					],
				},
				"demo",
			),
		).rejects.toThrow("changed while it was being corrected");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
				)
					.bind(id)
					.first<{ amountCents: number }>()
			)?.amountCents,
		).toBe(9000);
		expect((await partsOf(id)).map((part) => part.amountCents)).toEqual([
			5000, 3000, 1000,
		]);
	});

	it("saves a correction that adds two new parts at once", async () => {
		const { id, a, b } = await splitCash("Two new parts");
		await expect(
			correctCashSplit(
				env.DB,
				id,
				{
					totalCents: 10000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 5000 },
						{ id: b, categoryId: 5, amountCents: 3000 },
						{ id: null, categoryId: 1, amountCents: 1000 },
						{ id: null, categoryId: 5, amountCents: 1000 },
					],
				},
				"demo",
			),
		).resolves.toEqual({ saved: true });
		expect((await partsOf(id)).map((part) => part.amountCents)).toEqual([
			5000, 3000, 1000, 1000,
		]);
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
				)
					.bind(id)
					.first<{ amountCents: number }>()
			)?.amountCents,
		).toBe(10000);
	});

	it("refuses a correction with two new parts when another part is added at the same moment, and writes nothing", async () => {
		const { id, a, b } = await splitCash("Racing two new parts");
		const db = {
			prepare: env.DB.prepare.bind(env.DB),
			batch: async (statements: D1PreparedStatement[]) => {
				// A $10.00 part is added after the sheet was read.
				await env.DB.prepare(
					`INSERT INTO transactions
					(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, parent_id, updated_by)
				SELECT account_id, date, 1000, raw_name, merchant_name, 1, 'user', id, 'demo' FROM transactions WHERE id = ?`,
				)
					.bind(id)
					.run();
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		await expect(
			correctCashSplit(
				db,
				id,
				{
					totalCents: 10000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 5000 },
						{ id: b, categoryId: 5, amountCents: 3000 },
						{ id: null, categoryId: 1, amountCents: 1000 },
						{ id: null, categoryId: 5, amountCents: 1000 },
					],
				},
				"demo",
			),
		).rejects.toThrow("changed while it was being corrected");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
				)
					.bind(id)
					.first<{ amountCents: number }>()
			)?.amountCents,
		).toBe(9000);
		expect((await partsOf(id)).map((part) => part.amountCents)).toEqual([
			6000, 3000, 1000,
		]);
	});

	it("refuses a same-total correction with two new parts when another part is added at the same moment, and writes nothing", async () => {
		const { id, a, b } = await splitCash("Racing same total");
		const db = {
			prepare: env.DB.prepare.bind(env.DB),
			batch: async (statements: D1PreparedStatement[]) => {
				// Another same-total correction lands first: part A is $50.00 and a $10.00 part is added.
				await env.DB.prepare(
					"UPDATE transactions SET amount_cents = 5000 WHERE id = ?",
				)
					.bind(a)
					.run();
				await env.DB.prepare(
					`INSERT INTO transactions
					(account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source, parent_id, updated_by)
				SELECT account_id, date, 1000, raw_name, merchant_name, 1, 'user', id, 'demo' FROM transactions WHERE id = ?`,
				)
					.bind(id)
					.run();
				return env.DB.batch(statements);
			},
		} as unknown as D1Database;
		await expect(
			correctCashSplit(
				db,
				id,
				{
					totalCents: 9000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 4000 },
						{ id: b, categoryId: 5, amountCents: 3000 },
						{ id: null, categoryId: 1, amountCents: 1000 },
						{ id: null, categoryId: 5, amountCents: 1000 },
					],
				},
				"demo",
			),
		).rejects.toThrow("changed while it was being corrected");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
				)
					.bind(id)
					.first<{ amountCents: number }>()
			)?.amountCents,
		).toBe(9000);
		expect((await partsOf(id)).map((part) => part.amountCents)).toEqual([
			5000, 3000, 1000,
		]);
	});

	/** Archives a category, as Settings does: entries that already use it keep it. */
	const archive = (categoryId: number) =>
		env.DB.prepare(
			"UPDATE categories SET archived = 1, archived_on = ? WHERE id = ?",
		)
			.bind(today(), categoryId)
			.run();
	/** The category select of part `index` (0-based) in the sheet's HTML. */
	const selectOf = (html: string, index: number) =>
		html.match(
			new RegExp(`<select id="part-category-${index}"[\\s\\S]*?</select>`),
		)?.[0] ?? "";

	it("keeps a saved part's archived category in its own select, and in no other row's", async () => {
		const { id, b } = await splitCash("Archived sheet");
		await archive(5);
		const { res, html } = await request(
			`/transactions/${id}/split?total=10000&back=%2Ftransactions`,
		);
		expect(res.status).toBe(200);
		expect(selectOf(html, 0)).not.toMatch(/<option value="5"/);
		expect(selectOf(html, 1)).toMatch(
			/<option value="5" selected[^>]*>Household<\/option>/,
		);
		expect(html).toMatch(
			new RegExp(`<input[^>]*name="part_id"[^>]*value="${b}"`),
		);
	});

	it("saves a correction that still has a saved part on its archived category, which it keeps", async () => {
		const { id, a, b } = await splitCash("Keeps archived");
		await archive(5);
		const { res } = await correction(id, savedParts(a, b));
		expect(res.status).toBe(200);
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 6000 },
			{ id: b, categoryId: 5, amountCents: 4000 },
		]);
	});

	it("refuses an archived category on a part that doesn't keep it, and on a new part, with nothing saved", async () => {
		const { id, a, b } = await splitCash("Archived refused");
		await archive(5);
		const before = await stateOf(id);
		const onSaved = await correction(id, [
			[String(a), "5", "60.00"],
			[String(b), "5", "40.00"],
		]);
		expect(onSaved.res.status).toBe(422);
		expect(onSaved.html).toContain("Pick a category for part 1.");
		const onNew = await correction(id, [
			[String(a), "1", "60.00"],
			[String(b), "5", "30.00"],
			["", "5", "10.00"],
		]);
		expect(onNew.res.status).toBe(422);
		expect(onNew.html).toContain("Pick a category for part 3.");
		expect(await stateOf(id)).toEqual(before);
	});

	it("keeps B's archived option when the sheet is drawn again with Add a part or with an error", async () => {
		const { id, a, b } = await splitCash("Redrawn archived");
		await archive(5);
		const added = await correction(id, savedParts(a, b), {
			extra: [["add", "1"]],
		});
		expect(added.res.status).toBe(200);
		expect(selectOf(added.html, 1)).toMatch(
			/<option value="5" selected[^>]*>Household<\/option>/,
		);
		expect(selectOf(added.html, 2)).not.toMatch(/<option value="5"/);
		const failed = await correction(id, [
			[String(a), "1", "60.00"],
			[String(b), "5", "30.00"],
			["", "", "10.00"],
		]);
		expect(failed.res.status).toBe(422);
		expect(selectOf(failed.html, 1)).toMatch(
			/<option value="5" selected[^>]*>Household<\/option>/,
		);
	});

	/** A refund linked to the entry itself, not to a part: $85.00, or `cents` when given. */
	const linkEntryRefund = (id: number, cents = 8500) =>
		env.DB.prepare(
			"INSERT INTO transactions (account_id,date,amount_cents,raw_name,refund_of_id,credit_reviewed) SELECT account_id,date,?,'Entry refund',?,1 FROM transactions WHERE id=?",
		)
			.bind(-cents, id, id)
			.run();

	it("refuses a split correction whose total is below the refunds linked to the entry and its part together, with the words in the sheet and nothing saved", async () => {
		const { id, a, b } = await splitCash("Entry refund sheet");
		await linkEntryRefund(id);
		const before = await stateOf(id);
		const { res, html } = await correction(
			id,
			[
				[String(a), "1", "50.00"],
				[String(b), "5", "30.00"],
			],
			{ total: "8000", amountWas: "9000" },
		);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"Linked refunds add up to $105.00, so the amount can&#39;t be less than that.",
		);
		expect(await stateOf(id)).toEqual(before);
	});

	it("refuses an amount below the refunds linked to the entry and its part in the edit panel, with no Change the parts, and saves nothing", async () => {
		const { id } = await splitCash("Entry refund panel");
		await linkEntryRefund(id);
		const before = await stateOf(id);
		const { res, html } = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "80.00"],
			["back", "/transactions"],
		]);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"Linked refunds add up to $105.00, so the amount can&#39;t be less than that.",
		);
		expect(html).not.toContain("Change the parts");
		expect(await stateOf(id)).toEqual(before);
	});

	it("refuses a split correction whose total is below the refunds linked to the entry and its parts together, with the words in the sheet and nothing saved", async () => {
		const { id, a, b } = await splitCash("Family refunds sheet");
		await linkEntryRefund(id, 6500);
		const before = await stateOf(id);
		const { res, html } = await correction(
			id,
			[
				[String(a), "1", "50.00"],
				[String(b), "5", "30.00"],
			],
			{ total: "8000", amountWas: "9000" },
		);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"Linked refunds add up to $85.00, so the amount can&#39;t be less than that.",
		);
		expect(await stateOf(id)).toEqual(before);
	});

	it("refuses an amount below the refunds linked to the entry and its parts together in the edit panel, with no Change the parts, and saves nothing", async () => {
		const { id } = await splitCash("Family refunds panel");
		await linkEntryRefund(id, 6500);
		const before = await stateOf(id);
		const { res, html } = await post(`/transactions/${id}`, [
			["date", today()],
			["amount", "80.00"],
			["back", "/transactions"],
		]);
		expect(res.status).toBe(422);
		expect(html).toContain(
			"Linked refunds add up to $85.00, so the amount can&#39;t be less than that.",
		);
		expect(html).not.toContain("Change the parts");
		expect(await stateOf(id)).toEqual(before);
	});

	it("reports the refunds of the entry and its parts together from correctCashSplit, and saves nothing", async () => {
		const { id, a, b } = await splitCash("Family refunds direct");
		await linkEntryRefund(id, 6500);
		const before = await stateOf(id);
		await expect(
			correctCashSplit(
				env.DB,
				id,
				{
					totalCents: 8000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 5000 },
						{ id: b, categoryId: 5, amountCents: 3000 },
					],
				},
				"demo",
			),
		).resolves.toEqual({ saved: false, refundTotalCents: 8500 });
		expect(await stateOf(id)).toEqual(before);
	});

	it("saves a correction whose total covers the refunds linked to the entry and its parts together, and keeps each refund's link", async () => {
		const { id, a, b } = await splitCash("Family refunds saved");
		await linkEntryRefund(id, 6500);
		const { res } = await correction(
			id,
			[
				[String(a), "1", "55.00"],
				[String(b), "5", "30.00"],
			],
			{ total: "8500", amountWas: "9000" },
		);
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ amountCents: 8500 });
		expect(await partsOf(id)).toEqual([
			{ id: a, categoryId: 1, amountCents: 5500 },
			{ id: b, categoryId: 5, amountCents: 3000 },
		]);
		const links = await env.DB.prepare(
			"SELECT raw_name AS name, refund_of_id AS refundOfId FROM transactions WHERE raw_name IN ('Entry refund', 'Part refund') ORDER BY raw_name",
		).all<{ name: string; refundOfId: number }>();
		expect(links.results).toEqual([
			{ name: "Entry refund", refundOfId: id },
			{ name: "Part refund", refundOfId: b },
		]);
	});

	it("gives a part added to a split cash entry the unlink date its parent carries", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today(),
				amount: "90.00",
				merchant: "Unlinked cash entry",
				category: "1",
			}),
		});
		const id = await idByName("Unlinked cash entry");
		await env.DB.prepare(
			"UPDATE transactions SET refund_unlinked_purchase_date = '2026-09-10' WHERE id = ?",
		)
			.bind(id)
			.run();
		await saveSplit(
			env.DB,
			id,
			[
				{ amountCents: 6000, categoryId: 1 },
				{ amountCents: 3000, categoryId: 5 },
			],
			"demo",
		);
		const [a, b] = await partsOf(id);

		await expect(
			correctCashSplit(
				env.DB,
				id,
				{
					totalCents: 10000,
					amountWasCents: 9000,
					parts: [
						{ id: a?.id as number, categoryId: 1, amountCents: 6000 },
						{ id: b?.id as number, categoryId: 5, amountCents: 3000 },
						{ id: null, categoryId: 5, amountCents: 1000 },
					],
				},
				"demo",
			),
		).resolves.toEqual({ saved: true });
		expect(
			await env.DB.prepare(
				"SELECT amount_cents AS amountCents, refund_unlinked_purchase_date AS d FROM transactions WHERE parent_id = ? AND id NOT IN (?, ?)",
			)
				.bind(id, a?.id, b?.id)
				.first(),
		).toEqual({ amountCents: 1000, d: "2026-09-10" });
	});

	it("gives a part that Change the parts adds the purchase's own Not this one, so the bill doesn't link to it", async () => {
		await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: today(),
				amount: "90.00",
				merchant: "Not this one part",
				category: "1",
			}),
		});
		const id = await idByName("Not this one part");
		await insertCashBill(BILL, "Not this one part");
		await notThisOne(BILL, id);
		await saveSplit(
			env.DB,
			id,
			[
				{ amountCents: 6000, categoryId: 1 },
				{ amountCents: 3000, categoryId: 5 },
			],
			"demo",
		);
		const [partA, partB] = await partsOf(id);
		const a = partA?.id as number;
		const b = partB?.id as number;
		expect([await dismissalsOn(a), await dismissalsOn(b)]).toEqual([1, 1]);

		await expect(
			correctCashSplit(
				env.DB,
				id,
				{
					totalCents: 12000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 6000 },
						{ id: b, categoryId: 5, amountCents: 3000 },
						{ id: null, categoryId: 5, amountCents: 3000 },
					],
				},
				"demo",
			),
		).resolves.toEqual({ saved: true });
		const added = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE parent_id = ? AND id NOT IN (?, ?)",
			)
				.bind(id, a, b)
				.first<{ id: number }>()
		)?.id as number;
		expect([
			await dismissalsOn(added),
			await dismissalsOn(a),
			await dismissalsOn(b),
			await dismissalsOn(id),
		]).toEqual([1, 1, 1, 1]);

		// The bill's payment this month matches the new part's amount and date, but the part starts dismissed.
		await matchBillPayments(env.DB, today());
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id = ? AND status = 'linked'",
			)
				.bind(added)
				.first(),
		).toEqual({ n: 0 });
	});

	it("refuses a correction that adds a part and writes no Not this one for it when a part's refund no longer fits", async () => {
		const { id, a, b } = await splitCash("Refused new part");
		await insertCashBill(BILL, "Refused new part");
		// The purchase gets its own Not this one after the split, so neither part has one yet.
		await notThisOne(BILL, id);
		const rowCount = async () =>
			(
				await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_payments").first<{
					n: number;
				}>()
			)?.n;
		const before = await rowCount();

		// Part B keeps the $20.00 refund linked to it, so $15.00 can't hold it and the whole batch is refused.
		await expect(
			correctCashSplit(
				env.DB,
				id,
				{
					totalCents: 9000,
					amountWasCents: 9000,
					parts: [
						{ id: a, categoryId: 1, amountCents: 6000 },
						{ id: b, categoryId: 5, amountCents: 1500 },
						{ id: null, categoryId: 5, amountCents: 1500 },
					],
				},
				"demo",
			),
		).resolves.toEqual({
			saved: false,
			refundPart: { part: 2, refundCents: 2000 },
		});
		expect(await rowCount()).toBe(before);
	});
});

describe("a bank transaction split into parts", () => {
	it("shows the bank's notice on the transaction, not on its parts", async () => {
		const bank = await env.DB.prepare(
			"SELECT t.id, t.amount_cents AS amountCents, p.institution_name AS bank FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN plaid_items p ON p.id=a.plaid_item_id WHERE t.parent_id IS NULL AND t.is_split = 0 AND a.type <> 'cash' AND ABS(t.amount_cents) >= 2 ORDER BY t.id LIMIT 1",
		).first<{ id: number; amountCents: number; bank: string }>();
		const amount = bank?.amountCents as number;
		const half = Math.trunc(amount / 2);
		await saveSplit(
			env.DB,
			bank?.id as number,
			[
				{ amountCents: half, categoryId: 1 },
				{ amountCents: amount - half, categoryId: 5 },
			],
			"demo",
		);
		const [part] = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE parent_id = ? ORDER BY id",
			)
				.bind(bank?.id)
				.all<{ id: number }>()
		).results;
		const parentPanel = await request(`/transactions/${bank?.id}`);
		expect(parentPanel.html).toContain(
			`From ${bank?.bank}. Its date and amount stay as the bank sent them.`,
		);
		const partPanel = await request(`/transactions/${part?.id}`);
		expect(partPanel.res.status).toBe(200);
		expect(partPanel.html).not.toContain(
			"Its date and amount stay as the bank sent them",
		);
	});
});
