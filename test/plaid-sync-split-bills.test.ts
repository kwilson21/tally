import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unpaidBillsNote } from "../src/bills/unpaid";
import { saveAiSwitches } from "../src/db/ai-switches";
import { getTransaction, saveSplit } from "../src/db/transactions";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";

// Decision 99: when the bank changes a split purchase's amount, sync removes the split and the purchase's
// note says so. A part's bill payment is unlinked then too, and the note names the bill.

const KEY = btoa("01234567890123456789012345678901");
const opts = { ...env, TOKEN_ENCRYPTION_KEY: KEY };
const MEMBERSHIP = 9840;
const MEMBERSHIP_JSON =
	'[{"billId":9840,"name":"Costco membership","period":"2026"}]';

const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const page = (overrides: Record<string, unknown> = {}) => ({
	added: [],
	modified: [],
	removed: [],
	next_cursor: "cursor-1",
	has_more: false,
	...overrides,
});

const transaction = (overrides: Record<string, unknown> = {}) => ({
	transaction_id: "purchase",
	account_id: "account-1",
	date: "2026-09-15",
	amount: 50,
	name: "COSTCO",
	merchant_name: "Costco",
	pending: false,
	personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
	...overrides,
});

const plaidFetch = (sync: Record<string, unknown>) =>
	vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get"))
			return response({
				accounts: [
					{
						account_id: "account-1",
						name: "Everyday",
						mask: "1234",
						type: "depository",
						subtype: "checking",
						balances: { current: 12.34 },
					},
				],
			});
		return response(page(sync));
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

