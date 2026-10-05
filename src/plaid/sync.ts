import { matchBillPayments } from "../bills/match";
import { merchantKeySql } from "../db/merchant-key";
import {
	isPlaidTransferSql,
	plaidTransferRuleSql,
} from "../db/plaid-transfers";
import { plaidAmountToCents } from "../money";
import { type PlaidEnv, PlaidError, plaidPost } from "./client";
import { loginStillBroken } from "./login-broken";
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

/** Item errors that clear up on their own; every other ITEM_ERROR needs the person to fix the connection. */
export const TRANSIENT_ITEM_ERROR_CODES = [
	"PRODUCT_NOT_READY",
	"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
] as const;

const transient = new Set<string>(TRANSIENT_ITEM_ERROR_CODES);

export type SyncSummary = { added: number; modified: number; removed: number };
export type SyncResult = SyncSummary | { skipped: true };

/** Plaid's cleaned merchant name, or null when it sent none or a blank one (spec §5, decision 67). */
const merchantNameOf = (transaction: PlaidTransaction) =>
	transaction.merchant_name?.trim() || null;

/** True only while this run still holds the Item's lock; every page write carries it. */
const OWNS_LOCK =
	"EXISTS (SELECT 1 FROM plaid_items WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL)";

/**
 * A split's parts follow the bank transaction's exclusion by the same rule (spec §8.5), because the
 * budget counts the parts, not the parent. A split a person excluded or included stays as they set it.
 * It runs before the parent's own write and reads the parent as it was.
 */
function partsExclusion(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	transaction: PlaidTransaction,
): D1PreparedStatement {
	const category = transaction.personal_finance_category?.primary ?? null;
	return env.DB.prepare(
		`UPDATE transactions SET ${plaidTransferRuleSql("?")}
		 WHERE parent_id = (
			SELECT id FROM transactions WHERE plaid_transaction_id = ? AND is_split = 1 AND COALESCE(excluded_source, '') != 'user'
		 ) AND ${OWNS_LOCK}`,
	).bind(category, category, transaction.transaction_id, itemRowId, lockId);
}

