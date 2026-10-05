/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * Rows saved before Plaid's merchant name was stored are keyed by the bank's raw text. They keep working
 * through a raw-name fallback, and only for them: a stored text matches a transaction by its key, or by
 * its raw name when that text is "legacy", meaning it is not any transaction's merchant name. A raw text
 * that is some merchant's name is that merchant's key, so it never reaches a different merchant that
 * merely has the same bank text. New rows are always saved under the key.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}

/** True when the text is bank text saved before Plaid's merchant name was stored: no transaction has it as its merchant name. */
function isLegacyTextSql(textSql: string): string {
	return `${textSql} NOT IN (SELECT merchant_name FROM transactions WHERE merchant_name IS NOT NULL)`;
}

type MerchantColumn = "display_name" | "suggested_name" | "default_category_id";

/** A `merchants` column on the row saved under the merchant key. */
export function keyRowColumnSql(
	keySql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_name = ${keySql})`;
}

/** A `merchants` column on the legacy row saved under the bank's raw text (see above), if any. */
export function legacyRowColumnSql(
	rawNameSql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_name = ${rawNameSql} AND ${isLegacyTextSql("m.raw_name")})`;
}

/**
 * A `merchants` column for a merchant, given SQL for its key and for its raw name: the value on the
 * row saved under the key, otherwise on the legacy row saved under the raw name. Per column, so a row
 * under the key that holds only a rule still shows the name saved under the raw text.
 */
export function merchantColumnOfSql(
	keySql: string,
	rawNameSql: string,
	column: MerchantColumn,
): string {
	return `COALESCE(${keyRowColumnSql(keySql, column)}, ${legacyRowColumnSql(rawNameSql, column)})`;
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

/** True when the row under the merchant's key, or its legacy row under the raw name, is marked "not a bill". */
export function merchantNotABillSql(
	keySql: string,
	rawNameSql: string,
): string {
	return `EXISTS (SELECT 1 FROM merchants m WHERE m.not_a_bill = 1 AND (m.raw_name = ${keySql} OR (m.raw_name = ${rawNameSql} AND ${isLegacyTextSql("m.raw_name")})))`;
}

/**
 * True when a stored merchant text (a bill's `merchant_raw_name`) is this merchant: it equals the key,
 * or it equals the raw name and is legacy text. `textSql` appears three times: pass a column, or `?`
 * and bind the value with `merchantTextArgs`.
 */
export function isMerchantTextOfSql(
	keySql: string,
	rawNameSql: string,
	textSql: string,
): string {
	return `(${textSql} = ${keySql} OR (${textSql} = ${rawNameSql} AND ${isLegacyTextSql(textSql)}))`;
}

/** `isMerchantTextOfSql` for a transaction (see `merchantKeySql` for `alias`). */
export function isMerchantTextSql(alias: string, textSql: string): string {
	return isMerchantTextOfSql(
		merchantKeySql(alias),
		`${alias}.raw_name`,
		textSql,
	);
}

/** The values to bind for the three `?` of `isMerchantTextSql(alias, "?")`. */
export const merchantTextArgs = (text: string): [string, string, string] => [
	text,
	text,
	text,
];

/**
 * True when transactions `a` and `b` are the same merchant: the same key, or the same raw name when
 * either has no merchant name (an older one). Two different merchant names are two merchants, whatever
 * their bank text.
 */
export function sameMerchantSql(a: string, b: string): string {
	return `(${merchantKeySql(a)} = ${merchantKeySql(b)} OR (${a}.raw_name = ${b}.raw_name AND (NULLIF(${a}.merchant_name, '') IS NULL OR NULLIF(${b}.merchant_name, '') IS NULL)))`;
}
