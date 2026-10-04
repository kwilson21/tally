import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayUtc } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

const BASE = "http://tally.test";

async function request(path: string, init?: RequestInit) {
	const res = await exports.default.fetch(BASE + path, init);
	return { res, html: await res.text() };
}

beforeEach(() => resetDemo(env.DB, todayUtc()));

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
		expect(html).toContain(`max="${todayUtc()}"`);
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
					date: todayUtc(),
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
				date: todayUtc(),
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
				date: todayUtc(),
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
		const bill = await env.DB.prepare("SELECT id FROM bills LIMIT 1").first<{
			id: number;
		}>();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?, '2099-01', ?, 'user', 'linked')",
		)
			.bind(bill?.id, cash?.id)
			.run();
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
		expect(confirm.html).toContain("Delete this cash entry?");
		expect(confirm.html).toContain(">Cancel</a>");
		const deleted = await request(`/transactions/${cash?.id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=/transactions&confirm=1",
		});
		expect(deleted.res.status).toBe(200);
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
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) n FROM bill_payments WHERE transaction_id=?",
				)
					.bind(cash?.id)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("is counted by Home and budgets", async () => {
		const cash = await env.DB.prepare(
			"SELECT amount_cents FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND category_id=1 LIMIT 1",
		).first<{ amount_cents: number }>();
		expect(cash?.amount_cents).toBe(2000);
		const month = await loadMonth(env.DB, todayUtc().slice(0, 7));
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
