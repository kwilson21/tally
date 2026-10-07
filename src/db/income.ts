/**
 * Who set a transaction's income flag (spec §5, §8.5, decisions 67 and 70), read off the row, with no
 * column of its own: `income_source` only allows `user`, `jev` or null, so a flag Plaid set keeps it
 * null. Plaid set it when the flag is on, nobody has chosen, and Plaid's category still says INCOME.
 *
 * `alias` is the transactions table's name or alias in the query ("t" in most, "transactions" inside
 * an UPDATE of the table itself), as for `merchantKeySql`.
 */

/** Plaid's `personal_finance_category.primary` for pay, interest and the like. */
export const PLAID_INCOME_CATEGORY = "INCOME";

/** A person has chosen: they set the income flag, or reviewed the credit as something other than income. */
export function personChoseIncomeSql(alias: string): string {
	return `(${alias}.income_source = 'user' OR ${alias}.credit_reviewed_by = 'user')`;
}

/** Plaid's own INCOME category set the flag, and nobody has taken it over since. */
export function plaidSetIncomeSql(alias: string): string {
	return `(${alias}.flag_income = 1 AND ${alias}.income_source IS NULL AND ${alias}.plaid_category = '${PLAID_INCOME_CATEGORY}')`;
}

/** A settled income answer from a person, Jev, or Plaid. */
export function hasIncomeAnswerSql(alias: string): string {
	return `COALESCE((${personChoseIncomeSql(alias)} OR ${alias}.income_source = 'jev' OR ${plaidSetIncomeSql(alias)}), 0)`;
}

/**
 * The new `flag_income` when sync updates a transaction, given SQL for the category and amount Plaid
 * just sent. A person's choice always wins. Otherwise money coming in (a negative amount, Plaid's sign
 * convention) labeled INCOME sets the flag, and a flag Plaid set is cleared when Plaid stops saying
 * INCOME or the amount turns into money out, which is never income. Jev's flag is only reset when the
 * amount changes (a corrected sign or size voids its answer), and `income_source` is never changed
 * here, so a flag Plaid sets stays null. This is a sync fact, not AI: the AI switches (spec §8.6)
 * don't apply to it.
 */
export function syncedIncomeFlagSql(
	alias: string,
	newCategory: string,
	newAmount: string,
): string {
	return `CASE
		WHEN ${personChoseIncomeSql(alias)} THEN ${alias}.flag_income
		WHEN ${newCategory} = '${PLAID_INCOME_CATEGORY}' AND ${newAmount} < 0 THEN 1
		WHEN ${alias}.income_source = 'jev' AND ${alias}.amount_cents != ${newAmount} THEN 0
		WHEN ${plaidSetIncomeSql(alias)} THEN 0
		ELSE ${alias}.flag_income END`;
}