describe("a bank change that removes a split unlinks the bill its part paid (decision 99)", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
		await saveAiSwitches(env.DB, { details: false });
	});

	/** A $50.00 purchase the bank sent, split by a person into $40.00 (a membership, paid) and $10.00. */
	async function splitPurchase() {
		const item = await addItem();
		await syncItem(opts, item, plaidFetch({ added: [transaction()] }));
		const purchase = (await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase'",
		).first<{ id: number }>()) as { id: number };
		await saveSplit(
			env.DB,
			purchase.id,
			[
				{ categoryId: 4, amountCents: 4000 },
				{ categoryId: 1, amountCents: 1000 },
			],
			"person@example.com",
		);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (?, 'Costco membership', 4000, 15, 'yearly', 9, NULL, 'COSTCO', 1)",
			).bind(MEMBERSHIP),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT ?, '2026', id, 'auto', 'linked' FROM transactions WHERE parent_id = ? AND amount_cents = 4000",
			).bind(MEMBERSHIP, purchase.id),
		]);
		return { item, purchase: purchase.id };
	}

	it.each(["added", "modified"] as const)(
		"unlinks the bill and names it on the purchase when the amount changes (%s)",
		async (path) => {
			const { item, purchase } = await splitPurchase();

			await syncItem(
				opts,
				item,
				plaidFetch({ [path]: [transaction({ amount: 60 })] }),
			);

			expect(
				await env.DB.prepare(
					"SELECT is_split, split_removed_from_cents, split_removed_bills FROM transactions WHERE id = ?",
				)
					.bind(purchase)
					.first(),
			).toEqual({
				is_split: 0,
				split_removed_from_cents: 5000,
				split_removed_bills: MEMBERSHIP_JSON,
			});
			// The bill is unpaid again: no payment is linked to it.
			expect(
				(
					await env.DB.prepare(
						"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id = ? AND status = 'linked'",
					)
						.bind(MEMBERSHIP)
						.first<{ n: number }>()
				)?.n,
			).toBe(0);
		},
	);

	it("keeps the bill names when a later correction changes the amount again", async () => {
		const { item, purchase } = await splitPurchase();
		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 60 })] }),
		);
		// A second correction of the same purchase leaves the note as it was.
		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 61 })] }),
		);
		expect(
			(
				await env.DB.prepare(
					"SELECT split_removed_bills FROM transactions WHERE id = ?",
				)
					.bind(purchase)
					.first<{ split_removed_bills: string | null }>()
			)?.split_removed_bills,
		).toBe(MEMBERSHIP_JSON);
	});

	it("links the bill to the purchase again when the sync leaves it matching, and the note stops naming it", async () => {
		const { item, purchase } = await splitPurchase();
		// The bank names the merchant "Costco", the key a bill's merchant must equal to be matched.
		await env.DB.prepare(
			"UPDATE bills SET merchant_raw_name = 'Costco' WHERE id = ?",
		)
			.bind(MEMBERSHIP)
			.run();

		// $42.00 on the same day: the whole purchase is within the bill's tolerance and date window.
		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 42 })] }),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT bill_id, period, transaction_id, matched_by, status FROM bill_payments WHERE bill_id = ?",
				)
					.bind(MEMBERSHIP)
					.all()
			).results,
		).toEqual([
			{
				bill_id: MEMBERSHIP,
				period: "2026",
				transaction_id: purchase,
				matched_by: "auto",
				status: "linked",
			},
		]);
		// The bill is paid again, so the purchase's note no longer names it.
		const detail = await getTransaction(env.DB, purchase);
		expect(unpaidBillsNote(detail?.splitRemovedBills)).toBe("");
	});

	it("keeps a person's own Not this one from a part on the purchase when the sync removes the split", async () => {
		const { item, purchase } = await splitPurchase();
		await env.DB.prepare(
			"UPDATE bills SET merchant_raw_name = 'Costco' WHERE id = ?",
		)
			.bind(MEMBERSHIP)
			.run();
		// A person marked the part's payment Not this one, so it is a dismissal on the part, not a link.
		await env.DB.prepare(
			"UPDATE bill_payments SET status = 'dismissed', matched_by = 'user' WHERE bill_id = ?",
		)
			.bind(MEMBERSHIP)
			.run();

		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 42 })] }),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT transaction_id, matched_by, status FROM bill_payments WHERE bill_id = ?",
				)
					.bind(MEMBERSHIP)
					.all()
			).results,
		).toEqual([
			{ transaction_id: purchase, matched_by: "user", status: "dismissed" },
		]);
	});

	it("names only the bill still unpaid once the other is paid again", async () => {
		const { item, purchase } = await splitPurchase();
		// A second bill, paid by the $10.00 part.
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills (id, name, amount_cents, due_day, frequency, anchor_month, category_id, merchant_raw_name, active) VALUES (9841, 'Water', 1000, 3, 'monthly', NULL, NULL, 'CITY WATER', 1)",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) SELECT 9841, '2026-09', id, 'auto', 'linked' FROM transactions WHERE parent_id = ? AND amount_cents = 1000",
			).bind(purchase),
		]);

		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 60 })] }),
		);
		expect(
			unpaidBillsNote(
				(await getTransaction(env.DB, purchase))?.splitRemovedBills,
			),
		).toBe(" 2 bills are no longer paid.");

		// A person links the Water payment to the purchase, so only the membership is still unpaid.
		await env.DB.prepare(
			"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (9841, '2026-09', ?, 'user', 'linked')",
		)
			.bind(purchase)
			.run();
		expect(
			unpaidBillsNote(
				(await getTransaction(env.DB, purchase))?.splitRemovedBills,
			),
		).toBe(" The Costco membership bill for 2026 is no longer paid.");
	});

	it("leaves no dismissal after a replacement, so the bank's amount change lets the matcher link the bill again", async () => {
		const { item, purchase } = await splitPurchase();
		await env.DB.prepare(
			"UPDATE bills SET merchant_raw_name = 'Costco' WHERE id = ?",
		)
			.bind(MEMBERSHIP)
			.run();
		// A person replaces the parts, which unlinks the bill and leaves no dismissal behind.
		await saveSplit(
			env.DB,
			purchase,
			[
				{ categoryId: 4, amountCents: 3500 },
				{ categoryId: 1, amountCents: 1500 },
			],
			"person@example.com",
		);

		// $42.00 on the same day: the bill's tolerance links the whole purchase, since nothing dismisses it.
		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 42 })] }),
		);

		expect(
			(
				await env.DB.prepare(
					"SELECT bill_id, period, transaction_id, matched_by, status FROM bill_payments WHERE bill_id = ?",
				)
					.bind(MEMBERSHIP)
					.all()
			).results,
		).toEqual([
			{
				bill_id: MEMBERSHIP,
				period: "2026",
				transaction_id: purchase,
				matched_by: "auto",
				status: "linked",
			},
		]);
	});

	it("stores no bill names when the split's parts paid none", async () => {
		const item = await addItem();
		await syncItem(opts, item, plaidFetch({ added: [transaction()] }));
		const purchase = (await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase'",
		).first<{ id: number }>()) as { id: number };
		await saveSplit(
			env.DB,
			purchase.id,
			[
				{ categoryId: 4, amountCents: 4000 },
				{ categoryId: 1, amountCents: 1000 },
			],
			"person@example.com",
		);
		await syncItem(
			opts,
			item,
			plaidFetch({ modified: [transaction({ amount: 60 })] }),
		);
		expect(
			await env.DB.prepare(
				"SELECT is_split, split_removed_bills FROM transactions WHERE id = ?",
			)
				.bind(purchase.id)
				.first(),
		).toEqual({ is_split: 0, split_removed_bills: null });
	});
});