function accountUpsert(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	account: PlaidAccount,
): D1PreparedStatement {
	const balance =
		account.balances.current === null || account.balances.current === undefined
			? null
			: plaidAmountToCents(account.balances.current);
	return env.DB.prepare(
		`INSERT INTO accounts
			(plaid_item_id, plaid_account_id, name, mask, type, subtype, is_liability, balance_cents)
		 SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0) WHERE ${OWNS_LOCK}
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
		itemRowId,
		lockId,
		balance,
	);
}

async function handlePlaidError(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	accessTokenEncrypted: ArrayBuffer,
	error: unknown,
	fetchImpl?: typeof fetch,
): Promise<never> {
	if (error instanceof PlaidError) {
		console.error(`plaid sync error ${error.request_id ?? ""}`.trim());
		if (
			error.error_type === "ITEM_ERROR" &&
			!transient.has(error.error_code ?? "")
		) {
			const item = await env.DB.prepare(
				"SELECT status FROM plaid_items WHERE id = ?",
			)
				.bind(itemRowId)
				.first<{ status: string }>();
			if (
				item &&
				(await loginStillBroken(env, accessTokenEncrypted, fetchImpl))
			) {
				await env.DB.prepare(
					"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ? AND sync_lock_id = ? AND status = ? AND disconnected_at IS NULL",
				)
					.bind(itemRowId, lockId, item.status)
					.run();
			}
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
		`UPDATE plaid_items SET sync_locked_until = datetime('now', '+5 minutes'), sync_lock_id = ?
		 WHERE id = ? AND disconnected_at IS NULL AND (sync_locked_until IS NULL OR sync_locked_until < datetime('now'))`,
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
			return await handlePlaidError(
				env,
				itemRowId,
				lockId,
				item.access_token_encrypted,
				error,
				fetchImpl,
			);
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
		let summary: SyncSummary = { added: 0, modified: 0, removed: 0 };
		const addedDuringRun = new Set<string>();

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
					console.error(
						`plaid sync mutation retry ${mutationRestarts + 1} ${error.request_id ?? ""}`.trim(),
					);
					mutationRestarts += 1;
					cursor = startCursor;
					firstPage = true;
					summary = { added: 0, modified: 0, removed: 0 };
					continue;
				}
				return await handlePlaidError(
					env,
					itemRowId,
					lockId,
					item.access_token_encrypted,
					error,
					fetchImpl,
				);
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
					 WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL`,
				).bind(itemRowId, lockId),
			];
			const existingTransactionIds = new Set<string>();
			if (posted.length > 0) {
				const placeholders = posted.map(() => "?").join(", ");
				const existing = await env.DB.prepare(
					`SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id IN (${placeholders})`,
				)
					.bind(...posted.map((transaction) => transaction.transaction_id))
					.all<{ plaid_transaction_id: string }>();
				for (const row of existing.results) {
					existingTransactionIds.add(row.plaid_transaction_id);
				}
			}
			if (firstPage) {
				for (const account of accounts) {
					statements.push(accountUpsert(env, itemRowId, lockId, account));
				}
			}
			const firstAddedStatement = statements.length;
			for (const transaction of posted) {
				const cents = plaidAmountToCents(transaction.amount);
				// A corrected amount invalidates a person's parts; a date-only correction follows them.
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET refund_of_id=NULL WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=(SELECT id FROM transactions WHERE plaid_transaction_id=? AND is_split=1 AND amount_cents!=?)) AND ${OWNS_LOCK}`,
					).bind(transaction.transaction_id, cents, itemRowId, lockId),
				);
				statements.push(
					env.DB.prepare(`DELETE FROM transactions WHERE parent_id = (
					SELECT id FROM transactions WHERE plaid_transaction_id = ? AND is_split = 1 AND amount_cents != ?
				) AND ${OWNS_LOCK}`).bind(
						transaction.transaction_id,
						cents,
						itemRowId,
						lockId,
					),
				);
				statements.push(
					env.DB.prepare(`UPDATE transactions SET date = ?, raw_name = ?, merchant_name = ? WHERE parent_id = (
					SELECT id FROM transactions WHERE plaid_transaction_id = ? AND is_split = 1 AND amount_cents = ?
				) AND ${OWNS_LOCK}`).bind(
						transaction.date,
						transaction.name,
						merchantNameOf(transaction),
						transaction.transaction_id,
						cents,
						itemRowId,
						lockId,
					),
				);
				statements.push(partsExclusion(env, itemRowId, lockId, transaction));
				statements.push(
					env.DB.prepare(
						`INSERT INTO transactions
							(plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, plaid_category, credit_reviewed, excluded, excluded_source)
						 SELECT ?, id, ?, ?, ?, ?, ?, CASE WHEN ? < 0 THEN 0 ELSE 1 END,
							CASE WHEN ${isPlaidTransferSql("?")} THEN 1 ELSE 0 END,
							CASE WHEN ${isPlaidTransferSql("?")} THEN 'plaid' ELSE NULL END FROM accounts
						 WHERE plaid_account_id = ? AND ${OWNS_LOCK}
						 ON CONFLICT(plaid_transaction_id) DO UPDATE SET
							date = excluded.date,
								flag_income = CASE WHEN transactions.income_source = 'jev' AND transactions.amount_cents != excluded.amount_cents THEN 0 ELSE transactions.flag_income END,
								income_source = CASE WHEN transactions.income_source = 'jev' AND transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.income_source END,
								credit_reviewed = CASE WHEN transactions.credit_reviewed_by = 'user' THEN transactions.credit_reviewed WHEN transactions.amount_cents = excluded.amount_cents THEN transactions.credit_reviewed WHEN excluded.amount_cents < 0 THEN 0 ELSE 1 END,
								credit_reviewed_by = CASE WHEN transactions.credit_reviewed_by = 'jev' AND transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.credit_reviewed_by END,
							split_removed_from_cents = CASE WHEN transactions.is_split = 1 AND transactions.amount_cents != excluded.amount_cents THEN transactions.amount_cents ELSE transactions.split_removed_from_cents END,
							category_id = CASE WHEN ((transactions.is_split = 1 OR transactions.category_source = 'jev') AND transactions.amount_cents != excluded.amount_cents) OR (transactions.category_source = 'merchant_rule' AND ${merchantKeySql("transactions")} != ${merchantKeySql("excluded")}) THEN NULL ELSE transactions.category_id END,
							category_source = CASE WHEN ((transactions.is_split = 1 OR transactions.category_source = 'jev') AND transactions.amount_cents != excluded.amount_cents) OR (transactions.category_source = 'merchant_rule' AND ${merchantKeySql("transactions")} != ${merchantKeySql("excluded")}) THEN NULL ELSE transactions.category_source END,
							category_confidence = CASE WHEN transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.category_confidence END,
							jev_category_id = CASE WHEN transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.jev_category_id END,
							is_split = CASE WHEN transactions.is_split = 1 AND transactions.amount_cents != excluded.amount_cents THEN 0 ELSE transactions.is_split END,
							amount_cents = excluded.amount_cents,
							raw_name = excluded.raw_name,
							merchant_name = excluded.merchant_name,
							plaid_category = excluded.plaid_category,
							${plaidTransferRuleSql("excluded.plaid_category")},
							updated_at = datetime('now')`,
					).bind(
						transaction.transaction_id,
						transaction.date,
						cents,
						transaction.name,
						merchantNameOf(transaction),
						transaction.personal_finance_category?.primary ?? null,
						plaidAmountToCents(transaction.amount),
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.primary ?? null,
						transaction.account_id,
						itemRowId,
						lockId,
					),
				);
			}
			for (const transaction of page.modified) {
				const cents = plaidAmountToCents(transaction.amount);
				// A corrected merchant takes its new rule, not the old merchant's (a person's or Jev's pick stays).
				const newKey = merchantNameOf(transaction) ?? transaction.name;
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET refund_of_id=NULL WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=(SELECT id FROM transactions WHERE plaid_transaction_id=? AND is_split=1 AND amount_cents!=?)) AND ${OWNS_LOCK}`,
					).bind(transaction.transaction_id, cents, itemRowId, lockId),
				);
				statements.push(
					env.DB.prepare(`DELETE FROM transactions WHERE parent_id = (
					SELECT id FROM transactions WHERE plaid_transaction_id = ? AND is_split = 1 AND amount_cents != ?
				) AND ${OWNS_LOCK}`).bind(
						transaction.transaction_id,
						cents,
						itemRowId,
						lockId,
					),
				);
				statements.push(
					env.DB.prepare(`UPDATE transactions SET date = ?, raw_name = ?, merchant_name = ? WHERE parent_id = (
					SELECT id FROM transactions WHERE plaid_transaction_id = ? AND is_split = 1 AND amount_cents = ?
				) AND ${OWNS_LOCK}`).bind(
						transaction.date,
						transaction.name,
						merchantNameOf(transaction),
						transaction.transaction_id,
						cents,
						itemRowId,
						lockId,
					),
				);
				statements.push(partsExclusion(env, itemRowId, lockId, transaction));
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET date = ?,
							split_removed_from_cents = CASE WHEN is_split = 1 AND amount_cents != ? THEN amount_cents ELSE split_removed_from_cents END,
							category_id = CASE WHEN ((is_split = 1 OR category_source = 'jev') AND amount_cents != ?) OR (category_source = 'merchant_rule' AND ${merchantKeySql("transactions")} != ?) THEN NULL ELSE category_id END,
							category_source = CASE WHEN ((is_split = 1 OR category_source = 'jev') AND amount_cents != ?) OR (category_source = 'merchant_rule' AND ${merchantKeySql("transactions")} != ?) THEN NULL ELSE category_source END,
							category_confidence = CASE WHEN amount_cents != ? THEN NULL ELSE category_confidence END,
							jev_category_id = CASE WHEN amount_cents != ? THEN NULL ELSE jev_category_id END,
							is_split = CASE WHEN is_split = 1 AND amount_cents != ? THEN 0 ELSE is_split END,
							amount_cents = ?, raw_name = ?, merchant_name = ?,
							plaid_category = ?,
							${plaidTransferRuleSql("?")},
							flag_income = CASE WHEN income_source = 'jev' AND amount_cents != ? THEN 0 ELSE flag_income END,
							income_source = CASE WHEN income_source = 'jev' AND amount_cents != ? THEN NULL ELSE income_source END,
							credit_reviewed = CASE WHEN credit_reviewed_by = 'user' THEN credit_reviewed WHEN amount_cents = ? THEN credit_reviewed WHEN ? < 0 THEN 0 ELSE 1 END,
							credit_reviewed_by = CASE WHEN credit_reviewed_by = 'jev' AND amount_cents != ? THEN NULL ELSE credit_reviewed_by END,
							updated_at = datetime('now')
						 WHERE plaid_transaction_id = ? AND ${OWNS_LOCK}`,
					).bind(
						transaction.date,
						cents,
						cents,
						newKey,
						cents,
						newKey,
						cents,
						cents,
						cents,
						cents,
						transaction.name,
						merchantNameOf(transaction),
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.primary ?? null,
						cents,
						cents,
						cents,
						cents,
						cents,
						transaction.transaction_id,
						itemRowId,
						lockId,
					),
				);
			}
			// When Plaid first names a merchant (the key differs from the bank text), the merchant's settings row
			// starts as a copy of the row saved under the bank text, if there is one: its name, rule and Not a
			// bill carry over. The first copy wins, and a later edit to the old row never reaches the new one.
			for (const transaction of [...posted, ...page.modified]) {
				const key = merchantNameOf(transaction);
				if (!key || key === transaction.name) continue;
				statements.push(
					env.DB.prepare(
						`INSERT INTO merchants (raw_name, suggested_name, display_name, default_category_id, suggestion_status, not_a_bill)
						 SELECT ?, suggested_name, display_name, default_category_id, suggestion_status, not_a_bill FROM merchants
						 WHERE raw_name = ? AND NOT EXISTS (SELECT 1 FROM merchants WHERE raw_name = ?) AND ${OWNS_LOCK}`,
					).bind(key, transaction.name, key, itemRowId, lockId),
				);
			}
			for (const transaction of page.removed) {
				statements.push(
					env.DB.prepare(
						`DELETE FROM transactions WHERE plaid_transaction_id = ? AND ${OWNS_LOCK}`,
					).bind(transaction.transaction_id, itemRowId, lockId),
				);
			}
			statements.push(
				env.DB.prepare(
					`UPDATE plaid_items SET sync_cursor = ?${page.has_more ? "" : ", last_synced_at = datetime('now')"}
					 WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL`,
				).bind(page.next_cursor, itemRowId, lockId),
			);
			const results = await env.DB.batch(statements);
			// The renewal changed nothing: a newer run owns the Item, and every guarded write above was a no-op.
			if (results[0]?.meta.changes === 0) {
				throw new Error("Plaid sync lost its lock to a newer run");
			}
			let inserted = 0;
			for (const [index, transaction] of posted.entries()) {
				const changed =
					results[firstAddedStatement + index * 5 + 4]?.meta.changes ?? 0;
				if (
					changed > 0 &&
					(!existingTransactionIds.has(transaction.transaction_id) ||
						addedDuringRun.has(transaction.transaction_id))
				) {
					inserted += 1;
				}
				if (
					!existingTransactionIds.has(transaction.transaction_id) &&
					changed > 0
				) {
					addedDuringRun.add(transaction.transaction_id);
				}
			}

			cursor = page.next_cursor;
			firstPage = false;
			summary.added += inserted;
			summary.modified += page.modified.length;
			summary.removed += page.removed.length;
			if (inserted + page.modified.length + page.removed.length > 0) {
				console.log(
					`plaid sync: added ${inserted}, modified ${page.modified.length}, removed ${page.removed.length}`,
				);
			}
			if (!page.has_more) {
				await matchBillPayments(env.DB);
				return summary;
			}
		}
	} finally {
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_locked_until = NULL, sync_lock_id = NULL WHERE id = ? AND sync_lock_id = ?",
		)
			.bind(itemRowId, lockId)
			.run();
	}
}
