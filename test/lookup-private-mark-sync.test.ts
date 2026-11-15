import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupTextOf } from "../src/lookup/lookup-text";
import { fillLookupTexts } from "../src/lookup/texts";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { isMemberOf, isMethod, present } from "./helpers/present";

// Sync writes a merchant_lookup_texts row for every key it writes, before its transaction statements, so the triggers on
// transactions find the row (migration 0077, the sync write in src/lookup/texts.ts). A new key starts private until the fill.

const db = env.DB;
const KEY = btoa("01234567890123456789012345678901");

/** The sync's env with the lookup open: a production household and a Tavily key. */
const OPEN = { DEMO: "false", TAVILY_API_KEY: "tvly" };

type Json = string | number | boolean | null | Json[] | JsonObject;

type JsonObject = { [key: string]: Json | undefined };

const transaction = (overrides: JsonObject = {}) => ({
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name: "CORNER CAFE 1",
	merchant_name: "Corner Cafe",
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
	...overrides,
});

const response = (body: Json) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

async function addItem() {
	const encrypted = await encryptToken("secret-access-token", KEY);

	const result = await db
		.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
		)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();

	return present(result).id;
}

const ACCOUNT = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 10 },
};

type Page = {
	added?: JsonObject[];
	modified?: JsonObject[];
};

/** One sync over a single page, with the env the case sets (the gate is in it). The statements the sync prepares are recorded. */
async function sync(
	id: number,
	page: Page,
	gate: { DEMO?: string; TAVILY_API_KEY?: string } = OPEN,
	database: D1Database = db,
) {
	const fetchImpl = async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return response({ accounts: [ACCOUNT] });
		}

		return response({
			added: page.added ?? [],
			modified: page.modified ?? [],
			removed: [],
			next_cursor: crypto.randomUUID(),
			has_more: false,
		});
	};

	await syncItem(
		{ ...env, ...gate, DB: database, TOKEN_ENCRYPTION_KEY: KEY },
		id,
		fetchImpl,
	);
}

/** The stored row of a key, or undefined. */
async function keyRow(key: string) {
	return db
		.prepare(
			"SELECT lookup_text, private FROM merchant_lookup_texts WHERE merchant_key = ?",
		)
		.bind(key)
		.first<{ lookup_text: string; private: number }>();
}

const markOf = async (key: string) => (await keyRow(key))?.private;

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM accounts"),
		db.prepare("DELETE FROM plaid_items"),
		db.prepare("DELETE FROM merchant_lookup_texts"),
	]);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("new keys", () => {
	// 9. A new key starts private, whatever its facts, and the fill sets the exact mark.
	// The INCOME case's flag_income is set by sync's insert through the insert trigger, not by syncedTextRows (flagged: false).
	it.each([
		["FOOD_AND_DRINK, an ordinary store", transaction(), 0],
		[
			"BANK_FEES, a private Plaid category",
			transaction({
				merchant_name: "Monthly Fee",
				name: "MONTHLY FEE",
				personal_finance_category: { primary: "BANK_FEES" },
			}),
			1,
		],
		[
			"TRANSFER_OUT, a Plaid transfer (excluded by sync)",
			transaction({
				merchant_name: "Savings Move",
				name: "SAVINGS MOVE",
				personal_finance_category: { primary: "TRANSFER_OUT" },
			}),
			1,
		],
		[
			"INCOME credit, flag_income set by the insert trigger",
			transaction({
				merchant_name: "Payroll Co",
				name: "PAYROLL CO",
				amount: -2000,
				personal_finance_category: { primary: "INCOME" },
			}),
			1,
		],
		[
			"a payment app in the bank text under an ordinary Plaid name",
			transaction({
				merchant_name: "Ordinary Market",
				name: "VENMO *ORDINARY MARKET",
			}),
			1,
		],
		[
			"a bank rail in the merchant key",
			transaction({
				merchant_name: "ACH DEBIT FAMILY SHOP",
				name: "ACH DEBIT FAMILY SHOP",
			}),
			1,
		],
	])(
		"9. %s: starts at 1 after sync, then the fill's mark",
		async (_label, row, expected) => {
			const key = String(row.merchant_name);
			const id = await addItem();

			await sync(id, { added: [row] });

			expect(await markOf(key)).toBe(1);
			expect((await keyRow(key))?.lookup_text).toBe(lookupTextOf(key));

			await fillLookupTexts(db);

			expect(await markOf(key)).toBe(expected);
		},
	);
});

