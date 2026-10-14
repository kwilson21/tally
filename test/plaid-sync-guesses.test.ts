import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAskedNames } from "../src/db/merchant-names";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Names Workers AI suggested are saved under each bank text (spec §7). When Plaid later gives several bank
// texts one merchant name, sync starts that merchant's row from their rows: each choice a person made (a name,
// a rule, Not a bill) comes from the first text that has it, and the suggestion comes from one row. Workers AI is
// asked only about texts Plaid doesn't name (decision 68), and a Plaid name that is only the text tidied has
// nothing to suggest (decision 79), so a guess made for a text is not left waiting on the merchant Plaid
// named, whichever text's row it was on.

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

describe("a guess made for a bank text does not wait on the merchant Plaid names", () => {
	it("takes the other text's guess over the empty answer, then clears it, since Plaid's name is only the text tidied", async () => {
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
		// The waiting guess is the bare suggestion, so the shared key copies it; the page then clears it as stale.
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
		// The text's own row keeps its guess for any charge that still has no Plaid name.
		expect((await row(T2))?.suggestion_status).toBe("pending");
	});

	it("keeps the other text's name, rule and Not a bill on the shared key when the empty answer comes first", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Tea', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
			).bind(T2, category?.id),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(
			await env.DB.prepare(
				"SELECT display_name, default_category_id, not_a_bill FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({
			display_name: "My tea",
			default_category_id: category?.id,
			not_a_bill: 1,
		});
	});

	it("ends with a person's name from one bank text and a rule from the other on the shared key", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Snacks', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
			).bind(T2, category?.id),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(
			await env.DB.prepare(
				"SELECT display_name, default_category_id FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({ display_name: "My coffee", default_category_id: category?.id });
	});

	it("takes a decided suggestion over the empty answer that comes first, with its name and status together", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "Old Guess",
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("takes a decided suggestion over a bare guess that comes first, with its name and status together", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "Old Guess",
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("never copies a waiting guess onto a merchant a person named, when the guess's text comes first", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("never copies a waiting guess onto a merchant a person named, when the named text holds only the empty answer", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, suggested_name, suggestion_status) VALUES (?, 'My coffee', '', 'none')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "",
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("clears the guess copied from a text's row, whichever text comes first", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
		)
			.bind(T2, GUESSES)
			.run();
		// T1 has no row at all, so T2's is the one copied.
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("clears the first row's guess when both have some", async () => {
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
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("copies the first text that has a row, even when an earlier text has none", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
		)
			.bind(T2)
			.run();
		// T1 comes first and has no row; T2's is the first there is, so its name carries over.
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ display_name: "My coffee" });
	});

	it("copies the configured row of the second text when the first text's name call failed, so a failure leaves no row to copy", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Coffee', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		// T1's name call failed. The failure is kept apart from merchants (#468), so T1 gets no row here.
		await saveAskedNames(env.DB, [], [T1]);
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My coffee', ?, 1)",
		)
			.bind(T2, category?.id)
			.run();
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ display_name: "My coffee" });
		expect(
			await env.DB.prepare(
				"SELECT default_category_id, not_a_bill FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({ default_category_id: category?.id, not_a_bill: 1 });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE raw_name = ?",
			)
				.bind(T1)
				.first(),
		).toEqual({ n: 0 });
	});

	it("never changes a suggestion a person already decided, or a name a person chose", async () => {
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
