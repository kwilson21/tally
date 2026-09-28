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

async function post(id: number | string, body = "", htmx = false) {
	return accounts.request(
		`/accounts/${id}/disconnect`,
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...(htmx ? { "HX-Request": "true" } : {}),
			},
			body,
		},
		bindings,
	);
}

/** A linked bank with this many accounts, the first holding this many transactions. */
async function bankWith(accountCount: number, transactionCount: number) {
	const item = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (?, 'Count Bank', 'person') RETURNING id",
	)
		.bind(await encryptToken("count-access-token", KEY))
		.first<{ id: number }>();
	if (!item) throw new Error("no item");
	const accountIds: number[] = [];
	for (let i = 0; i < accountCount; i++) {
		const account = await env.DB.prepare(
			"INSERT INTO accounts (plaid_item_id, name, type) VALUES (?, 'Checking', 'depository') RETURNING id",
		)
			.bind(item.id)
			.first<{ id: number }>();
		if (account) accountIds.push(account.id);
	}
	for (let i = 0; i < transactionCount; i++) {
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (?, '2026-09-01', 100, 'COFFEE')",
		)
			.bind(accountIds[0])
			.run();
	}
	return item.id;
}

const sentence = async (id: number) =>
	(
		await (
			await accounts.request(`/accounts/${id}/disconnect`, {}, bindings)
		).text()
	).match(/Tally stops syncing it\.[^<]*/)?.[0];

const countFor = async (id: number) =>
	(
		await env.DB.prepare(
			"SELECT COUNT(*) count FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?)",
		)
			.bind(id)
			.first<{ count: number }>()
	)?.count;

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
		expect(html).toContain("unless you tick the box below");
		expect(html).toContain("This deletes them for good.");
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

	it("counts accounts and transactions once each, singular or plural", async () => {
		expect(await sentence(await bankWith(1, 1))).toBe(
			"Tally stops syncing it. Its 1 account and 1 transaction stay, so past months still add up, unless you tick the box below.",
		);
		expect(await sentence(await bankWith(2, 0))).toBe(
			"Tally stops syncing it. Its 2 accounts and 0 transactions stay, so past months still add up, unless you tick the box below.",
		);
	});

	it("ties the delete warning to the checkbox", async () => {
		const html = await (
			await accounts.request(
				`/accounts/${await itemId()}/disconnect`,
				{},
				bindings,
			)
		).text();
		expect(html).toMatch(/aria-describedby="delete-hint"/);
		expect(html).toMatch(/id="delete-hint"[^>]*>This deletes them for good\./);
	});

	it("returns 404 for an item id that isn't a number", async () => {
		expect(
			(await accounts.request("/accounts/1abc/disconnect", {}, bindings))
				.status,
		).toBe(404);
		expect((await post("1abc")).status).toBe(404);
	});

	it("posts with htmx and says so, with a plain-post fallback", async () => {
		const html = await (
			await accounts.request(
				`/accounts/${await itemId()}/disconnect`,
				{},
				bindings,
			)
		).text();
		expect(html).toMatch(/<form[^>]*method="post"/);
		expect(html).toMatch(/<form[^>]*hx-post="\/accounts\/\d+\/disconnect"/);
		expect(html).toMatch(/<form[^>]*hx-target="#main"/);
	});

	it("answers htmx with the Accounts page, a toast and an announcement", async () => {
		const id = await itemId();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const response = await post(id, "", true);
		expect(response.status).toBe(200);
		expect(response.headers.get("HX-Push-Url")).toBe("/accounts");
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Disconnected First Harbor Bank.", type: "success" },
			announce: "Disconnected First Harbor Bank.",
		});
		const html = await response.text();
		expect(html).toContain('id="main"');
		expect(html).toContain("Disconnected");
		expect(html).not.toContain(`/accounts/${id}/disconnect`);
	});

	it("says when the history was deleted too", async () => {
		const id = await itemId();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		const response = await post(id, "delete=yes", true);
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: {
				message: "Disconnected First Harbor Bank and deleted its history.",
				type: "success",
			},
			announce: "Disconnected First Harbor Bank and deleted its history.",
		});
	});

	it("doesn't delete kept history when a second submit asks to delete it", async () => {
		const id = await itemId();
		const before = await countFor(id);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({})),
		);
		expect((await post(id)).status).toBe(303);
		const response = await post(id, "delete=yes", true);
		expect(response.status).toBe(200);
		expect(response.headers.get("HX-Trigger")).toContain(
			"First Harbor Bank is already disconnected.",
		);
		expect(await countFor(id)).toBe(before);
		expect(before).toBeGreaterThan(0);
	});

	it("doesn't delete history when another tab keeps it while Plaid is answering", async () => {
		const id = await itemId();
		const before = await countFor(id);
		// Tab A (keep) finishes while tab B (delete) is waiting on Plaid.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await env.DB.prepare(
					"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
				)
					.bind(id)
					.run();
				return Response.json({});
			}),
		);
		const response = await post(id, "delete=yes", true);
		expect(response.headers.get("HX-Trigger")).toContain(
			"First Harbor Bank is already disconnected.",
		);
		expect(await countFor(id)).toBe(before);
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) count FROM accounts WHERE plaid_item_id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ count: 2 });
	});

	it("says so when Plaid let go but Tally couldn't finish, and a retry finishes", async () => {
		const id = await itemId();
		const plaid = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", plaid);
		const batch = vi
			.spyOn(env.DB, "batch")
			.mockRejectedValueOnce(new Error("D1 unavailable"));
		const failed = await post(id, "delete=yes", true);
		expect(failed.status).toBe(502);
		const html = await failed.text();
		expect(html).toMatch(
			/role="alert"[^>]*>Your bank was disconnected at Plaid, but Tally couldn&#39;t finish\. Try again\./,
		);
		expect(html).toMatch(/name="delete" value="yes" checked/);
		expect(
			await env.DB.prepare(
				"SELECT disconnected_at FROM plaid_items WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toEqual({ disconnected_at: null });
		batch.mockRestore();
		plaid.mockImplementation(async () =>
			Response.json({ error_code: "ITEM_NOT_FOUND" }, { status: 400 }),
		);
		const retried = await post(id, "delete=yes", true);
		expect(retried.status).toBe(200);
		expect(retried.headers.get("HX-Trigger")).toContain(
			"Disconnected First Harbor Bank and deleted its history.",
		);
		expect(await countFor(id)).toBe(0);
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
		// A plain browser follows the redirect; htmx gets the toast (tested above).
		expect(response.headers.get("HX-Trigger")).toBeNull();
		const row = await env.DB.prepare(
			"SELECT status, length(access_token_encrypted) token_length FROM plaid_items WHERE id = ?",
		)
			.bind(id)
			.first();
		expect(row).toMatchObject({ status: "ok", token_length: 0 });
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
		).toEqual({ status: "ok" });
	});
});
