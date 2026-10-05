import { PLAID_INCOME_CATEGORY, syncedIncomeFlagSql } from "../db/income";
import { merchantKeySql } from "../db/merchant-key";
import { unlinkOverRefundedSql } from "../db/refunded";
import { plaidAmountToCents } from "../money";
import { afterSync } from "./after-sync";
import { type PlaidEnv, PlaidError, plaidPost } from "./client";
import { loginStillBroken } from "./login-broken";
import { mergePendingIntoPosted } from "./pending-merge";
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
	/** On a posted transaction, the id of the pending one it replaces, when the bank gave one. */
	pending_transaction_id?: string | null;
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
	// The daily catch-up and Sync now sync every bank, then run the after-sync step once for all of them.
	{ runAfterSync = true }: { runAfterSync?: boolean } = {},
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
		// Pending transactions the bank dropped on an earlier page of this run, and where the run's saved
		// position is held while any waits (see below).
		const waitingDrops = new Set<string>();
		let holdAt: { cursor: string | null } | null = null;

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
					waitingDrops.clear();
					holdAt = null;
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

			// Pending transactions are stored and counted like posted ones (decision 67).
			const added = page.added;
			if (
				added.some((transaction) => !knownAccounts.has(transaction.account_id))
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
			if (added.length > 0) {
				const placeholders = added.map(() => "?").join(", ");
				const existing = await env.DB.prepare(
					`SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id IN (${placeholders})`,
				)
					.bind(...added.map((transaction) => transaction.transaction_id))
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
			// Where each added transaction's statements sit in the batch, to read what they changed.
			const addedAt: { upsert: number; rekey?: number }[] = [];
			for (const transaction of added) {
				const cents = plaidAmountToCents(transaction.amount);
				let rekey: number | undefined;
				// The bank posted a pending transaction under a new id (and drops the pending id). The pending
				// row takes the posted id and stays the same row, so whatever a person or Tally attached to it
				// (category, note, exclusion, income choice, bill payment, refund links both ways, split parts)
				// is still attached, with nothing copied. The statements below then treat the row like any
				// bank correction: the posted date and amount are written, a split is removed when the amount
				// changed and kept, with its parts following the date, when it didn't. When the posted id is
				// already stored (its link arrives late), both rows exist, so the pending row's attachments
				// are moved onto the posted one and the pending row deleted instead (pending-merge.ts).
				if (!transaction.pending && transaction.pending_transaction_id) {
					rekey = statements.length;
					statements.push(
						env.DB.prepare(
							`UPDATE transactions SET plaid_transaction_id = ?
							 WHERE plaid_transaction_id = ? AND pending = 1
							 AND NOT EXISTS (SELECT 1 FROM transactions WHERE plaid_transaction_id = ?) AND ${OWNS_LOCK}`,
						).bind(
							transaction.transaction_id,
							transaction.pending_transaction_id,
							transaction.transaction_id,
							itemRowId,
							lockId,
						),
					);
					if (existingTransactionIds.has(transaction.transaction_id)) {
						statements.push(
							...mergePendingIntoPosted(
								env.DB,
								itemRowId,
								lockId,
								transaction.pending_transaction_id,
								{
									id: transaction.transaction_id,
									cents,
									date: transaction.date,
									name: transaction.name,
									merchantName: merchantNameOf(transaction),
								},
							),
						);
					}
				}
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
				statements.push(
					env.DB.prepare(
						`INSERT INTO transactions
							(plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, plaid_category, credit_reviewed, flag_income, pending)
						 SELECT ?, id, ?, ?, ?, ?, ?, CASE WHEN ? < 0 THEN 0 ELSE 1 END, CASE WHEN ? = '${PLAID_INCOME_CATEGORY}' AND ? < 0 THEN 1 ELSE 0 END, ? FROM accounts
						 WHERE plaid_account_id = ? AND ${OWNS_LOCK}
						 ON CONFLICT(plaid_transaction_id) DO UPDATE SET
							date = excluded.date,
								flag_income = ${syncedIncomeFlagSql("transactions", "excluded.plaid_category", "excluded.amount_cents")},
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
							pending = excluded.pending,
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
						cents,
						transaction.pending ? 1 : 0,
						transaction.account_id,
						itemRowId,
						lockId,
					),
				);
				addedAt.push({ upsert: statements.length - 1, rekey });
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
							plaid_category = ?, pending = ?,
							flag_income = ${syncedIncomeFlagSql("transactions", "?", "?")},
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
						transaction.pending ? 1 : 0,
						transaction.personal_finance_category?.primary ?? null,
						cents,
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
			// A corrected amount can leave a purchase refunded for more than it is worth (spec §8.5). Once this
			// page's amounts are written, in the same batch, the refunds that no longer fit lose their link,
			// newest first; a person can link them again. Only the purchases these transactions touch are checked.
			for (const transaction of [...posted, ...page.modified]) {
				statements.push(
					env.DB.prepare(unlinkOverRefundedSql(OWNS_LOCK)).bind(
						transaction.transaction_id,
						transaction.transaction_id,
						itemRowId,
						lockId,
					),
				);
			}
			// When Plaid first names a merchant (the key differs from the bank text), the merchant's settings row
			// starts as a copy of the row saved under the bank text, if there is one: its name, rule and Not a
			// bill carry over. The first copy wins, and a later edit to the old row never reaches the new one.
			for (const transaction of [...added, ...page.modified]) {
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
			// A pending transaction the bank drops waits for the update's last page before it is deleted, because
			// its posted twin can arrive on a later page (Plaid doesn't promise they share one) and must still
			// find it. While any waits, the saved position stays at the page that dropped the first, so an
			// update that stops partway sees the drop again. A posted transaction the bank removes goes at once,
			// and so does a pending one whose posted twin is on this page, which took the row over above.
			const drops = new Set(page.removed.map((gone) => gone.transaction_id));
			if (page.has_more) {
				const unsettled = [...drops].filter(
					(id) => !added.some((twin) => twin.pending_transaction_id === id),
				);
				if (unsettled.length > 0) {
					const marks = unsettled.map(() => "?").join(", ");
					const pendingDrops = await env.DB.prepare(
						`SELECT plaid_transaction_id FROM transactions WHERE pending = 1 AND plaid_transaction_id IN (${marks})`,
					)
						.bind(...unsettled)
						.all<{ plaid_transaction_id: string }>();
					for (const { plaid_transaction_id } of pendingDrops.results) {
						waitingDrops.add(plaid_transaction_id);
						drops.delete(plaid_transaction_id);
					}
				}
				if (waitingDrops.size > 0) holdAt ??= { cursor };
			} else {
				for (const id of waitingDrops) drops.add(id);
			}
			for (const id of drops) {
				statements.push(
					env.DB.prepare(
						`DELETE FROM transactions WHERE plaid_transaction_id = ? AND ${OWNS_LOCK}`,
					).bind(id, itemRowId, lockId),
				);
			}
			statements.push(
				env.DB.prepare(
					`UPDATE plaid_items SET sync_cursor = ?${page.has_more ? "" : ", last_synced_at = datetime('now')"}
					 WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL`,
				).bind(
					page.has_more && holdAt ? holdAt.cursor : page.next_cursor,
					itemRowId,
					lockId,
				),
			);
			const results = await env.DB.batch(statements);
			// The renewal changed nothing: a newer run owns the Item, and every guarded write above was a no-op.
			if (results[0]?.meta.changes === 0) {
				throw new Error("Plaid sync lost its lock to a newer run");
			}
			let inserted = 0;
			for (const [index, transaction] of added.entries()) {
				const at = addedAt[index];
				if (!at) continue;
				// A posted transaction that took over a pending row isn't new: it counted when it arrived pending.
				if (
					at.rekey !== undefined &&
					(results[at.rekey]?.meta.changes ?? 0) > 0
				)
					continue;
				const changed = results[at.upsert]?.meta.changes ?? 0;
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
				if (runAfterSync) await afterSync(env.DB);
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
