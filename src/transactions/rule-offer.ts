import { INCLUDED_ROW, markedTransferSql } from "../db/counted-month";
import { merchantKeySql } from "../db/merchant-key";
import { jevSaysMixedSql } from "../db/mixed-trip";

export type RuleOffer = {
	merchantKey: string;
	categoryId: number;
	count: number;
};

/**
 * The picks that count toward an offer (decision 79): a person's own pick of the category, on a whole
 * unsplit purchase of money out, for a merchant without a rule. A pick on a transfer counts only once it
 * is back in the budget. Nothing counts a store's categories or months (decision 90), so a store that
 * also has other categories' picks is still offered. It names the table `transactions`, so the query it
 * is in reads that table without an alias. Binds the category id.
 */
const COUNTED_PICKS_SQL = `parent_id IS NULL AND amount_cents > 0
	AND category_source = 'user' AND category_id = ? AND flag_income = 0 AND is_split = 0
	AND NOT EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("transactions")} AND m.default_category_id IS NOT NULL)
	AND (${INCLUDED_ROW} OR NOT ${markedTransferSql("transactions")})`;

/**
 * Counts a person's picks of `categoryId` for the merchant, in its own transaction history, using its
 * history index.
 */
export async function categoryRuleOffer(
	db: D1Database,
	merchantKey: string,
	categoryId: number,
): Promise<RuleOffer | null> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			FROM transactions INDEXED BY transactions_merchant_history
			WHERE ${merchantKeySql("transactions")} = ? AND ${COUNTED_PICKS_SQL}`,
		)
		.bind(merchantKey, categoryId)
		.first<{ count: number }>();
	const count = row?.count ?? 0;
	if (count < 3) return null;
	return { merchantKey, categoryId, count };
}

/**
 * The offer for the first merchant in a selection to reach three picks of `categoryId`: the merchant whose
 * lowest counted selected row has the lowest id, with that row. Only counted picks in the selection start
 * a question (spec §7, decision 100), so a selection of income, money in or a transfer left out of the
 * budget asks nothing. Null when no selected merchant reaches three.
 * One statement, sharing `COUNTED_PICKS_SQL` with `categoryRuleOffer`, so the two can't drift apart.
 */
export async function firstRuleOfferAmong(
	db: D1Database,
	ids: number[],
	categoryId: number,
): Promise<(RuleOffer & { transactionId: number }) | null> {
	const row = await db
		.prepare(
			`WITH selected AS (
				SELECT ${merchantKeySql("transactions")} AS merchantKey, MIN(id) AS transactionId
				FROM transactions
				WHERE id IN (SELECT value FROM json_each(?)) AND ${COUNTED_PICKS_SQL}
				GROUP BY ${merchantKeySql("transactions")}
				-- A store with a selected trip that looks mixed is never asked (decision 113).
				HAVING SUM(CASE WHEN ${jevSaysMixedSql("transactions")} THEN 1 ELSE 0 END) = 0
			)
			SELECT s.merchantKey AS merchantKey, s.transactionId AS transactionId, COUNT(*) AS count
			FROM selected s
			JOIN transactions INDEXED BY transactions_merchant_history
				ON ${merchantKeySql("transactions")} = s.merchantKey
			WHERE ${COUNTED_PICKS_SQL}
			GROUP BY s.merchantKey, s.transactionId
			HAVING COUNT(*) >= 3
			ORDER BY s.transactionId
			LIMIT 1`,
		)
		.bind(JSON.stringify(ids), categoryId, categoryId)
		.first<{ merchantKey: string; transactionId: number; count: number }>();
	return row ? { ...row, categoryId } : null;
}

/**
 * The offer after a person saved `categoryId` on one transaction. The question is asked only when the
 * saved row is itself one of the counted picks (spec §7, decision 100): income, money in, a split parent
 * or part, or a transfer still left out of the budget asks nothing. The merchant comes from the stored
 * row, so the answer follows what was saved, whatever the form carried.
 */
export async function ruleOfferForTransaction(
	db: D1Database,
	transactionId: number,
	categoryId: number,
): Promise<RuleOffer | null> {
	const row = await db
		.prepare(
			`SELECT ${merchantKeySql("transactions")} AS merchantKey FROM transactions WHERE id = ? AND ${COUNTED_PICKS_SQL}
				AND NOT ${jevSaysMixedSql("transactions")}`,
		)
		.bind(transactionId, categoryId)
		.first<{ merchantKey: string }>();
	return row ? categoryRuleOffer(db, row.merchantKey, categoryId) : null;
}
