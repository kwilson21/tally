import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

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
			/href="\/transactions\/cash\/new"[^>]*>[\s\S]*?Add cash<\/a>/,
		);
		const { html } = await request("/transactions/cash/new");
		expect(html).toContain("Add cash spending");
		expect(html).toContain(`max="${todayUtc()}"`);
		expect(html).toContain('name="direction" value="out" checked');
		expect(html).toContain('name="amount"');
		expect(html).toContain('name="merchant"');
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
					direction: "out",
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
			"SELECT amount_cents, plaid_transaction_id, category_source, updated_by FROM transactions WHERE raw_name='Farmers market'",
		).first();
		expect(tx).toMatchObject({
			amount_cents: 2045,
			plaid_transaction_id: null,
			category_source: "user",
			updated_by: "demo",
		});
	});

	it("validates future dates and fields with alerts", async () => {
		const { res, html } = await request("/transactions/cash", {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "date=2999-01-01&amount=nope&direction=out&merchant=&category=999",
		});
		expect(res.status).toBe(422);
		expect((html.match(/role="alert"/g) ?? []).length).toBeGreaterThanOrEqual(
			3,
		);
	});

	it("redirects after a non-htmx save and records money in as negative", async () => {
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
				direction: "in",
				merchant: "Refund",
				category: "1",
				note: "",
			}),
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents FROM transactions WHERE raw_name='Refund'",
				).first<{ amount_cents: number }>()
			)?.amount_cents,
		).toBe(-800);
	});
});

describe("cash lifecycle", () => {
	it("is shown outside banks and excluded from net worth", async () => {
		const { html } = await request("/accounts");
		expect(html).toContain("Cash · not in net worth");
		expect(html.indexOf("Cash · not in net worth")).toBeGreaterThan(
			html.lastIndexOf("Northline Card Services"),
		);
	});

	it("can be edited, excluded, split and deleted, while Plaid rows cannot be deleted", async () => {
		const cash = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' LIMIT 1",
		).first<{ id: number }>();
		expect(cash).not.toBeNull();
		const sheet = await request(`/transactions/${cash?.id}`);
		expect(sheet.html).toContain("Delete cash transaction");
		const bank = await env.DB.prepare(
			"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type!='cash' LIMIT 1",
		).first<{ id: number }>();
		expect((await request(`/transactions/${bank?.id}`)).html).not.toContain(
			"Delete cash transaction",
		);
		const deleted = await request(`/transactions/${cash?.id}/delete`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: "back=/transactions",
		});
		expect(deleted.res.status).toBe(200);
		expect(
			await env.DB.prepare("SELECT id FROM transactions WHERE id=?")
				.bind(cash?.id)
				.first(),
		).toBeNull();
	});
});
