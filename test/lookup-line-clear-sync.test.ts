import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { present } from "./helpers/present";
import {
	db,
	expectCleared,
	lineRow,
	useLineFixture,
} from "./lookup-line-fixture";

// Spec §7 "One answer corrects the whole store", and a filing a sync makes. A row a person filed under one key, which Plaid
// then re-sends under another key, files the other key's store: the other store's line-backed guesses clear (P3).

const KEY = btoa("01234567890123456789012345678901");

const ACCOUNT = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 10 },
};

/** A Plaid transaction as the sync reads it (the fields this test sends). */
type PlaidTransaction = {
	transaction_id: string;
	account_id: string;
	date: string;
	amount: number;
	name: string;
	merchant_name: string;
	pending: boolean;
	personal_finance_category: { primary: string };
};

/** An ordinary purchase under `merchant_name`, unless `overrides` says otherwise. */
const transaction = (
	overrides: Partial<PlaidTransaction> = {},
): PlaidTransaction => ({
	transaction_id: "plaid-r",
	account_id: "account-1",
	date: "2026-11-15",
	amount: 6.5,
	name: "SQ *TAQUERIA",
	merchant_name: "Old Store",
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
	...overrides,
});

/** A 200 response whose body is `text`, as Plaid answers with JSON. */
const json = (text: string) =>
	new Response(text, {
		status: 200,
		headers: { "content-type": "application/json" },
	});

async function addItem(): Promise<number> {
	const encrypted = await encryptToken("secret-access-token", KEY);

	const result = await db
		.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
		)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();

	return present(result).id;
}

/** One sync over one page of added or modified transactions, on the same account as the rows above. */
async function sync(
	id: number,
	page: { added?: PlaidTransaction[]; modified?: PlaidTransaction[] },
) {
	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return json(JSON.stringify({ accounts: [ACCOUNT] }));
		}

		return json(
			JSON.stringify({
				added: page.added ?? [],
				modified: page.modified ?? [],
				removed: [],
				next_cursor: crypto.randomUUID(),
				has_more: false,
			}),
		);
	});

	await syncItem({ ...env, DB: db, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
}

describe("a sync that moves a person's filed row to another store", () => {
	useLineFixture();

	beforeEach(async () => {
		// The new key's lookup text row is the one the trigger reads for the key the row moves to.
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES ('New Store', ?, 0)",
			)
			.bind(lookupTextOf("New Store"))
			.run();
	});

	// 10. A re-sent person-filed row moves to another store (P3).
	it("10. a re-sent person-filed row moves to another store: S under the new key is cleared, kept 0 (P3; mutation: an OLD-vs-NEW change guard added to the WHEN)", async () => {
		const id = await addItem();

		// The bank first sends R under Old Store, and a person files it.
		await sync(id, { added: [transaction()] });
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE plaid_transaction_id = 'plaid-r'",
			)
			.bind(
				present(
					await db
						.prepare("SELECT id FROM categories WHERE name = 'Groceries'")
						.first<{ id: number }>(),
				).id,
			)
			.run();

		// S is a standing line-backed row under the new key.
		const s = await lineRow({ key: "New Store" });

		// Plaid re-sends R under New Store.
		await sync(id, {
			modified: [
				transaction({ merchant_name: "New Store", name: "SQ *NEW STORE" }),
			],
		});

		const moved = await db
			.prepare(
				"SELECT merchant_name, category_source FROM transactions WHERE plaid_transaction_id = 'plaid-r'",
			)
			.first<{ merchant_name: string; category_source: string }>();

		expect(moved).toMatchObject({
			merchant_name: "New Store",
			category_source: "user",
		});

		await expectCleared(s);
	});
});
