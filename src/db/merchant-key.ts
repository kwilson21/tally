/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * Each merchant has one settings row in `merchants`, found by its key, and a charge reads only that row,
 * so every bank text that shares a key shares one rule, name and Not a bill. A row saved before Plaid
 * named a merchant is under its bank text, which is the key of the charges that have no merchant name,
 * and sync copies it to the merchant's key when Plaid first names the merchant (src/plaid/sync.ts).
 *
 * Bills keep a flag instead (`bills.merchant_raw_text`): a bill saved before the key existed (1) holds
 * the bank's raw text and matches by raw name, and a bill saved since (0) holds a key and matches by key.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}

type MerchantColumn =
	| "display_name"
	| "suggested_name"
	| "suggestion_status"
	| "default_category_id"
	| "not_a_bill";

/** A `merchants` column on the row saved under a merchant key, given SQL for the key. */
export function merchantColumnOfSql(
	keySql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_name = ${keySql})`;
}

/** `merchantColumnOfSql` for a transaction (see `merchantKeySql` for `alias`). */
export function merchantColumnSql(
	alias: string,
	column: MerchantColumn,
): string {
	return merchantColumnOfSql(merchantKeySql(alias), column);
}

/** True when the row under a merchant key is marked "not a bill", given SQL for the key. */
export function merchantNotABillSql(keySql: string): string {
	return `EXISTS (SELECT 1 FROM merchants m WHERE m.not_a_bill = 1 AND m.raw_name = ${keySql})`;
}

/**
 * True when a bill's stored merchant text is this merchant: a key bill (flag 0) equals the key, or a bill
 * flagged as saved under the bank's raw text equals the raw name. `textSql` and `flagSql` are SQL for the
 * bill's `merchant_raw_name` and `merchant_raw_text` (a `?` is fine, bound as `merchantTextArgs`).
 */
export function isMerchantTextOfSql(
	keySql: string,
	rawNameSql: string,
	textSql: string,
	flagSql: string,
): string {
	return `((${flagSql} = 0 AND ${textSql} = ${keySql}) OR (${flagSql} = 1 AND ${textSql} = ${rawNameSql}))`;
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

/** The values to bind, in order, for the `?`s of `isMerchantTextSql`: the flag, the text, the flag, the text. */
export const merchantTextArgs = (bill: {
	merchant_raw_name: string;
	merchant_raw_text: number;
}): [number, string, number, string] => [
	bill.merchant_raw_text,
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
