/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * Rows saved before Plaid's merchant name was stored are keyed by the bank's raw text. They keep working:
 * a transaction is the same merchant as a row saved under its key OR, failing that, under its own raw
 * name (the helpers below). New rows are always saved under the key.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}

/**
 * A `merchants` column for a merchant, given SQL for its key and for its raw name: the value on the
 * row saved under the key, otherwise on the row saved under the raw name. Per column, so a row
 * under the key that holds only a rule still shows the name saved under the raw text.
 */
export function merchantColumnOfSql(
	keySql: string,
	rawNameSql: string,
	column: "display_name" | "suggested_name" | "default_category_id",
): string {
	return `COALESCE((SELECT m.${column} FROM merchants m WHERE m.raw_name = ${keySql}), (SELECT m.${column} FROM merchants m WHERE m.raw_name = ${rawNameSql}))`;
}

/** `merchantColumnOfSql` for a transaction (see `merchantKeySql` for `alias`). */
export function merchantColumnSql(
	alias: string,
	column: "display_name" | "suggested_name" | "default_category_id",
): string {
	return merchantColumnOfSql(
		merchantKeySql(alias),
		`${alias}.raw_name`,
		column,
	);
}

/** True when a `merchants` row under the key or under the raw name is marked "not a bill". */
export function merchantNotABillSql(
	keySql: string,
	rawNameSql: string,
): string {
	return `EXISTS (SELECT 1 FROM merchants m WHERE m.not_a_bill = 1 AND m.raw_name IN (${keySql}, ${rawNameSql}))`;
}

/**
 * True when a stored merchant text (a bill's `merchant_raw_name`) is this transaction's merchant: its
 * key, or its raw name for a bill saved before Plaid's merchant name was stored. `textSql` is the SQL
 * for the stored text (a `?` is fine: it appears once), `alias` as for `merchantKeySql`.
 */
export function isMerchantTextSql(alias: string, textSql: string): string {
	return `${textSql} IN (${merchantKeySql(alias)}, ${alias}.raw_name)`;
}
