import { movePartDismissalsSql } from "../bills/split-dismissals";
import { UNPAID_BILLS_SQL } from "../bills/unpaid";
import { householdToday } from "../dates";
import { PLAID_INCOME_CATEGORY, syncedIncomeFlagSql } from "../db/income";
import { merchantKeySql } from "../db/merchant-key";
import { pendingNameStatements, suggestBankNames } from "../db/merchant-names";
import {
	isPlaidTransferSql,
	plaidTransferRuleSql,
} from "../db/plaid-transfers";
import {
	SYNCED_PAYMENTS_SQL,
	unlinkUnfitPlanPaymentsSql,
} from "../db/planned-expenses";
import { unlinkOverRefundedSql } from "../db/refunded";
import { plaidAmountToCents } from "../money";
import { tidyName } from "../transactions/tidy-name";
import { afterSync } from "./after-sync";
import {
	bareColumn,
	columnOf,
	jevGuessClearedByAmountSql,
	setCategoryClearedByBankSql,
} from "./category-clear";
import { type PlaidEnv, PlaidError, plaidPost } from "./client";
import { markNeedsAttention, markSyncSucceeded, readSeen } from "./item-store";
import { loginStillBroken } from "./login-broken";
import { mergePendingIntoPosted } from "./pending-merge";
import { SYNC_LEASE_MINUTES } from "./timing";
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
	personal_finance_category?: {
		primary?: string | null;
		detailed?: string | null;
	} | null;
};

type SyncResponse = {
	added: PlaidTransaction[];
	modified: PlaidTransaction[];
	removed: { transaction_id: string }[];
	next_cursor: string;
	has_more: boolean;
	/**
	 * Plaid's own report of the Item's pulls: TRANSACTIONS_UPDATE_STATUS_UNKNOWN, NOT_READY, INITIAL_UPDATE_COMPLETE or
	 * HISTORICAL_UPDATE_COMPLETE (Plaid's transactions API reference, /transactions/sync).
	 */
	transactions_update_status?: string | null;
};

/** Plaid's transactions_update_status once the Item's 90-day history is in (spec §5, #581). */
const HISTORICAL_UPDATE_COMPLETE = "HISTORICAL_UPDATE_COMPLETE";

/** The body of a /transactions/sync request. The cursor is sent only once Plaid has one. */
type SyncRequest = {
	access_token: string;
	count: number;
	cursor?: string;
};

type ItemRow = {
	access_token_encrypted: ArrayBuffer;
	sync_cursor: string | null;
	sync_update_cursor: string | null;
};

/** Item errors that clear up on their own; every other ITEM_ERROR needs the person to fix the connection. */
export const TRANSIENT_ITEM_ERROR_CODES = [
	"PRODUCT_NOT_READY",
	"TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
] as const;

const transient = new Set<string>(TRANSIENT_ITEM_ERROR_CODES);

/** Jev's confidence and category suggestion columns all describe the transaction's current amount. */
const clearJevAnswersOnAmountChange = (changed: string) =>
	`category_confidence = CASE WHEN ${changed} THEN NULL ELSE category_confidence END,
	 category_suggestion_id = CASE WHEN ${changed} THEN NULL ELSE category_suggestion_id END,
	 jev_none_fit = CASE WHEN ${changed} THEN 0 ELSE jev_none_fit END,
	 jev_category_id = CASE WHEN ${changed} THEN NULL ELSE jev_category_id END,
	 jev_mixed = CASE WHEN ${changed} THEN NULL ELSE jev_mixed END,
	 jev_also_category_id = CASE WHEN ${changed} THEN NULL ELSE jev_also_category_id END,
	 income_confidence = CASE WHEN ${changed} THEN NULL ELSE income_confidence END,
	 transfer_confidence = CASE WHEN ${changed} THEN NULL ELSE transfer_confidence END`;

export type SyncSummary = {
	added: number;
	modified: number;
	removed: number;
	/**
	 * The ids of the transaction rows this sync added or modified, for the run that sorts them right
	 * after it (spec §8.6): one the bank posted under a new id is its pending row, which is the same row.
	 * Some may already be sorted or asked about; the run asks about the ones that aren't.
	 */
	changedIds: number[];
};

export type SyncResult = SyncSummary | { skipped: true };

/** Plaid's cleaned merchant name, or null when it sent none or a blank one (spec §5, decision 67). */
const merchantNameOf = (transaction: PlaidTransaction) =>
	transaction.merchant_name?.trim() || null;

/**
 * Plaid's cleaned name when it is worth suggesting as the merchant's name (spec §8.6, issue #194): it
 * is not blank, and it is not what the list already shows, which is the bank's own text or that text
 * tidied by code (decision 46). Otherwise null.
 */
function plaidNameToSuggest(transaction: PlaidTransaction): string | null {
	const name = merchantNameOf(transaction);

	if (!name) return null;

	if (name === transaction.name || name === tidyName(transaction.name)) {
		return null;
	}

	return name;
}

// The names a page saves for its merchants are a few statements for the whole page, never one per charge: the
// page's statements go in one D1 batch, which must finish within D1's 30-second limit on a whole batch call, so
// they are kept few. Each reads its charges from one JSON array through `json_each`, since D1 allows only 100
// bound values in a statement, and ends with the Item's lock (`OWNS_LOCK`, which brings two `?`s of its own).

/**
 * The rank of a merchant's suggestion, lowest first: 0 a decided suggestion (accepted or rejected); 1 a waiting guess when
 * nobody named the merchant, 4 when somebody did; 2 an empty answer (`names_asked`); 3 nothing at all. `named` is the SQL
 * that says a person named the merchant. The copy ranks with it on both sides of its upsert, so the two can't drift apart.
 */
