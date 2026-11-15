import * as Schema from "effect/Schema";
import type { Json } from "../json";

// The sync's two Plaid answers, read at the edge (decision 206, #1152): a bank's accounts (`/accounts/get`) and one page of
// its changes (`/transactions/sync`). The sync takes a great deal today that Plaid never sends: a charge for a charge never
// stored, an id of null, a number where a name goes. A page the sync takes is never refused here, or that bank's cursor
// would stall for good. So each Schema names only what makes the sync fail today, and a field it leaves unchecked passes on
// as sent, to be bound into SQL as it always was. test/sync-page-characterise.test.ts holds 380 odd answers and what the
// sync did with each before this.

export type PlaidAccount = {
	account_id: string;
	name: string;
	mask?: string | null;
	type: string;
	subtype?: string | null;
	balances: { current?: number | null };
};

export type PlaidTransaction = {
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

export type SyncResponse = {
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

/** A field that must be sent. Whatever it holds is passed on as sent. */
const Sent = Schema.Unknown.check(
	Schema.makeFilter((value) => value !== undefined),
);

/** A field that must be sent and must not be null. Whatever else it holds is passed on as sent. */
const Given = Schema.Unknown.check(
	Schema.makeFilter((value) => value !== undefined && value !== null),
);

const Charge = Schema.Struct({
	transaction_id: Sent,
	date: Sent,
	amount: Schema.Number,
	// Only that it is sent: a name of another type fails the sync only beside a merchant that is not blank, so it is not refused here.
	name: Sent,
	merchant_name: Schema.optional(Schema.NullOr(Schema.String)),
});

const SyncPage = Schema.Struct({
	added: Schema.Array(Charge),
	modified: Schema.Array(Charge),
	removed: Schema.Array(Schema.Struct({ transaction_id: Sent })),
	// next_cursor is not checked: the sync reads it only when it saves the page's position, and a page that says more is
	// coming while it drops a waiting pending charge saves the held position instead, so a missing one is taken there.
});

const Account = Schema.Struct({
	account_id: Sent,
	name: Given,
	type: Given,
	balances: Given,
});

const AccountsAnswer = Schema.Struct({ accounts: Schema.Array(Account) });

/** One page of changes as the sync takes it, or a plain Error naming what is missing, before any statement is built. */
export function readSyncPage(answer: Json): SyncResponse {
	if (!Schema.is(SyncPage)(answer))
		throw new Error("Plaid sync page is missing a field the sync needs");

	// SAFETY: the check above establishes the fields whose absence or wrong type fails the sync; the rest are bound into SQL as sent, as before.
	return answer as SyncResponse;
}

/** A bank's accounts as the sync takes them, or a plain Error naming what is missing, before any statement is built. */
export function readAccountsAnswer(answer: Json): PlaidAccount[] {
	if (!Schema.is(AccountsAnswer)(answer))
		throw new Error("Plaid accounts answer is missing a field the sync needs");

	// SAFETY: the check above establishes the fields whose absence fails the sync; the rest are bound into SQL as sent, as before.
	return answer.accounts as PlaidAccount[];
}
