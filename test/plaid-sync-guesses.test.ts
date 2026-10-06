import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Names Workers AI suggested are saved under each bank text (spec §7). When Plaid later gives several bank
// texts one merchant name, sync starts that merchant's row as a copy of the first text's row, and a waiting
// suggestion on another text's row must not be lost along the way.

const KEY = btoa("01234567890123456789012345678901");
const T1 = "TARGET 1234";
const T2 = "TARGET #55";
// Plaid's name for both, which is only each text tidied, so Plaid has nothing to suggest and the names
// Workers AI made are what a person could still choose.
const PLAID = "Target";

const transaction = (
	id: string,
	name: string,
	merchantName: string | null,
) => ({
	transaction_id: id,
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name,
	merchant_name: merchantName,
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
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

async function sync(id: number, added: unknown[]) {
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
			modified: [],
			removed: [],
			next_cursor: crypto.randomUUID(),
			has_more: false,
		});
	});
	await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
}

const row = (key: string) =>
	env.DB.prepare(
		"SELECT suggested_name, display_name, suggestion_status FROM merchants WHERE raw_name = ?",
	)
		.bind(key)
		.first<{
			suggested_name: string | null;
			display_name: string | null;
			suggestion_status: string;
		}>();

const GUESSES = "Target Stores\nTarget Corp";

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
});

describe("a waiting suggestion survives Plaid naming several bank texts one merchant", () => {
	it("takes the names from the second text's row when the first copied has none", async () => {
		const id = await addItem();
		await env.DB.batch([
			// Asked about, nothing usable: the empty answer that stops it being asked again.
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: GUESSES,
			display_name: null,
			suggestion_status: "pending",
		});
	});

	it("does the same whichever text comes first, and when the first text was never asked about", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
		)
			.bind(T2, GUESSES)
			.run();
		// T1 has no row at all, so T2's is the only one to carry.
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect((await row(PLAID))?.suggestion_status).toBe("pending");
		expect((await row(PLAID))?.suggested_name).toBe(GUESSES);
	});

	it("keeps the first row's waiting names when both have some, so one set is still there to choose", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'First Names', 'pending')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({
			suggested_name: "First Names",
			suggestion_status: "pending",
		});
	});

	it("never revives a suggestion a person already decided, or touches a name a person chose", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ suggestion_status: "rejected" });

		await env.DB.batch([
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("c", T1, PLAID), transaction("d", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("leaves a merchant that has no waiting names on any text as it was", async () => {
		const id = await addItem();
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toBeNull();
	});
});
