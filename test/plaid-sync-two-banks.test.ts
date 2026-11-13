import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { present } from "./helpers/present";

// Two banks' syncs running at the same moment (#1048): two webhooks arriving together, or banks synced side by side in
// one run. A merchant both name must end up as some one-after-the-other order would leave it, never as a mix of the two.

const KEY = btoa("01234567890123456789012345678901");

/** A JSON value, as a Plaid answer holds it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const response = (body: Json) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** One charge on a page: the bank's text and Plaid's name for it, and its id and day when the test cares. */
type Charge = { text: string; name: string; id?: string; date?: string };

type Bank = { id: number; account: string };

async function addBank(account: string): Promise<Bank> {
	const row = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(await encryptToken(`token-${account}`, KEY), crypto.randomUUID())
		.first<{ id: number }>();

	return { id: present(row).id, account };
}

/**
 * One bank's sync over these pages, one charge each. `before(n)` runs just before page n is answered (page 0 is the
 * first), so a test can hold a page back or run another bank's sync in between.
 */
function syncBank(
	bank: Bank,
	pages: Charge[],
	before: (page: number) => Promise<void> = async () => {},
	db: D1Database = env.DB,
) {
	let served = 0;

	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get"))
			return response({
				accounts: [
					{
						account_id: bank.account,
						name: "Everyday",
						type: "depository",
						balances: { current: 10 },
					},
				],
			});

		const index = served++;
		await before(index);
		const charge = present(pages[index]);

		return response({
			added: [
				{
					transaction_id: charge.id ?? `${bank.account}-${index}`,
					account_id: bank.account,
					date: charge.date ?? "2026-09-27",
					amount: 6.5,
					name: charge.text,
					merchant_name: charge.name,
					pending: false,
				},
			],
			modified: [],
			removed: [],
			next_cursor: crypto.randomUUID(),
			has_more: index < pages.length - 1,
		});
	});

	return syncItem(
		{ ...env, DB: db, TOKEN_ENCRYPTION_KEY: KEY },
		bank.id,
		fetchImpl,
	);
}

const merchant = (key: string) =>
	env.DB.prepare(
		"SELECT display_name, default_category_id FROM merchants WHERE raw_name = ?",
	)
		.bind(key)
		.first<{
			display_name: string | null;
			default_category_id: number | null;
		}>();

describe("two banks naming the same merchant for the first time", () => {
	let category = 0;

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchant_suggested_names"),
			env.DB.prepare("DELETE FROM merchants"),
		]);

		category = present(
			await env.DB.prepare(
				"SELECT id FROM categories ORDER BY id LIMIT 1",
			).first<{ id: number }>(),
		).id;

		// What each bank's own text for the cafe already holds: one a name a person gave it, the other a category rule.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('CAFE TEXT ONE', 'Our cafe')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES ('CAFE TEXT TWO', ?)",
			).bind(category),
		]);
	});

	it("gives it to one bank when both pages arrive at the same moment, never a mix of both", async () => {
		const one = await addBank("account-one");
		const two = await addBank("account-two");
		let asked = 0;
		let bothAsked = () => {};

		const together = new Promise<void>((resolve) => {
			bothAsked = resolve;
		});

		// Each bank's page is held until the other bank has asked for its own, so both are worked on at once.
		const held = async () => {
			asked += 1;

			if (asked === 2) bothAsked();
			await together;
		};

		await Promise.all([
			syncBank(one, [{ text: "CAFE TEXT ONE", name: "Cafe" }], held),
			syncBank(two, [{ text: "CAFE TEXT TWO", name: "Cafe" }], held),
		]);

		// The first to save starts the merchant from its own text; the other finds it started and adds nothing.
		expect([
			{ display_name: "Our cafe", default_category_id: null },
			{ display_name: null, default_category_id: category },
		]).toContainEqual(await merchant("Cafe"));
	});

	it("leaves it to the bank that started it, when another bank's first page named it and made no row", async () => {
		const one = await addBank("account-one");
		const two = await addBank("account-two");

		// Bank two's first page names "Cafe" under a text that has no row and tidies to the same name, so it starts
		// nothing. Bank one then syncs, and starts "Cafe" from its own text. Bank two's second page names "Cafe" again,
		// under the text that holds a rule.
		await syncBank(
			two,
			[
				{ text: "CAFE", name: "Cafe" },
				{ text: "CAFE TEXT TWO", name: "Cafe" },
			],
			async (page) => {
				if (page === 1)
					await syncBank(one, [{ text: "CAFE TEXT ONE", name: "Cafe" }]);
			},
		);

		// Bank one started the merchant, so it is bank one's: bank two's later page adds nothing to it.
		expect(await merchant("Cafe")).toEqual({
			display_name: "Our cafe",
			default_category_id: null,
		});
	});
});

