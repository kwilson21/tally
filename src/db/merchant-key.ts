/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * Rows saved before a merchant key existed hold the bank's raw text, and migration 0017 flagged them
 * (`merchants.raw_text`, `bills.merchant_raw_text` = 1); a row saved since holds a key (flag 0). A stored
 * text matches a transaction when it equals the transaction's key, or when its row is flagged and it
 * equals the transaction's raw name, so old rows keep doing what they did before the key. A row saved
 * under the key wins over a flagged row for the same transaction.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}

type MerchantColumn = "display_name" | "suggested_name" | "default_category_id";

/** A `merchants` column on the row saved under the merchant key. */
export function keyRowColumnSql(
	keySql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_name = ${keySql})`;
}

/** A `merchants` column on the flagged row saved under the bank's raw text, if any. */
export function rawTextRowColumnSql(
	rawNameSql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_name = ${rawNameSql} AND m.raw_text = 1)`;
}

/**
 * A `merchants` column for a merchant, given SQL for its key and for its raw name: the value on the
 * row saved under the key, otherwise on the flagged row saved under the raw text. Per column, so a row
 * under the key that holds only a rule still shows the name saved under the raw text.
 */
export function merchantColumnOfSql(
	keySql: string,
	rawNameSql: string,
	column: MerchantColumn,
): string {
	return `COALESCE(${keyRowColumnSql(keySql, column)}, ${rawTextRowColumnSql(rawNameSql, column)})`;
}

/** `merchantColumnOfSql` for a transaction (see `merchantKeySql` for `alias`). */
export function merchantColumnSql(
	alias: string,
	column: MerchantColumn,
): string {
	return merchantColumnOfSql(
		merchantKeySql(alias),
		`${alias}.raw_name`,
		column,
	);
}

/** True when the row under the merchant's key, or its flagged row under the raw text, is marked "not a bill". */
export function merchantNotABillSql(
	keySql: string,
	rawNameSql: string,
): string {
	return `EXISTS (SELECT 1 FROM merchants m WHERE m.not_a_bill = 1 AND (m.raw_name = ${keySql} OR (m.raw_text = 1 AND m.raw_name = ${rawNameSql})))`;
}

/**
 * True when a bill's stored merchant text is this merchant: it equals the key, or the bill is flagged as
 * saved under the bank's raw text and it equals the raw name. `textSql` and `flagSql` are SQL for the
 * bill's `merchant_raw_name` and `merchant_raw_text` (a `?` is fine, bound as `merchantTextArgs`).
 */
export function isMerchantTextOfSql(
	keySql: string,
	rawNameSql: string,
	textSql: string,
	flagSql: string,
): string {
	return `(${textSql} = ${keySql} OR (${flagSql} = 1 AND ${textSql} = ${rawNameSql}))`;
}

/** `isMerchantTextOfSql` for a transaction (see `merchantKeySql` for `alias`), with `?` for the bill's text and flag. */
export function isMerchantTextSql(alias: string): string {
	return isMerchantTextOfSql(
		merchantKeySql(alias),
		`${alias}.raw_name`,
		"?",
		"?",
	);
}

/** The values to bind, in order, for the `?`s of `isMerchantTextSql`: the text, the flag, the text. */
export const merchantTextArgs = (bill: {
	merchant_raw_name: string;
	merchant_raw_text: number;
}): [string, number, string] => [
	bill.merchant_raw_name,
	bill.merchant_raw_text,
	bill.merchant_raw_name,
];

/**
 * True when transactions `a` and `b` are the same merchant: the same key, or the same raw name when
 * either has no merchant name (an older one). Two different merchant names are two merchants, whatever
 * their bank text.
 */
export function sameMerchantSql(a: string, b: string): string {
	return `(${merchantKeySql(a)} = ${merchantKeySql(b)} OR (${a}.raw_name = ${b}.raw_name AND (NULLIF(${a}.merchant_name, '') IS NULL OR NULLIF(${b}.merchant_name, '') IS NULL)))`;
}
