import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Plaid's merchant name is the merchant's first suggested name (spec §8.6, decision 68, issue #194):
// sync stores it, with no AI call, and a person still has to choose it.

const KEY = btoa("01234567890123456789012345678901");

const transaction = (overrides: Record<string, unknown> = {}) => ({
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name: "SQ *BLUE BOTTLE COF 0412",
	merchant_name: "Blue Bottle Coffee",
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
	...overrides,
});

const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

async function addItem() {
	const encrypted = await encryptToken("secret-access-token", KEY);
	const result = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();
	return result?.id as number;
}

/** A sync whose one page holds these transactions, on the same account every time. */
async function sync(
	id: number,
	{
		added = [],
		modified = [],
	}: { added?: unknown[]; modified?: unknown[] } = {},
) {
	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return response({
				accounts: [
					{
						account_id: "account-1",
						name: "Everyday",
						mask: "1234",
						type: "depository",
						subtype: "checking",
						balances: { current: 10 },
					},
				],
			});
		}
		return response({
			added,
			modified,
			removed: [],
			next_cursor: crypto.randomUUID(),
			has_more: false,
		});
	});
	await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
}

type MerchantRow = {
	raw_name: string;
	suggested_name: string | null;
	display_name: string | null;
	suggestion_status: string;
};

const merchants = async () =>
	(
		await env.DB.prepare(
			"SELECT raw_name, suggested_name, display_name, suggestion_status FROM merchants ORDER BY raw_name",
		).all<MerchantRow>()
	).results;

describe("Plaid's merchant name as the first name suggestion", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM household_settings WHERE key = 'ai_names'"),
		]);
	});

	it("suggests Plaid's name for a merchant whose shown name differs, pending, and renames nothing", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });

		expect(await merchants()).toEqual([
			{
				raw_name: "Blue Bottle Coffee",
				suggested_name: "Blue Bottle Coffee",
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("makes no suggestion when Plaid sent no merchant name, or a blank one", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ transaction_id: "none", merchant_name: null }),
				transaction({ transaction_id: "blank", merchant_name: "  " }),
				transaction({ transaction_id: "missing", merchant_name: undefined }),
			],
		});
		expect(await merchants()).toEqual([]);
	});

	it("makes no suggestion when Plaid's name is what the list already shows", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				// The tidied bank text is "Target": nothing to suggest.
				transaction({
					transaction_id: "tidy",
					name: "TARGET 1234",
					merchant_name: "Target",
				}),
				// The bank text is already the name.
				transaction({
					transaction_id: "same",
					name: "Netflix",
					merchant_name: "Netflix",
				}),
			],
		});
		expect(await merchants()).toEqual([]);
	});

	it("still suggests a name that differs from the tidied text only in capitals", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ name: "T-MOBILE 8812", merchant_name: "T-Mobile" }),
			],
		});
		expect((await merchants()).map((m) => m.suggested_name)).toEqual([
			"T-Mobile",
		]);
	});

	it("suggests it on a modified transaction too", async () => {
		const id = await addItem();
		await sync(id, {
			added: [transaction({ merchant_name: null })],
		});
		expect(await merchants()).toEqual([]);

		await sync(id, { modified: [transaction()] });
		expect(await merchants()).toMatchObject([
			{ raw_name: "Blue Bottle Coffee", suggestion_status: "pending" },
		]);
	});

	it("never replaces a name a person chose, and leaves its status alone", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'The Bottle', 'none')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toEqual([
			{
				raw_name: "Blue Bottle Coffee",
				suggested_name: null,
				display_name: "The Bottle",
				suggestion_status: "none",
			},
		]);
	});

	it("does not suggest again to someone who already decided (accepted or rejected)", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'Blue Bottle Coffee', 'rejected')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Lupitas', 'Lupitas', 'accepted')",
			),
		]);
		await sync(id, {
			added: [
				transaction(),
				transaction({
					transaction_id: "lupitas",
					name: "SQ *LUPITAS TAQ 2210",
					merchant_name: "Lupitas",
				}),
			],
		});
		expect((await merchants()).map((m) => m.suggestion_status)).toEqual([
			"rejected",
			"accepted",
		]);
	});

	it("puts Plaid's name in front of an older suggestion that is still waiting", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'Blue Bottle', 'pending')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{
				suggested_name: "Blue Bottle Coffee",
				suggestion_status: "pending",
			},
		]);
	});

	it("is the same row however many transactions bring the name", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ transaction_id: "a", name: "SQ *BLUE BOTTLE COF 0412" }),
				transaction({ transaction_id: "b", name: "SQ *BLUE BOTTLE COF 0777" }),
			],
		});
		await sync(id, {
			added: [
				transaction({ transaction_id: "c", name: "BLUE BOTTLE OAKLAND" }),
			],
		});
		expect(await merchants()).toHaveLength(1);
	});

	it("gives a corrected Plaid name its own suggestion, so the newest name is the one the transaction shows", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });
		await sync(id, {
			modified: [transaction({ merchant_name: "Blue Bottle" })],
		});
		const row = await env.DB.prepare(
			`SELECT m.suggested_name FROM transactions t
			 JOIN merchants m ON m.raw_name = COALESCE(NULLIF(t.merchant_name, ''), t.raw_name)`,
		).first<{ suggested_name: string }>();
		expect(row?.suggested_name).toBe("Blue Bottle");
	});

	it("is a bank fact: still suggested with the merchant names switch off", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('ai_names', 'off')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{ suggested_name: "Blue Bottle Coffee", suggestion_status: "pending" },
		]);
	});

	it("follows a copied row: a name a person gave the bank text carries over and nothing is suggested over it", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('SQ *BLUE BOTTLE COF 0412', 'My coffee place')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{
				raw_name: "Blue Bottle Coffee",
				display_name: "My coffee place",
				suggested_name: null,
				suggestion_status: "none",
			},
			{ raw_name: "SQ *BLUE BOTTLE COF 0412" },
		]);
	});
});
