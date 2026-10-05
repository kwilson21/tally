/**
 * A transaction's merchant key (spec §6.1 rule 1, decision 67): Plaid's cleaned `merchant_name` when it
 * sent one, otherwise the bank's `raw_name`. Merchant rules and names (the `merchants` table), bill
 * matching, the refund purchase list and finding bills all match on it, so "TARGET 1234" and
 * "TARGET 5678" are one merchant, while a hand-entered cash transaction, which has no merchant name,
 * is its raw name as before. A bill's key is the key of the payment it was made from or linked to.
 * It is stored in `merchants.raw_name` and `bills.merchant_raw_name`, whose names are kept.
 *
 * Rows saved before a merchant key existed hold the bank's raw text, and migration 0017 flagged them
 * (`merchants.raw_text`, `bills.merchant_raw_text` = 1); a row saved since holds a key (flag 0). The two
 * kinds never mix: a key row (flag 0) matches a transaction whose key equals its text, and a flagged row
 * matches one whose raw name equals its text, so old rows keep doing what they did before the key, and an
 * unrelated charge whose Plaid merchant name happens to equal an old bank text never reaches that row.
 * A transaction with no merchant name has its raw name as its key, so both kinds can match it. A key row
 * wins over a flagged row for the same transaction.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself).
 */
export function merchantKeySql(alias: string): string {
	return `COALESCE(NULLIF(${alias}.merchant_name, ''), ${alias}.raw_name)`;
}

type MerchantColumn = "display_name" | "suggested_name" | "default_category_id";

/** A `merchants` column on the key row (flag 0) saved under the merchant key. */
export function keyRowColumnSql(
	keySql: string,
	column: MerchantColumn,
): string {
	return `(SELECT m.${column} FROM merchants m WHERE m.raw_text = 0 AND m.raw_name = ${keySql})`;
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

/**
 * Which of these keys a person's write goes to the flagged bank-text row for: those with a flagged row
 * that no transaction has as its Plaid merchant name, so the text is only ever bank text, and the row is
 * the one that already governs those charges. Every other key's write goes to its key row (flag 0), which
 * shares the text with a flagged row when an unrelated merchant name equals an old bank text, and a key
 * row's write never touches a flagged row. Merchant rows are written only through this choice.
 */
export async function bankTextRowKeys(
	db: D1Database,
	keys: string[],
): Promise<Set<string>> {
	const found = new Set<string>();
	const unique = [...new Set(keys)];
	for (let i = 0; i < unique.length; i += 90) {
		const chunk = unique.slice(i, i + 90);
		const { results } = await db
			.prepare(
				`SELECT m.raw_name AS key FROM merchants m
				 WHERE m.raw_text = 1 AND m.raw_name IN (${chunk.map(() => "?").join(", ")})
				   AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_name = m.raw_name)`,
			)
			.bind(...chunk)
			.all<{ key: string }>();
		for (const row of results) found.add(row.key);
	}
	return found;
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
	return `EXISTS (SELECT 1 FROM merchants m WHERE m.not_a_bill = 1 AND ((m.raw_text = 0 AND m.raw_name = ${keySql}) OR (m.raw_text = 1 AND m.raw_name = ${rawNameSql})))`;
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
