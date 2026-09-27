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
	next_cursor: string;
	has_more: boolean;
};

type ItemRow = {
	access_token_encrypted: ArrayBuffer;
	sync_cursor: string | null;
};

export const NEEDS_ATTENTION_ERROR_CODES = [
	"ITEM_LOGIN_REQUIRED",
	"PENDING_EXPIRATION",
	"PENDING_DISCONNECT",
	"ITEM_LOCKED",
	"USER_SETUP_REQUIRED",
	"INVALID_CREDENTIALS",
	"INVALID_MFA",
	"INSUFFICIENT_CREDENTIALS",
	"ACCESS_NOT_GRANTED",
	"NO_ACCOUNTS",
] as const;

const needsAttention = new Set<string>(NEEDS_ATTENTION_ERROR_CODES);

export type SyncSummary = { added: number; modified: number; removed: number };
export type SyncResult = SyncSummary | { skipped: true };

function accountUpsert(
	env: SyncEnv,
	itemRowId: number,
	account: PlaidAccount,
): D1PreparedStatement {
	const balance =
		account.balances.current === null || account.balances.current === undefined
			? null
			: plaidAmountToCents(account.balances.current);
	return env.DB.prepare(
		`INSERT INTO accounts
			(plaid_item_id, plaid_account_id, name, mask, type, subtype, is_liability, balance_cents)
		 VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))
		 ON CONFLICT(plaid_account_id) DO UPDATE SET
			plaid_item_id = excluded.plaid_item_id, name = excluded.name, mask = excluded.mask,
			type = excluded.type, subtype = excluded.subtype,
			is_liability = excluded.is_liability,
			balance_cents = COALESCE(?, accounts.balance_cents),
			updated_at = datetime('now')`,
	).bind(
		itemRowId,
		account.account_id,
		account.name,
		account.mask ?? null,
		account.type,
		account.subtype ?? null,
		account.type === "credit" || account.type === "loan" ? 1 : 0,
		balance,
		balance,
	);
}

async function handlePlaidError(
	env: SyncEnv,
	itemRowId: number,
	error: unknown,
): Promise<never> {
	if (error instanceof PlaidError) {
		console.error(`plaid sync error ${error.request_id ?? ""}`.trim());
		if (error.error_code && needsAttention.has(error.error_code)) {
			await env.DB.prepare(
				"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ?",
			)
				.bind(itemRowId)
				.run();
		}
	}
	throw error;
}

/** Pulls every available page for one Item, committing each page and its cursor atomically. */
export async function syncItem(
	env: SyncEnv,
	itemRowId: number,
	fetchImpl?: typeof fetch,
): Promise<SyncResult> {
	const lockId = crypto.randomUUID();
	const lock = await env.DB.prepare(
		`UPDATE plaid_items
		 SET sync_locked_until = datetime('now', '+5 minutes'), sync_lock_id = ?
		 WHERE id = ? AND (sync_locked_until IS NULL OR sync_locked_until < datetime('now'))`,
	)
		.bind(lockId, itemRowId)
		.run();
	if (lock.meta.changes === 0) {
		const exists = await env.DB.prepare(
			"SELECT id FROM plaid_items WHERE id = ?",
		)
			.bind(itemRowId)
			.first();
		if (!exists) throw new Error("Plaid Item not found");
		return { skipped: true };
	}

	try {
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
		let accounts: PlaidAccount[];
		try {
			({ accounts } = await plaidPost<{ accounts: PlaidAccount[] }>(
				env,
				"/accounts/get",
				{ access_token: accessToken },
				fetchImpl,
			));
		} catch (error) {
			return await handlePlaidError(env, itemRowId, error);
		}
		const stored = await env.DB.prepare(
			"SELECT plaid_account_id FROM accounts WHERE plaid_item_id = ?",
		)
			.bind(itemRowId)
			.all<{ plaid_account_id: string }>();
		const knownAccounts = new Set([
			...accounts.map((account) => account.account_id),
			...stored.results.map((account) => account.plaid_account_id),
		]);

		const startCursor = item.sync_cursor;
		let cursor = startCursor;
		let mutationRestarts = 0;
		let firstPage = true;
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
					cursor = startCursor;
					firstPage = true;
					continue;
				}
				return await handlePlaidError(env, itemRowId, error);
			}

			const posted = page.added.filter((transaction) => !transaction.pending);
			if (
				posted.some((transaction) => !knownAccounts.has(transaction.account_id))
			) {
				throw new Error(
					"Plaid sync returned a transaction for an unknown account",
				);
			}

			const statements: D1PreparedStatement[] = [
				env.DB.prepare(
					`UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes')
					 WHERE id = ? AND sync_lock_id = ?`,
				).bind(itemRowId, lockId),
			];
			if (firstPage) {
				for (const account of accounts) {
					statements.push(accountUpsert(env, itemRowId, account));
				}
			}
			const firstAddedStatement = statements.length;
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
						transaction.name,
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
						transaction.name,
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
			const results = await env.DB.batch(statements);
			const inserted = results
				.slice(firstAddedStatement, firstAddedStatement + posted.length)
				.reduce((count, result) => count + (result.meta.changes ?? 0), 0);

			cursor = page.next_cursor;
			firstPage = false;
			summary.added += inserted;
			summary.modified += page.modified.length;
			summary.removed += page.removed.length;
			if (inserted || page.modified.length || page.removed.length) {
				console.log(
					`plaid sync: added ${inserted}, modified ${page.modified.length}, removed ${page.removed.length}`,
				);
			}
			if (!page.has_more) return summary;
		}
	} finally {
		await env.DB.prepare(
			`UPDATE plaid_items SET sync_locked_until = NULL, sync_lock_id = NULL
			 WHERE id = ? AND sync_lock_id = ?`,
		)
			.bind(itemRowId, lockId)
			.run();
	}
}
