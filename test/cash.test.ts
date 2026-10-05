import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { entryKeyOf } from "../src/transactions/cash";

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

	it("saves what the form says now when the same key is posted again with changes, still as one transaction", async () => {
		const ofKey = () =>
			env.DB.prepare(
				"SELECT id, date, amount_cents, raw_name, category_id, note, category_source, flag_income, updated_by FROM transactions WHERE entry_key = ?",
			)
				.bind(KEY)
				.all();
		const yesterday = "2026-10-02";
		await post({ entry_key: KEY, note: "Peaches" });
		const first = (await ofKey()).results;
		expect(first).toHaveLength(1);
		// The reply was lost; the person fixes the still-open form and taps Add again.
		const again = await post({
			entry_key: KEY,
			amount: "31.10",
			merchant: "Retried market, corrected",
			category: "2",
			date: yesterday,
			note: "",
		});
		expect(again.res.status).toBe(200);
		expect(
			JSON.parse(again.res.headers.get("HX-Trigger") ?? "{}").toast.message,
		).toBe("Added Retried market, corrected");
		const rows = (await ofKey()).results;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			// Still the same transaction.
			id: first[0]?.id,
			amount_cents: 3110,
			raw_name: "Retried market, corrected",
			category_id: 2,
			date: yesterday,
			note: null,
			category_source: "user",
			flag_income: 0,
			updated_by: "demo",
		});
		expect(
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE raw_name LIKE 'Retried market%'",
				).first<{ n: number }>()
			)?.n,
		).toBe(1);
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
