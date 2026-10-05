/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}