const suggestionPickSql = (status: string, asked: string, named: string) =>
	`CASE WHEN ${status} IN ('accepted', 'rejected') THEN 0
	   WHEN ${status} = 'pending' AND NOT (${named}) THEN 1
	   WHEN ${status} = 'pending' THEN 4
	   WHEN ${asked} = 1 THEN 2
	   ELSE 3 END`;

/**
 * True when a merchant's suggested names are exactly its key, the bank's own name (name-suggestions.ts isBankName): one
 * row, and it is the key. `key` is SQL for the merchant's key.
 */
const bankOnlySql = (key: string) =>
	`((SELECT COUNT(*) FROM merchant_suggested_names x WHERE x.merchant_key = ${key}) = 1
	   AND EXISTS (SELECT 1 FROM merchant_suggested_names x WHERE x.merchant_key = ${key} AND x.name = ${key}))`;

/**
 * True when a person named the merchant `key` (SQL), within this page: one of the page's texts for it, or its own row,
 * holds a chosen name. Needs the `pair` CTE of COPY_WINNERS in scope.
 */
const namedKeySql = (key: string) =>
	`(EXISTS (SELECT 1 FROM pair q JOIN merchants d ON d.raw_name = q.t WHERE q.k = ${key} AND d.display_name IS NOT NULL)
	   OR EXISTS (SELECT 1 FROM merchants ow WHERE ow.raw_name = ${key} AND ow.display_name IS NOT NULL))`;

/**
 * The winner of each Plaid name the page starts a row for (copyPlaidNamesSql). One `?` for the pairs, a JSON array of
 * `[Plaid name, bank text]` in the order the charges arrived, and one for this run's lock id. A name starts a row when
 * it has none, and goes on filling the one it has only when this run made it (`started_by_sync`, #1048): the test is in
 * the statement, so two banks syncing at the same moment can't both pass it. The candidates for a name are the rows of its page's bank texts, and its own row when it has one as
 * candidate `n = -1` so it wins a tie. A candidate's rank is pickSql's, with the same `named` for every candidate of the
 * name. `winner.t` is the bank text whose row the name takes, or NULL when its own row wins. The three statements of
 * copyPlaidNamesSql all read this CTE, and it is read before any of them writes, so they agree with each other.
 */
const COPY_WINNERS = `WITH pair(k, t, n) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), key FROM json_each(?)),
	 src(k, n, t, pick, status, asked, display_name, default_category_id, not_a_bill) AS (
	   SELECT p.k, p.n, p.t, ${suggestionPickSql("m.suggestion_status", "m.names_asked", namedKeySql("p.k"))}, m.suggestion_status, m.names_asked,
	     m.display_name, m.default_category_id, m.not_a_bill
	   FROM pair p JOIN merchants m ON m.raw_name = p.t
	   WHERE NOT EXISTS (SELECT 1 FROM merchants x WHERE x.raw_name = p.k AND x.started_by_sync IS NOT ?)),
	 cand(k, n, t, pick, status, asked) AS (
	   SELECT k, n, t, pick, status, asked FROM src
	   UNION ALL
	   SELECT m.raw_name, -1, NULL, ${suggestionPickSql("m.suggestion_status", "m.names_asked", namedKeySql("m.raw_name"))}, m.suggestion_status, m.names_asked
	   FROM merchants m WHERE m.raw_name IN (SELECT k FROM src)),
	 winner(k, t, status, asked) AS (
	   SELECT g.k,
	     (SELECT c.t FROM cand c WHERE c.k = g.k ORDER BY c.pick, c.n LIMIT 1),
	     (SELECT c.status FROM cand c WHERE c.k = g.k ORDER BY c.pick, c.n LIMIT 1),
	     (SELECT c.asked FROM cand c WHERE c.k = g.k ORDER BY c.pick, c.n LIMIT 1)
	   FROM (SELECT DISTINCT k FROM src) g)`;

/**
 * Starts the merchant row of each Plaid name from the rows saved under the bank texts it came with, unless the name has a
 * row an earlier sync made (see COPY_WINNERS for the winner). The merchant takes its status and names_asked from the
 * winner, and a name's display name, default category and Not a bill come from the first text that has each. An
 * existing row keeps its own status unless the winner ranks strictly better, the same comparison COPY_WINNERS makes
 * (`takeNew`), so the two statements can't disagree. The names are copied by copyPlaidNamesSql, which runs first.
 * A row it makes records this run (`started_by_sync`); a row it fills keeps its mark. Three `?`s, then the lock's: the
 * pairs and the lock id for COPY_WINNERS, and the lock id again for the new row.
 */
const copyMerchantRowSql = (ownsLock: string) => {
	const namedNow =
		"merchants.display_name IS NOT NULL OR excluded.display_name IS NOT NULL";

	const takeNew = `${suggestionPickSql("excluded.suggestion_status", "excluded.names_asked", namedNow)} < ${suggestionPickSql("merchants.suggestion_status", "merchants.names_asked", namedNow)}`;

	return `${COPY_WINNERS}
	 INSERT INTO merchants (raw_name, display_name, default_category_id, suggestion_status, names_asked, not_a_bill, started_by_sync)
	 SELECT w.k,
	   (SELECT s.display_name FROM src s WHERE s.k = w.k AND s.display_name IS NOT NULL ORDER BY s.n LIMIT 1),
	   (SELECT s.default_category_id FROM src s WHERE s.k = w.k AND s.default_category_id IS NOT NULL ORDER BY s.n LIMIT 1),
	   w.status, w.asked,
	   (SELECT MAX(s.not_a_bill) FROM src s WHERE s.k = w.k), ?
	 FROM winner w
	 WHERE ${ownsLock}
	 ON CONFLICT(raw_name) DO UPDATE SET
	   suggestion_status = CASE WHEN ${takeNew} THEN excluded.suggestion_status ELSE merchants.suggestion_status END,
	   names_asked = CASE WHEN ${takeNew} THEN excluded.names_asked ELSE merchants.names_asked END,
	   display_name = COALESCE(merchants.display_name, excluded.display_name),
	   default_category_id = COALESCE(merchants.default_category_id, excluded.default_category_id),
	   not_a_bill = MAX(merchants.not_a_bill, excluded.not_a_bill)`;
};

