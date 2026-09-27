import { plaidAmountToCents } from "../money";
import { type PlaidEnv, PlaidError, plaidPost } from "./client";
import { decryptToken } from "./token-crypto";

type SyncEnv = PlaidEnv & {
	DB: D1Database;
	TOKEN_ENCRYPTION_KEY?: string;
};

type PlaidAccount = {
	account_id: string;
	name: string;
	mask?: string | null;
	type: string;
	subtype?: string | null;
	balances: { current?: number | null };
};

type PlaidTransaction = {
	transaction_id: string;
	account_id: string;
	date: string;
	amount: number;
	name: string;
	merchant_name?: string | null;
	pending: boolean;
	personal_finance_category?: { primary?: string | null } | null;
};

type SyncResponse = {
	added: PlaidTransaction[];
	modified: PlaidTransaction[];
	removed: { transaction_id: string }[];
	accounts: PlaidAccount[];
	next_cursor: string;
	has_more: boolean;
};

type ItemRow = {
	access_token_encrypted: ArrayBuffer;
	sync_cursor: string | null;
};

export type SyncSummary = { added: number; modified: number; removed: number };

/** Pulls every available page for one Item, committing each page and its cursor atomically. */
export async function syncItem(
	env: SyncEnv,
	itemRowId: number,
	fetchImpl?: typeof fetch,
): Promise<SyncSummary> {
	const item = await env.DB.prepare(
		"SELECT access_token_encrypted, sync_cursor FROM plaid_items WHERE id = ?",
	)
		.bind(itemRowId)
		.first<ItemRow>();
	if (!item) throw new Error("Plaid Item not found");
	if (!env.TOKEN_ENCRYPTION_KEY)
		throw new Error("TOKEN_ENCRYPTION_KEY is required");

	const accessToken = await decryptToken(
		item.access_token_encrypted,
		env.TOKEN_ENCRYPTION_KEY,
	);
	let cursor = item.sync_cursor;
	let mutationRestarts = 0;
	const summary: SyncSummary = { added: 0, modified: 0, removed: 0 };

	for (;;) {
		let page: SyncResponse;
		try {
			page = await plaidPost<SyncResponse>(
				env,
				"/transactions/sync",
				{
					access_token: accessToken,
					...(cursor === null ? {} : { cursor }),
				},
				fetchImpl,
			);
		} catch (error) {
			if (
				error instanceof PlaidError &&
				error.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
				mutationRestarts < 3
			) {
				mutationRestarts += 1;
				continue;
			}
			if (error instanceof PlaidError) {
				console.error(`plaid sync error ${error.request_id ?? ""}`.trim());
				if (error.error_type === "ITEM_ERROR") {
					await env.DB.prepare(
						"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ?",
					)
						.bind(itemRowId)
						.run();
				}
			}
			throw error;
		}

		const posted = page.added.filter((transaction) => !transaction.pending);
		const statements: D1PreparedStatement[] = [];
		for (const account of page.accounts) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO accounts
						(plaid_item_id, plaid_account_id, name, mask, type, subtype, is_liability, balance_cents)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(plaid_account_id) DO UPDATE SET
						plaid_item_id = excluded.plaid_item_id, name = excluded.name, mask = excluded.mask,
						type = excluded.type, subtype = excluded.subtype,
						is_liability = excluded.is_liability, balance_cents = excluded.balance_cents,
						updated_at = datetime('now')`,
				).bind(
					itemRowId,
					account.account_id,
					account.name,
					account.mask ?? null,
					account.type,
					account.subtype ?? null,
					account.type === "credit" || account.type === "loan" ? 1 : 0,
					plaidAmountToCents(account.balances.current ?? 0),
				),
			);
		}
		for (const transaction of posted) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO transactions
						(plaid_transaction_id, account_id, date, amount_cents, raw_name, plaid_category)
					 SELECT ?, id, ?, ?, ?, ? FROM accounts WHERE plaid_account_id = ?
					 ON CONFLICT(plaid_transaction_id) DO NOTHING`,
				).bind(
					transaction.transaction_id,
					transaction.date,
					plaidAmountToCents(transaction.amount),
					transaction.merchant_name ?? transaction.name,
					transaction.personal_finance_category?.primary ?? null,
					transaction.account_id,
				),
			);
		}
		for (const transaction of page.modified) {
			statements.push(
				env.DB.prepare(
					`UPDATE transactions SET date = ?, amount_cents = ?, raw_name = ?,
						plaid_category = ?, updated_at = datetime('now')
					 WHERE plaid_transaction_id = ?`,
				).bind(
					transaction.date,
					plaidAmountToCents(transaction.amount),
					transaction.merchant_name ?? transaction.name,
					transaction.personal_finance_category?.primary ?? null,
					transaction.transaction_id,
				),
			);
		}
		for (const transaction of page.removed) {
			statements.push(
				env.DB.prepare(
					"DELETE FROM transactions WHERE plaid_transaction_id = ?",
				).bind(transaction.transaction_id),
			);
		}
		statements.push(
			env.DB.prepare(
				"UPDATE plaid_items SET sync_cursor = ? WHERE id = ?",
			).bind(page.next_cursor, itemRowId),
		);
		await env.DB.batch(statements);

		cursor = page.next_cursor;
		summary.added += posted.length;
		summary.modified += page.modified.length;
		summary.removed += page.removed.length;
		console.log(
			`plaid sync: added ${posted.length}, modified ${page.modified.length}, removed ${page.removed.length}`,
		);
		if (!page.has_more) return summary;
	}
}
