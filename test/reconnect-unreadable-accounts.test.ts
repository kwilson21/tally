import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemo } from "../src/demo/reset";
import { accountsOf, runReconnectReminders } from "../src/reconnect/reminders";

// A bank's stored accounts are read before its reminder is claimed (decision 233). Accounts the stored JSON cannot give are
// skipped: no claim, no send, one failed delivery named "accounts unreadable", and the other banks still go out.

const TODAY = new Date("2026-10-07T13:00:00Z");
const NEXT_DAY = new Date("2026-10-08T13:00:00Z");

type BankRow = {
	id: number;
	institution_name: string;
	last_synced_at: string | null;
	reconnect_emailed_at: string | null;
	accounts: string | null;
};

/**
 * The database with the stored accounts of some banks replaced by the text given, as a stored value that cannot be read
 * would come back from the reminders' SELECT. Every other statement is the real one.
 */
function withStoredAccounts(texts: Record<number, string | null>): D1Database {
	const db = env.DB;

	const standIn = {
		prepare(sql: string) {
			if (!sql.includes("json_group_array(json_object('name'"))
				return db.prepare(sql);

			return {
				all: async () => {
					const result = await db.prepare(sql).all<BankRow>();

					return {
						...result,
						results: result.results.map((row) =>
							row.id in texts
								? { ...row, accounts: texts[row.id] ?? null }
								: row,
						),
					};
				},
			};
		},
	};

	// SAFETY: runReconnectReminders calls only prepare(...) with all() on the bank SELECT and with bind, first or run on the
	// other statements; the stand-in forwards each of those to the real database, so only the SELECT's rows differ.
	return standIn as D1Database;
}

/** Each send, as the address it went to and the words it carried. */
function recordSends() {
	const sends: { to: string; body: string }[] = [];

	const fetchImpl: typeof fetch = async (_url, init) => {
		const body = String(init?.body ?? "");

		// SAFETY: deliver posts a JSON body whose `to` is the recipient's address (src/reconnect/deliver.ts).
		const { to } = JSON.parse(body) as { to: string };

		sends.push({ to, body });

		return new Response("{}");
	};

	return { sends, fetchImpl };
}

const production = (db: D1Database) => ({
	DB: db,
	DEMO: "false",
	RESEND_API_KEY: "test-key",
});

async function addBanks() {
	await env.DB.prepare(
		"INSERT INTO household_members (email) VALUES ('dana@example.com')",
	).run();
	// The bad bank has the lower id, so the run reaches it first.
	await env.DB.prepare(
		"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (931, 'Chase', X'', 'dana@example.com', 'needs_attention')",
	).run();
	await env.DB.prepare(
		"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (932, 'Wells Fargo', X'', 'dana@example.com', 'needs_attention')",
	).run();
	await env.DB.prepare(
		"INSERT INTO accounts (plaid_item_id, name, mask, type, balance_cents) VALUES (932, 'Checking', '4521', 'depository', 123456)",
	).run();
}

const claimOf = async (id: number) =>
	(
		await env.DB.prepare(
			"SELECT reconnect_emailed_at FROM plaid_items WHERE id = ?",
		)
			.bind(id)
			.first<{ reconnect_emailed_at: string | null }>()
	)?.reconnect_emailed_at ?? null;

beforeEach(async () => resetDemo(env.DB, "2026-10-07"));

describe("a bank whose stored accounts cannot be read", () => {
	it("keeps its reminder unclaimed and sends nothing for it", async () => {
		await addBanks();
		const { sends, fetchImpl } = recordSends();

		await runReconnectReminders(
			production(withStoredAccounts({ 931: '{"name":"Checking"' })),
			fetchImpl,
			TODAY,
		);

		expect(await claimOf(931)).toBeNull();
		expect(sends.some(({ body }) => body.includes("Chase"))).toBe(false);
	});

	it("still sends another bank's reminder in the same run", async () => {
		await addBanks();
		const { sends, fetchImpl } = recordSends();

		await runReconnectReminders(
			production(withStoredAccounts({ 931: "not json" })),
			fetchImpl,
			TODAY,
		);

		expect(sends).toHaveLength(1);
		expect(sends[0]?.body).toContain("Wells Fargo");
		expect(await claimOf(932)).not.toBeNull();
	});

	it("sends the bad bank's reminder on a later run once its accounts can be read", async () => {
		await addBanks();
		const first = recordSends();

		await runReconnectReminders(
			production(withStoredAccounts({ 931: '[{"name":1,"mask":null}]' })),
			first.fetchImpl,
			TODAY,
		);

		const second = recordSends();

		await runReconnectReminders(production(env.DB), second.fetchImpl, NEXT_DAY);

		expect(second.sends).toHaveLength(1);
		expect(second.sends[0]?.body).toContain("Chase");
		expect(await claimOf(931)).not.toBeNull();
	});

	it("logs the fixed failure kind, and no bank or account name", async () => {
		await addBanks();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { fetchImpl } = recordSends();

		try {
			await runReconnectReminders(
				production(withStoredAccounts({ 931: "[1" })),
				fetchImpl,
				TODAY,
			);

			const lines = errors.mock.calls.map((call) => String(call[0]));

			expect(lines).toContain(
				"reconnect reminders: 1 sent, 1 failed (accounts unreadable)",
			);
			expect(
				lines.some((line) => /Chase|Wells Fargo|Checking/.test(line)),
			).toBe(false);
		} finally {
			errors.mockRestore();
		}
	});

	it("still sends a bank whose stored accounts are empty or null", async () => {
		await addBanks();
		const { sends, fetchImpl } = recordSends();

		await runReconnectReminders(
			production(withStoredAccounts({ 931: "", 932: null })),
			fetchImpl,
			TODAY,
		);

		expect(sends.map(({ to }) => to)).toEqual([
			"dana@example.com",
			"dana@example.com",
		]);
		expect(await claimOf(931)).not.toBeNull();
		expect(await claimOf(932)).not.toBeNull();
	});

	it("reads empty and null text as no accounts, and refuses text that is not JSON", () => {
		expect(accountsOf("")).toEqual([]);
		expect(accountsOf(null)).toEqual([]);
		expect(accountsOf("[]")).toEqual([]);
		expect(accountsOf("not json")).toBeNull();
		expect(accountsOf('[{"name":"Checking","mask":"4521","id":3}]')).toEqual([
			{ name: "Checking", mask: "4521", id: 3 },
		]);
	});
});