/**
 * The names of each Plaid name's winner (COPY_WINNERS), written before copyMerchantRowSql so both read the state from before
 * this page: first one INSERT OR REPLACE of the winner's rows under the Plaid name (SQLite reads the names it copies from
 * before it writes them, so a bank text that is also another name on the page is copied as it was), then one DELETE of
 * the name's positions past the winner's count, which removes the names it had before. Winners with no rows of their own
 * (an empty answer, or none at all) leave the name with none. A winner that is the name's own row changes nothing.
 * Both carry the lock, so a lost lock writes neither.
 *
 * Why the second statement is right though it reads counts after the first has written:
 * - The first statement only overwrites positions below the winner's pre-page count and never deletes, so the count the
 *   second statement reads for a text is never lower than that text's own pre-page count.
 * - A winner that has names is never rewritten by this statement while it wins for a destination that has names. A
 *   winner beats a destination with names only when it ranks strictly better, which needs a decided text (rank 0; its own
 *   row can't be beaten, so it isn't rewritten) or, for a named pending destination, a none-asked text, which has no
 *   names (invariant I1).
 * - A none winner has no names, so the second statement removes all of the destination's names (position >= 0). This is
 *   the case that used to leave a destination's old names for the sweep: a none-asked text beats a named pending
 *   destination, and then only the unscoped sweep (sweepStaleNamesSql, which runs later in the same batch) removed them.
 *   The copy now does this itself; the sweep is still needed for the withdrawals (withdrawOlderPlaidNamesSql and
 *   clearStaleGuessesSql) and must not be removed. Regression test: "leaves the destination with no names ..." in
 *   test/plaid-sync-names.test.ts, which passes with the sweep disabled.
 */
const copyPlaidNamesSql = (ownsLock: string): [string, string] => [
	`${COPY_WINNERS}
	 INSERT OR REPLACE INTO merchant_suggested_names (merchant_key, position, name)
	 SELECT w.k, s.position, s.name FROM winner w JOIN merchant_suggested_names s ON s.merchant_key = w.t
	 WHERE w.t IS NOT NULL AND ${ownsLock}`,
	`${COPY_WINNERS}
	 DELETE FROM merchant_suggested_names
	 WHERE merchant_key IN (SELECT w.k FROM winner w WHERE w.t IS NOT NULL)
	   AND position >= (SELECT CASE WHEN w2.status = 'none' THEN 0
	     ELSE (SELECT COUNT(*) FROM merchant_suggested_names s WHERE s.merchant_key = w2.t) END
	     FROM winner w2 WHERE w2.k = merchant_suggested_names.merchant_key)
	   AND ${ownsLock}`,
];

/**
 * Gives each Plaid name the "Never suggest" lines of the bank text it came with (decision 101), with each line's
 * day. It runs on every page that names the store, not only the first time: lines are a set, and a line the name
 * already has keeps its own day. A Remove takes a line away under every key the store goes by at once
 * (removeNeverSuggest), so this copy never brings a removed line back. The bank-text line stays, since charges with
 * no Plaid name still key on it. One `?`: the same pairs as copyMerchantRowSql.
 */
const copyNeverSuggestSql = (ownsLock: string) =>
	`WITH pair(k, t) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
	 INSERT OR IGNORE INTO never_suggest_rules (merchant_key, kind, decided_on)
	 SELECT p.k, r.kind, r.decided_on FROM pair p JOIN never_suggest_rules r ON r.merchant_key = p.t
	 WHERE ${ownsLock}`;

/**
 * Withdraws the waiting suggestion of a Plaid name that is no longer the newest for a bank text (spec §8.6,
 * decision 79). One `?`: the bank texts to look at, a JSON array of `[text, text tidied]` pairs. It
 * includes every text using a Plaid name changed on this page, so a shared name stays while newest for any text. A row is
 * the bank's own suggestion when its names are exactly its key (bankOnlySql), and it is withdrawn only when nobody has
 * named it, it has a charge with one of these bank texts, and it is the newest Plaid name (latest date, then latest id)
 * for none of its charges' bank texts. Its names go with it in the page's last name statement (sweepStaleNamesSql).
 *
 * The texts are read before the page is saved, because only TypeScript can tidy one, so another bank's sync can store a
 * charge with the same Plaid name under a text that isn't among them (#1048). The last test covers that: a name that is
 * the newest for a text the page never looked at stays, as it would had the other bank's charge come first.
 */
const withdrawOlderPlaidNamesSql = (ownsLock: string) =>
	`WITH pair(text, tidied) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
	 UPDATE merchants SET suggestion_status = 'none', names_asked = 0
	 WHERE suggestion_status = 'pending' AND display_name IS NULL AND ${bankOnlySql("merchants.raw_name")}
	   AND EXISTS (SELECT 1 FROM transactions t WHERE t.raw_name IN (SELECT text FROM pair)
	     AND t.parent_id IS NULL AND t.merchant_name = merchants.raw_name)
	   AND NOT EXISTS (
	     SELECT 1 FROM transactions c JOIN pair p ON p.text = c.raw_name
	     WHERE c.parent_id IS NULL AND c.merchant_name = merchants.raw_name
	       AND c.merchant_name != p.tidied
	       AND c.merchant_name = (SELECT n.merchant_name FROM transactions n
	         WHERE n.raw_name = c.raw_name AND n.parent_id IS NULL AND NULLIF(n.merchant_name, '') IS NOT NULL
	         ORDER BY n.date DESC, n.id DESC LIMIT 1))
	   AND NOT EXISTS (
	     SELECT 1 FROM transactions o
	     WHERE o.parent_id IS NULL AND o.merchant_name = merchants.raw_name
	       AND o.raw_name NOT IN (SELECT text FROM pair)
	       AND o.merchant_name = (SELECT n.merchant_name FROM transactions n
	         WHERE n.raw_name = o.raw_name AND n.parent_id IS NULL AND NULLIF(n.merchant_name, '') IS NOT NULL
	         ORDER BY n.date DESC, n.id DESC LIMIT 1))
	   AND ${ownsLock}`;

