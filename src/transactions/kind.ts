/**
 * What kind of spending a transaction is, as a person (or Jev) can label it. This list is the one place the kinds are
 * written down: the edit form, the edit panel's chips and Jev's question all read it, and test/transaction-kind.test.ts
 * fails if the database's CHECK on `transactions.kind` (migration 0030) stops matching it.
 */
export const TRANSACTION_KINDS = [
	"subscription",
	"one_off",
	"bill",
	"transfer",
] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** True when `value` is one of the kinds, so a form field can be narrowed without a cast. */
export function isTransactionKind(value: unknown): value is TransactionKind {
	return TRANSACTION_KINDS.some((kind) => kind === value);
}