describe("existing keys", () => {
	// 10. An existing key's mark only rises.
	it("10. a key at 1 stays 1 when sync writes an ordinary row of it", async () => {
		const id = await addItem();
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 1)",
			)
			.bind("Corner Cafe", lookupTextOf("Corner Cafe"))
			.run();

		await sync(id, { added: [transaction()] });

		expect(await markOf("Corner Cafe")).toBe(1);
	});

	it("10. a key at 0 becomes 1 when sync writes a BANK_FEES row of it", async () => {
		const id = await addItem();
		await db
			.prepare(
				"INSERT INTO merchant_lookup_texts (merchant_key, lookup_text, private) VALUES (?, ?, 0)",
			)
			.bind("Corner Cafe", lookupTextOf("Corner Cafe"))
			.run();

		await sync(id, {
			added: [
				transaction({
					transaction_id: "fee-1",
					personal_finance_category: { primary: "BANK_FEES" },
				}),
			],
		});

		expect(await markOf("Corner Cafe")).toBe(1);
	});

	// 10a. Sync's own ON CONFLICT update sets flag_income on a re-sent row, and the trigger fires in that batch. Note: an
	// INCOME category is private in syncedTextRows too, so this case alone does not isolate the trigger.
	it("10a. a re-sent row that sync now reads as INCOME sets its key's mark to 1 in that batch", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({
					transaction_id: "credit-1",
					merchant_name: "Refund Desk",
					name: "REFUND DESK",
					amount: -15,
					personal_finance_category: { primary: "FOOD_AND_DRINK" },
				}),
			],
		});
		await fillLookupTexts(db);
		expect(await markOf("Refund Desk")).toBe(0);

		await sync(id, {
			added: [
				transaction({
					transaction_id: "credit-1",
					merchant_name: "Refund Desk",
					name: "REFUND DESK",
					amount: -15,
					personal_finance_category: { primary: "INCOME" },
				}),
			],
		});

		const flag = await db
			.prepare(
				"SELECT flag_income FROM transactions WHERE plaid_transaction_id = 'credit-1'",
			)
			.first<{ flag_income: number }>();

		expect(flag?.flag_income).toBe(1);
		expect(await markOf("Refund Desk")).toBe(1);
	});
});

describe("changed merchant names", () => {
	// 11. A modified row whose merchant name changes: its new key is written, and a Plaid transfer's new key is 1.
	it("11. a modified row under a new name writes the new key's row, and a Plaid transfer's key is 1", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction({ transaction_id: "move-1" })] });
		await fillLookupTexts(db);
		expect(await markOf("Corner Cafe")).toBe(0);

		await sync(id, {
			modified: [
				transaction({
					transaction_id: "move-1",
					merchant_name: "Savings Move",
					name: "SAVINGS MOVE",
					personal_finance_category: { primary: "TRANSFER_OUT" },
				}),
			],
		});

		expect(await markOf("Savings Move")).toBe(1);
	});
});

describe("the order of the batch", () => {
	// 12. The key's rows are written before the account upserts and the transaction statements.
	it("12. the upsert is prepared before the first account upsert and the first transaction insert", async () => {
		const prepared: string[] = [];

		const counting = new Proxy(db, {
			get(target, property) {
				const value = isMemberOf(target, property)
					? target[property]
					: undefined;

				if (property === "prepare") {
					return (sql: string) => {
						prepared.push(sql);

						return target.prepare(sql);
					};
				}

				return isMethod(value) ? value.bind(target) : value;
			},
		});

		const id = await addItem();

		await sync(id, { added: [transaction()] }, OPEN, counting);

		const upsert = prepared.findIndex((sql) =>
			sql.includes("ON CONFLICT(merchant_key)"),
		);

		const account = prepared.findIndex((sql) =>
			sql.includes("INSERT INTO accounts"),
		);

		const transactions = prepared.findIndex((sql) =>
			sql.includes("INSERT INTO transactions"),
		);

		expect(upsert).toBeGreaterThanOrEqual(0);
		expect(upsert).toBeLessThan(account);
		expect(upsert).toBeLessThan(transactions);
	});
});

describe("the gate and the log", () => {
	// 13. Gate closed: no key, or a demo household, writes no row.
	it.each([
		["the demo household", { DEMO: "true", TAVILY_API_KEY: "tvly" }],
		["no Tavily key", { DEMO: "false" }],
	])(
		"13. with %s, a sync writes no merchant_lookup_texts row",
		async (_label, gate) => {
			const id = await addItem();

			await sync(id, { added: [transaction()] }, gate);

			expect(await markOf("Corner Cafe")).toBeUndefined();
		},
	);

	// 14. Nothing is logged by the sync write. Sync's own progress line (sync.ts, "plaid sync: added …") is baseline, so the
	// count with the gate open is compared with the count for the same page with the gate closed.
	it("14. the sync write logs nothing: the same page logs the same number of lines with the gate open and closed", async () => {
		const methods = ["log", "info", "warn", "error", "debug"] as const;
		const spies = methods.map((method) => vi.spyOn(console, method));

		const total = () =>
			spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

		for (const spy of spies) spy.mockClear();
		const closedItem = await addItem();
		await sync(
			closedItem,
			{ added: [transaction({ transaction_id: "closed-1" })] },
			{ DEMO: "true" },
		);
		const closed = total();

		for (const spy of spies) spy.mockClear();
		const openItem = await addItem();
		await sync(openItem, {
			added: [transaction({ transaction_id: "open-1" })],
		});

		expect(await markOf("Corner Cafe")).toBe(1);
		expect(total()).toBe(closed);
	});
});