/**
 * The charges' Plaid names this page suggests, as the keys of pendingNameStatements: each bank text's newest remaining
 * charge (latest date, then latest id) that has a Plaid name, unless that name is only the text or the text tidied.
 * It is read once the page's writes are all in, so a text a charge has left offers the name of the charge that is newest
 * now. `?`: the same pairs as withdrawOlderPlaidNamesSql.
 */
const newestPlaidNameCandidatesSql = `SELECT DISTINCT n.merchant_name AS value FROM json_each(?) AS a
	 JOIN transactions n ON n.id = (SELECT x.id FROM transactions x
	   WHERE x.raw_name = json_extract(a.value, '$[0]') AND x.parent_id IS NULL AND NULLIF(x.merchant_name, '') IS NOT NULL
	   ORDER BY x.date DESC, x.id DESC LIMIT 1)
	 WHERE n.merchant_name != json_extract(a.value, '$[0]') AND n.merchant_name != json_extract(a.value, '$[1]')`;

/**
 * Clears a guess still waiting on the merchant of a Plaid name that needs no suggestion (the text, or the
 * text tidied; decision 79). Workers AI is asked only about texts Plaid doesn't name (decision 68), so a guess made before
 * Plaid named the text, and copied to the merchant with the rest of the row, is stale. A guess is a waiting suggestion
 * whose names aren't exactly its key. A name a person chose, a suggestion they decided, the bank's own name, and a guess
 * that charges with no Plaid name still read from this row are left alone. One `?`: the names, a JSON array.
 */
const clearStaleGuessesSql = (ownsLock: string) =>
	`UPDATE merchants SET suggestion_status = 'none', names_asked = 0
	 WHERE raw_name IN (SELECT value FROM json_each(?))
	   AND suggestion_status = 'pending' AND display_name IS NULL AND NOT ${bankOnlySql("merchants.raw_name")}
	   AND NOT EXISTS (SELECT 1 FROM transactions u WHERE u.raw_name = merchants.raw_name AND u.parent_id IS NULL AND NULLIF(u.merchant_name, '') IS NULL)
	   AND ${ownsLock}`;

/**
 * Removes the names of every merchant that is now `none` (invariant I1). The statements that withdraw a suggestion set its
 * status to none and leave its rows, so the page's last name statement sweeps them. It is unscoped, since the keys a
 * withdrawal changed can't be found again. Carries the lock.
 */
const sweepStaleNamesSql = (ownsLock: string) =>
	`DELETE FROM merchant_suggested_names
	 WHERE merchant_key IN (SELECT raw_name FROM merchants WHERE suggestion_status = 'none')
	   AND ${ownsLock}`;

/** True only while this run still holds the Item's lock; every page write carries it. */
const OWNS_LOCK =
	"EXISTS (SELECT 1 FROM plaid_items WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL)";

/**
 * Before a bank change removes a split (its amount changed), the bills its parts paid are kept on the
 * purchase for its note, and their payments are unlinked with no dismissal left, so the matcher may link
 * the bill to the purchase again when it still matches (decisions 99 and 105).
 * Both run before the parts are deleted.
 */
function splitBillStatements(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	plaidTransactionId: string,
	cents: number,
): D1PreparedStatement[] {
	const purchase =
		"(SELECT id FROM transactions WHERE plaid_transaction_id = ?1 AND is_split = 1 AND amount_cents != ?2)";

	return [
		env.DB.prepare(
			`UPDATE transactions SET split_removed_bills = ${UNPAID_BILLS_SQL("transactions.id")}
			 WHERE plaid_transaction_id = ? AND is_split = 1 AND amount_cents != ? AND ${OWNS_LOCK}`,
		).bind(plaidTransactionId, cents, itemRowId, lockId),
		// A person's own Not this one on a part moves onto the purchase before the parts go, which takes the rest of
		// their payments with them (decision 105).
		env.DB.prepare(
			movePartDismissalsSql(
				purchase,
				purchase,
				"EXISTS (SELECT 1 FROM plaid_items WHERE id = ?3 AND sync_lock_id = ?4 AND disconnected_at IS NULL)",
			),
		).bind(plaidTransactionId, cents, itemRowId, lockId),
	];
}

/**
 * A bank correction that clears Jev's category (its amount changed) lets go of that category's What AI did
 * row, so a later pick isn't counted as changing Tally's work; the row still counts as sorted (spec section 5).
 * It uses the same Jev case as the category CASE in both update statements below (src/plaid/category-clear.ts).
 */