describe("one bank's page saved while another bank adds a charge with the same Plaid name", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchant_suggested_names"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
	});

	const status = async (key: string) =>
		(
			await env.DB.prepare(
				"SELECT suggestion_status FROM merchants WHERE raw_name = ?",
			)
				.bind(key)
				.first<{ suggestion_status: string }>()
		)?.suggestion_status;

	it("keeps a suggested name that the other bank's new charge still uses", async () => {
		const one = await addBank("account-one");
		const two = await addBank("account-two");

		// Bank one's text came with the name Bean House, which is waiting as a suggestion.
		await syncBank(one, [
			{
				text: "COFFEE TEXT ONE",
				name: "Bean House",
				id: "earlier",
				date: "2026-09-01",
			},
		]);
		expect(await status("Bean House")).toBe("pending");

		// Bank one's next page renames its text, so Bean House is no longer its newest name. After the page has read
		// which texts use the name, and before it saves, bank two stores a charge whose own text is named Bean House.
		let between = true;

		const db = Object.assign(Object.create(env.DB), {
			prepare: (query: string) => env.DB.prepare(query),
			batch: async (statements: D1PreparedStatement[]) => {
				if (between) {
					between = false;
					await syncBank(two, [
						{ text: "COFFEE TEXT TWO", name: "Bean House" },
					]);
				}

				return env.DB.batch(statements);
			},
		});

		await syncBank(
			one,
			[{ text: "COFFEE TEXT ONE", name: "Bean House Roasters" }],
			undefined,
			db,
		);

		// Bank two then bank one, one after the other, leaves Bean House waiting: it is the newest name of bank two's text.
		expect(await status("Bean House Roasters")).toBe("pending");
		expect(await status("Bean House")).toBe("pending");
	});

	it("withdraws a suggested name the other bank's new charge uses only as its own text, tidied", async () => {
		const one = await addBank("account-one");
		const two = await addBank("account-two");

		await syncBank(one, [
			{
				text: "COFFEE TEXT ONE",
				name: "Bean house",
				id: "earlier",
				date: "2026-09-01",
			},
		]);
		expect(await status("Bean house")).toBe("pending");

		// As above, but bank two's text is BEAN HOUSE: its Plaid name is only that text tidied, which needs no suggestion.
		let between = true;

		const db = Object.assign(Object.create(env.DB), {
			prepare: (query: string) => env.DB.prepare(query),
			batch: async (statements: D1PreparedStatement[]) => {
				if (between) {
					between = false;
					await syncBank(two, [{ text: "BEAN HOUSE", name: "Bean house" }]);
				}

				return env.DB.batch(statements);
			},
		});

		await syncBank(
			one,
			[{ text: "COFFEE TEXT ONE", name: "Bean House Roasters" }],
			undefined,
			db,
		);

		// Bank two then bank one, one after the other, withdraws it: no text has it as a newest name worth suggesting.
		expect(await status("Bean House Roasters")).toBe("pending");
		expect(await status("Bean house")).toBe("none");
	});
});
