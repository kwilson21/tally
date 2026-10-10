import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
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
		expect(sheet.html).toContain(`href="${back}"`);
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
			expect(
				await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
					.bind(id)
					.first(),
			).toBeNull();
		}
	});

	it("restores the entry but names a bill link that became unavailable", async () => {
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
		expect(message).toContain(
			`${bill?.name} payment no longer fits and was left off.`,
		);
		expect(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name='Farmers market' ORDER BY id DESC LIMIT 1",
			).first(),
		).not.toBeNull();
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