function forgetClearedJevLog(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	plaidTransactionId: string,
	cents: number,
): D1PreparedStatement {
	return env.DB.prepare(
		`UPDATE ai_log SET transaction_id = NULL
		 WHERE kind = 'category' AND transaction_id = (
			SELECT id FROM transactions WHERE plaid_transaction_id = ?
			AND ${jevGuessClearedByAmountSql(bareColumn, "amount_cents != ?")}
		 ) AND ${OWNS_LOCK}`,
	).bind(plaidTransactionId, cents, itemRowId, lockId);
}

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
		`UPDATE transactions SET ${plaidTransferRuleSql("?", "transactions.amount_cents")}
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

/**
 * Today's balance of each account Plaid gave one for, for the net-worth chart (spec §5, §8.3): one
 * row per account per household day, and a later sync the same day overwrites it. It's the same
 * `balances.current` the account row takes, so a card's is the amount owed, positive.
 */
function balanceSnapshots(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	today: string,
	accounts: PlaidAccount[],
): D1PreparedStatement[] {
	return accounts.flatMap((account) => {
		const current = account.balances.current;

		if (current === null || current === undefined) return [];

		return env.DB.prepare(
			`INSERT INTO balance_history (account_id, date, balance_cents)
			 SELECT id, ?, ? FROM accounts WHERE plaid_account_id = ? AND ${OWNS_LOCK}
			 ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`,
		).bind(
			today,
			plaidAmountToCents(current),
			account.account_id,
			itemRowId,
			lockId,
		);
	});
}

async function handlePlaidError(
	env: SyncEnv,
	itemRowId: number,
	lockId: string,
	accessTokenEncrypted: ArrayBuffer,
	error: PlaidError,
	fetchImpl?: typeof fetch,
): Promise<never> {
	if (error instanceof PlaidError) {
		console.error(`plaid sync error ${error.request_id ?? ""}`.trim());

		if (
			error.error_type === "ITEM_ERROR" &&
			!transient.has(error.error_code ?? "")
		) {
			// The state read before Plaid is asked again, so a repair made meanwhile is not overwritten.
			const seen = await readSeen(env.DB, itemRowId);

			if (
				seen !== null &&
				(await loginStillBroken(env, accessTokenEncrypted, fetchImpl))
			) {
				await markNeedsAttention(env.DB, itemRowId, "login", { seen, lockId });
			}
		}
	}

	throw error;
}

/**
 * Adds the row ids of these Plaid transactions to `into`. The ids go in as one JSON array read by
 * `json_each`, since D1 allows 100 bound values in a statement. The page is already saved, and the
 * ids only tell the run after the sync what to ask about, so a failure here never fails the sync: the
 * rows wait for the nightly run.
 */
async function collectChangedIds(
	db: D1Database,
	plaidIds: string[],
	into: Set<number>,
): Promise<void> {
	if (plaidIds.length === 0) return;

	try {
		const { results } = await db
			.prepare(
				"SELECT id FROM transactions WHERE plaid_transaction_id IN (SELECT value FROM json_each(?))",
			)
			.bind(JSON.stringify(plaidIds))
			.all<{ id: number }>();

		for (const row of results) into.add(row.id);
	} catch {
		console.error("plaid sync: couldn't list the changed rows");
	}
}

/** Pulls every available page for one Item, committing each page and its cursor atomically. */
export async function syncItem(
	env: SyncEnv,
	itemRowId: number,
	fetchImpl?: typeof fetch,
	// The daily catch-up and Sync now sync every bank, then run the after-sync step once for all of them.
	// `historyComplete`: the webhook said Plaid's 90-day history is in, so this sync ran after it (#581).
	{
		runAfterSync = true,
		historyComplete = false,
	}: {
		runAfterSync?: boolean;
		historyComplete?: boolean;
	} = {},
): Promise<SyncResult> {
	const lockId = crypto.randomUUID();

	const lock = await env.DB.prepare(
		`UPDATE plaid_items SET sync_locked_until = datetime('now', '+${SYNC_LEASE_MINUTES} minutes'), sync_lock_id = ?
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
			"SELECT access_token_encrypted, sync_cursor, sync_update_cursor FROM plaid_items WHERE id = ?",
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
			if (!(error instanceof PlaidError)) throw error;

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

		// The run goes on from the saved position. An update that changed while it was being paged starts again from its
		// first page's cursor (Plaid's rule), which an earlier run saved if it stored part of this update and stopped
		// (sync_update_cursor, decision 221); otherwise the saved position is itself where this update begins.
		const firstCursor =
			item.sync_update_cursor === null
				? item.sync_cursor
				: item.sync_update_cursor || null;

		let cursor = item.sync_cursor;
		let mutationRestarts = 0;
		let firstPage = true;
		let summary = { added: 0, modified: 0, removed: 0 };
		// Kept across a restart: the rows an abandoned pass wrote are still written.
		const changedIds = new Set<number>();
		const addedDuringRun = new Set<string>();
		// Pending transactions the bank dropped on an earlier page of this run, and where the run's saved
		// position is held while any waits (see below).
		const waitingDrops = new Set<string>();
		let holdAt: { cursor: string | null } | null = null;
		// Plaid said the 90-day history is in: by the webhook, or by a page's transactions_update_status. Kept across a
		// restart, since Plaid's report doesn't change with the pass (#581).
		let historyReported = historyComplete;

		for (;;) {
			let page: SyncResponse;

			try {
				// Pinned: each page is one D1 batch, sized for 100 rows (issue #418).
				const request: SyncRequest = { access_token: accessToken, count: 100 };

				// Plaid's cursor is empty until an Item's data is ready, and its reference documents only an omitted cursor
				// (the entire history of updates), so an empty one is sent as none.
				if (cursor) request.cursor = cursor;

				page = await plaidPost<SyncResponse>(
					env,
					"/transactions/sync",
					request,
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
					cursor = firstCursor;
					firstPage = true;
					summary = { added: 0, modified: 0, removed: 0 };
					waitingDrops.clear();
					holdAt = null;
					continue;
				}

				if (!(error instanceof PlaidError)) throw error;

				return await handlePlaidError(
					env,
					itemRowId,
					lockId,
					item.access_token_encrypted,
					error,
					fetchImpl,
				);
			}

			if (page.transactions_update_status === HISTORICAL_UPDATE_COMPLETE)
				historyReported = true;
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
					`UPDATE plaid_items SET sync_locked_until = datetime('now', '+${SYNC_LEASE_MINUTES} minutes')
					 WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL`,
				).bind(itemRowId, lockId),
			];

			const existingTransactionIds = new Set<string>();

			if (added.length > 0) {
				// One JSON array, read by json_each: a bind per row would pass D1's 100 values past 100 rows.
				const existing = await env.DB.prepare(
					"SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id IN (SELECT value FROM json_each(?))",
				)
					.bind(
						JSON.stringify(
							added.map((transaction) => transaction.transaction_id),
						),
					)
					.all<{ plaid_transaction_id: string }>();

				for (const row of existing.results) {
					existingTransactionIds.add(row.plaid_transaction_id);
				}
			}

			if (firstPage) {
				for (const account of accounts) {
					statements.push(accountUpsert(env, itemRowId, lockId, account));
				}

				// After the upserts, so a newly seen account already has its row to snapshot.
				statements.push(
					...balanceSnapshots(
						env,
						itemRowId,
						lockId,
						await householdToday(env.DB),
						accounts,
					),
				);
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
									plaidCategory:
										transaction.personal_finance_category?.primary ?? null,
								},
							),
						);
					}
				}

				// A corrected amount invalidates a person's parts; a date-only correction follows them.
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET refund_of_id=NULL, refund_unlinked_purchase_date=(SELECT p.date FROM transactions part JOIN transactions p ON p.id = part.parent_id WHERE part.id = transactions.refund_of_id) WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=(SELECT id FROM transactions WHERE plaid_transaction_id=? AND is_split=1 AND amount_cents!=?)) AND ${OWNS_LOCK}`,
					).bind(transaction.transaction_id, cents, itemRowId, lockId),
				);
				statements.push(
					...splitBillStatements(
						env,
						itemRowId,
						lockId,
						transaction.transaction_id,
						cents,
					),
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
					forgetClearedJevLog(
						env,
						itemRowId,
						lockId,
						transaction.transaction_id,
						cents,
					),
				);
				statements.push(
					env.DB.prepare(
						`INSERT INTO transactions
							(plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name, plaid_category, plaid_detailed_category, credit_reviewed, flag_income, excluded, excluded_source, pending)
						 SELECT ?, id, ?, ?, ?, ?, ?, ?, CASE WHEN ? < 0 THEN 0 ELSE 1 END, CASE WHEN ? = '${PLAID_INCOME_CATEGORY}' AND ? < 0 THEN 1 ELSE 0 END,
							CASE WHEN ${isPlaidTransferSql("?")} THEN 1 ELSE 0 END,
							CASE WHEN ${isPlaidTransferSql("?")} THEN 'plaid' ELSE NULL END, ? FROM accounts
						 WHERE plaid_account_id = ? AND ${OWNS_LOCK}
						 ON CONFLICT(plaid_transaction_id) DO UPDATE SET
							date = excluded.date,
								flag_income = ${syncedIncomeFlagSql("transactions", "excluded.plaid_category", "excluded.amount_cents")},
								income_source = CASE WHEN transactions.income_source = 'jev' AND transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.income_source END,
								credit_reviewed = CASE WHEN transactions.credit_reviewed_by = 'user' THEN transactions.credit_reviewed WHEN transactions.amount_cents = excluded.amount_cents THEN transactions.credit_reviewed WHEN excluded.amount_cents < 0 THEN 0 ELSE 1 END,
								credit_reviewed_by = CASE WHEN transactions.credit_reviewed_by = 'jev' AND transactions.amount_cents != excluded.amount_cents THEN NULL ELSE transactions.credit_reviewed_by END,
							split_removed_from_cents = CASE WHEN transactions.is_split = 1 AND transactions.amount_cents != excluded.amount_cents THEN transactions.amount_cents ELSE transactions.split_removed_from_cents END,
							${setCategoryClearedByBankSql(columnOf("transactions"), {
								amount: "transactions.amount_cents != excluded.amount_cents",
								merchant: `${merchantKeySql("transactions")} != ${merchantKeySql("excluded")}`,
							})},
							${clearJevAnswersOnAmountChange("transactions.amount_cents != excluded.amount_cents")},
							is_split = CASE WHEN transactions.is_split = 1 AND transactions.amount_cents != excluded.amount_cents THEN 0 ELSE transactions.is_split END,
							amount_cents = excluded.amount_cents,
							raw_name = excluded.raw_name,
							merchant_name = excluded.merchant_name,
							plaid_category = excluded.plaid_category,
							plaid_detailed_category = excluded.plaid_detailed_category,
							${plaidTransferRuleSql("excluded.plaid_category", "excluded.amount_cents")},
							pending = excluded.pending,
							updated_at = datetime('now')`,
					).bind(
						transaction.transaction_id,
						transaction.date,
						cents,
						transaction.name,
						merchantNameOf(transaction),
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.detailed ?? null,
						plaidAmountToCents(transaction.amount),
						transaction.personal_finance_category?.primary ?? null,
						cents,
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.primary ?? null,
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
				// A purchase whose split this same bank change removes, or one a bank change already took out of its
				// split, keeps its category through a rename so it can be restored (decision 99). A split purchase
				// that is only renamed loses an old merchant rule's category like any purchase.
				const newKey = merchantNameOf(transaction) ?? transaction.name;
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET refund_of_id=NULL, refund_unlinked_purchase_date=(SELECT p.date FROM transactions part JOIN transactions p ON p.id = part.parent_id WHERE part.id = transactions.refund_of_id) WHERE refund_of_id IN (SELECT id FROM transactions WHERE parent_id=(SELECT id FROM transactions WHERE plaid_transaction_id=? AND is_split=1 AND amount_cents!=?)) AND ${OWNS_LOCK}`,
					).bind(transaction.transaction_id, cents, itemRowId, lockId),
				);
				statements.push(
					...splitBillStatements(
						env,
						itemRowId,
						lockId,
						transaction.transaction_id,
						cents,
					),
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
					forgetClearedJevLog(
						env,
						itemRowId,
						lockId,
						transaction.transaction_id,
						cents,
					),
				);
				statements.push(
					env.DB.prepare(
						`UPDATE transactions SET date = ?,
							split_removed_from_cents = CASE WHEN is_split = 1 AND amount_cents != ? THEN amount_cents ELSE split_removed_from_cents END,
							${setCategoryClearedByBankSql(bareColumn, {
								amount: "amount_cents != ?",
								merchant: `${merchantKeySql("transactions")} != ?`,
							})},
							${clearJevAnswersOnAmountChange("amount_cents != ?")},
							is_split = CASE WHEN is_split = 1 AND amount_cents != ? THEN 0 ELSE is_split END,
							amount_cents = ?, raw_name = ?, merchant_name = ?,
							plaid_category = ?, plaid_detailed_category = ?, pending = ?,
							${plaidTransferRuleSql("?", "?")},
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
						cents,
						newKey,
						cents,
						cents,
						newKey,
						cents,
						cents,
						cents,
						cents,
						cents,
						cents,
						cents,
						cents,
						cents,
						cents,
						transaction.name,
						merchantNameOf(transaction),
						transaction.personal_finance_category?.primary ?? null,
						transaction.personal_finance_category?.detailed ?? null,
						transaction.pending ? 1 : 0,
						transaction.personal_finance_category?.primary ?? null,
						cents,
						transaction.personal_finance_category?.primary ?? null,
						cents,
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
			for (const transaction of [...added, ...page.modified]) {
				statements.push(
					env.DB.prepare(unlinkOverRefundedSql(OWNS_LOCK)).bind(
						transaction.transaction_id,
						transaction.transaction_id,
						itemRowId,
						lockId,
					),
				);
			}

			// A payment the bank changed that no longer fits its plan's month unlinks the plan, which is set aside again
			// (decision 82). One statement for the page's charges, after their amounts and dates are written in this batch.
			const ids = [...added, ...page.modified].map(
				(transaction) => transaction.transaction_id,
			);

			if (ids.length > 0) {
				statements.push(
					env.DB.prepare(
						unlinkUnfitPlanPaymentsSql(SYNCED_PAYMENTS_SQL, OWNS_LOCK),
					).bind(JSON.stringify(ids), itemRowId, lockId),
				);
			}

			// When Plaid first names a merchant (the key differs from the bank text), the merchant's settings row
			// starts from the rows saved under the bank texts it came with, if there are any: its name, rule and Not
			// a bill come from the first text that has each, and its suggestion from one row (see copyMerchantRowSql).
			// The first sync's copy wins, and a later edit to the old row never reaches the new one. Within one sync, a later
			// page also fills in a choice the new row doesn't have yet (see COPY_WINNERS). A guess Workers AI made for
			// the bank text is cleared again below when Plaid's name is only that text (spec §7, decision 79).
			// One statement for the page's charges.
			const pairs = new Map<string, [string, string]>();

			for (const transaction of [...added, ...page.modified]) {
				const key = merchantNameOf(transaction);

				if (!key || key === transaction.name) continue;
				pairs.set(JSON.stringify([key, transaction.name]), [
					key,
					transaction.name,
				]);
			}

			if (pairs.size > 0) {
				// The names are copied first, from the state before this page (copyPlaidNamesSql); then the merchant rows, which
				// take the same winner's status; then the never-suggest lines.
				const [copyNames, dropOtherNames] = copyPlaidNamesSql(OWNS_LOCK);
				const pairJson = JSON.stringify([...pairs.values()]);
				statements.push(
					env.DB.prepare(copyNames).bind(pairJson, lockId, itemRowId, lockId),
					env.DB.prepare(dropOtherNames).bind(
						pairJson,
						lockId,
						itemRowId,
						lockId,
					),
					env.DB.prepare(copyMerchantRowSql(OWNS_LOCK)).bind(
						pairJson,
						lockId,
						lockId,
						itemRowId,
						lockId,
					),
					env.DB.prepare(copyNeverSuggestSql(OWNS_LOCK)).bind(
						JSON.stringify([...pairs.values()]),
						itemRowId,
						lockId,
					),
				);
			}

			// Plaid's cleaned name is the merchant's first suggested name, with no AI call (spec §8.6, decision 68). It
			// is a fact the bank sent, so it doesn't depend on the AI switches. Only a merchant nobody has named or
			// decided about takes it: a person's own name, and a suggestion they already accepted or turned down,
			// are never touched, and a guess still waiting (Workers AI's, copied from the bank text's row) gives way
			// to it. It is only a suggestion: nothing is renamed until a person chooses it.
			const suggested = new Set<string>();

			for (const transaction of [...added, ...page.modified]) {
				const name = plaidNameToSuggest(transaction);

				if (name) suggested.add(name);
			}

			if (suggested.size > 0) {
				statements.push(
					...suggestBankNames(
						env.DB,
						[...suggested],
						OWNS_LOCK,
						[itemRowId, lockId],
						lockId,
					),
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
					const pendingDrops = await env.DB.prepare(
						"SELECT plaid_transaction_id FROM transactions WHERE pending = 1 AND plaid_transaction_id IN (SELECT value FROM json_each(?))",
					)
						.bind(JSON.stringify(unsettled))
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

			// One bank text can come with different Plaid names, since Plaid's names change over time. Only the newest
			// charge's name is suggested for it (decision 79), and that is settled here, once the page's writes and
			// deletes are in, for every bank text the page touched: the texts of the charges it added or modified
			// with a Plaid name, and the texts the charges it changes or removes were saved under (a charge whose
			// text changes leaves its old text, and a removed one leaves its text, with their remaining charges).
			// A waiting name that is no charge's newest is withdrawn, so a person is never asked about both, and a
			// name that is the newest for another bank text stays. Then each text's newest remaining charge
			// suggests its name, which offers an older one again when the newer charge is gone, unless a person
			// named or decided it. A pending drop waiting for a later page isn't in `drops`: it isn't deleted yet.
			const textsOfCharges = new Set<string>();

			for (const transaction of [...added, ...page.modified]) {
				if (merchantNameOf(transaction)) textsOfCharges.add(transaction.name);
			}

			const changing = [
				...drops,
				...added.flatMap((transaction) =>
					transaction.pending_transaction_id
						? [transaction.transaction_id, transaction.pending_transaction_id]
						: [transaction.transaction_id],
				),
				...page.modified.map((transaction) => transaction.transaction_id),
			];

			if (changing.length > 0) {
				const { results } = await env.DB.prepare(
					`SELECT DISTINCT raw_name FROM transactions
					 WHERE parent_id IS NULL AND plaid_transaction_id IN (SELECT value FROM json_each(?))`,
				)
					.bind(JSON.stringify(changing))
					.all<{ raw_name: string }>();

				for (const row of results) textsOfCharges.add(row.raw_name);
			}

			if (textsOfCharges.size > 0) {
				const names = new Set<string>();

				const current = await env.DB.prepare(
					`SELECT DISTINCT merchant_name FROM transactions
					 WHERE parent_id IS NULL AND raw_name IN (SELECT value FROM json_each(?))
					   AND NULLIF(merchant_name, '') IS NOT NULL`,
				)
					.bind(JSON.stringify([...textsOfCharges]))
					.all<{ merchant_name: string }>();

				for (const row of current.results) names.add(row.merchant_name);

				for (const transaction of [...added, ...page.modified]) {
					const name = merchantNameOf(transaction);

					if (name) names.add(name);
				}

				if (names.size > 0) {
					const related = await env.DB.prepare(
						`SELECT DISTINCT raw_name FROM transactions
						 WHERE parent_id IS NULL AND merchant_name IN (SELECT value FROM json_each(?))`,
					)
						.bind(JSON.stringify([...names]))
						.all<{ raw_name: string }>();

					for (const row of related.results) textsOfCharges.add(row.raw_name);
				}
			}

			if (textsOfCharges.size > 0) {
				const texts = JSON.stringify(
					[...textsOfCharges].map((text) => [text, tidyName(text)]),
				);

				statements.push(
					env.DB.prepare(withdrawOlderPlaidNamesSql(OWNS_LOCK)).bind(
						texts,
						itemRowId,
						lockId,
					),
					...pendingNameStatements(
						env.DB,
						newestPlaidNameCandidatesSql,
						[texts],
						OWNS_LOCK,
						[itemRowId, lockId],
						lockId,
					),
				);
			}

			// A Plaid name that needs no suggestion (it is the bank's text, or that text tidied) leaves no guess
			// behind on its merchant (see `clearStaleGuessesSql`).
			const plain = new Set<string>();

			for (const transaction of [...added, ...page.modified]) {
				const name = merchantNameOf(transaction);

				if (name && !plaidNameToSuggest(transaction)) plain.add(name);
			}

			if (plain.size > 0) {
				statements.push(
					env.DB.prepare(clearStaleGuessesSql(OWNS_LOCK)).bind(
						JSON.stringify([...plain]),
						itemRowId,
						lockId,
					),
				);
			}

			// The withdrawals above left their rows behind; the last name statement of the page removes them (sweepStaleNamesSql).
			if (textsOfCharges.size > 0 || plain.size > 0)
				statements.push(
					env.DB.prepare(sweepStaleNamesSql(OWNS_LOCK)).bind(itemRowId, lockId),
				);

			// The last page's write also stamps the first sync that ran after Plaid said the history was in (#581): the same
			// batch, so the stamp means the history's pages are in. COALESCE keeps the first stamp of all.
			const lastPageStamp = historyReported
				? ", last_synced_at = datetime('now'), history_complete_at = COALESCE(history_complete_at, datetime('now'))"
				: ", last_synced_at = datetime('now')";

			statements.push(
				env.DB.prepare(
					`UPDATE plaid_items SET sync_cursor = ?, sync_update_cursor = ?${page.has_more ? "" : lastPageStamp}
					 WHERE id = ? AND sync_lock_id = ? AND disconnected_at IS NULL`,
				).bind(
					page.has_more && holdAt ? holdAt.cursor : page.next_cursor,
					// While more pages wait, where this update began ('' for no cursor); nothing once its last page is in.
					page.has_more ? (firstCursor ?? "") : null,
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

			await collectChangedIds(
				env.DB,
				[...added, ...page.modified].map(
					(transaction) => transaction.transaction_id,
				),
				changedIds,
			);

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
				// Every page is in and this run still holds the lease, so the login works: a bank that needed attention is
				// fine again (decision 173). The store retries a completion that loses only to a change of state, so a
				// lost-race here means the lease was taken, or the bank kept changing through every try. Either way the
				// sync does not report success: the bank's flags are left alone, and the next run tries again.
				const completed = await markSyncSucceeded(env.DB, itemRowId, lockId);

				if (completed === "lost-race") {
					console.error(
						`plaid sync could not record its completion for item ${itemRowId}`,
					);
					throw new Error("Plaid sync could not record its completion");
				}

				if (runAfterSync) await afterSync(env.DB);

				return { ...summary, changedIds: [...changedIds] };
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
