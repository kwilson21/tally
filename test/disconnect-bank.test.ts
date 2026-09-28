import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayUtc } from "../src/dates";
import { accountsByBank, netWorthCents } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";
import { encryptToken } from "../src/plaid/token-crypto";
import { accounts } from "../src/routes/accounts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const bindings = {
	...env,
	DEMO: "false",
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: KEY,
} as unknown as Env;

async function itemId() {
	const row = await env.DB.prepare(
		"SELECT id FROM plaid_items WHERE institution_name = 'First Harbor Bank'",
	).first<{ id: number }>();
	if (!row) throw new Error("missing seed item");
	await env.DB.prepare(
		"UPDATE plaid_items SET access_token_encrypted = ? WHERE id = ?",
	)
		.bind(await encryptToken("secret-access-token", KEY), row.id)
		.run();
	return row.id;
}

async function post(id: number, body = "") {
	return accounts.request(
		`/accounts/${id}/disconnect`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		},
		bindings,
	);
}

describe("disconnect bank", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayUtc());
		vi.restoreAllMocks();
	});

	it("shows the confirmation, but hides Manage and returns 404 in the demo", async () => {
		const id = await itemId();
		const response = await accounts.request(
			`/accounts/${id}/disconnect`,
			{},
			bindings,
		);
		const html = await response.text();
		expect(html).toContain("Disconnect First Harbor Bank?");
		expect(html).toContain("Also delete its accounts and transactions");
		expect(
			(
				await accounts.request(
					`/accounts/${id}/disconnect`,
					{},
					{ ...bindings, DEMO: "true" },
				)
			).status,
		).toBe(404);
		expect(
			await (
				await accounts.request("/accounts", {}, { ...bindings, DEMO: "true" })
			).text(),
		).not.toContain("Manage");
	});

	it("keeps history, blanks the token, marks the bank, and excludes it from net worth", async () => {
		const id = await itemId();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ request_id: "request" })),
		);
		const response = await post(id);
		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/accounts");
		expect(response.headers.get("HX-Trigger")).toContain(
			"Disconnected First Harbor Bank.",
		);
		const row = await env.DB.prepare(
			"SELECT status, length(access_token_encrypted) token_length FROM plaid_items WHERE id = ?",
		)
			.bind(id)
			.first();
		expect(row).toEqual({ status: "disconnected", token_length: 0 });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) count FROM accounts WHERE plaid_item_id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ count: 2 });
		const banks = await accountsByBank(env.DB);
		expect(banks[0]?.disconnected).toBe(true);
		expect(netWorthCents(banks.flatMap((bank) => bank.accounts))).toBe(-84217);
	});

	it("deletes transactions, balance history, and accounts together when requested", async () => {
		const id = await itemId();
		await env.DB.prepare(
			"INSERT INTO balance_history (account_id, date, balance_cents) VALUES (1, '2026-01-01', 1)",
		).run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		expect((await post(id, "delete=yes")).status).toBe(303);
		for (const table of ["transactions", "balance_history", "accounts"]) {
			const row = await env.DB.prepare(
				`SELECT COUNT(*) count FROM ${table} WHERE ${table === "accounts" ? "plaid_item_id" : "account_id"} IN (${table === "accounts" ? "?" : "SELECT id FROM accounts WHERE plaid_item_id = ?"})`,
			)
				.bind(id)
				.first<{ count: number }>();
			expect(row?.count).toBe(0);
		}
	});

	it("leaves everything unchanged on a Plaid failure", async () => {
		const id = await itemId();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ error_code: "INTERNAL_SERVER_ERROR" }, { status: 500 }),
			),
		);
		const response = await post(id, "delete=yes");
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('role="alert"');
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ status: "ok" });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) count FROM accounts WHERE plaid_item_id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ count: 2 });
	});

	it("finishes when Plaid says the item is already gone", async () => {
		const id = await itemId();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ error_code: "ITEM_NOT_FOUND" }, { status: 400 }),
			),
		);
		expect((await post(id)).status).toBe(303);
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ status: "disconnected" });
	});
});
