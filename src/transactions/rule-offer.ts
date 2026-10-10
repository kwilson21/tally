import { merchantKeySql } from "../db/merchant-key";

export type RuleOffer = {
	merchantKey: string;
	categoryId: number;
	count: number;
};

/**
 * Counts a person's picks of `categoryId` for the merchant, in its own transaction history, using its
 * history index. Nothing counts a store's categories or months (decision 90), so a store that also has
 * other categories' picks is still offered.
 */
export async function categoryRuleOffer(
	db: D1Database,
	merchantKey: string,
	categoryId: number,
): Promise<RuleOffer | null> {
	const rows = await db
		.prepare(
			`SELECT SUM(CASE WHEN category_id = ? THEN 1 ELSE 0 END) AS count
			FROM transactions INDEXED BY transactions_merchant_history
			WHERE ${merchantKeySql("transactions")} = ? AND parent_id IS NULL
				AND amount_cents > 0
				AND category_source = 'user' AND category_id IS NOT NULL AND flag_transfer = 0 AND flag_income = 0
				AND is_split = 0
				AND NOT EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("transactions")} AND m.default_category_id IS NOT NULL)`,
		)
		.bind(categoryId, merchantKey)
		.first<{ count: number }>();
	const count = rows?.count ?? 0;
	if (count < 3) return null;
	return { merchantKey, categoryId, count };
}

/**
 * The offer after a person saved `categoryId` on one transaction. The merchant comes from the stored
 * row, so the answer follows what was saved, whatever the form carried.
 */
export async function ruleOfferForTransaction(
	db: D1Database,
	transactionId: number,
	categoryId: number,
): Promise<RuleOffer | null> {
	const row = await db
		.prepare(
			`SELECT ${merchantKeySql("transactions")} AS merchantKey FROM transactions WHERE id = ?`,
		)
		.bind(transactionId)
		.first<{ merchantKey: string }>();
	return row ? categoryRuleOffer(db, row.merchantKey, categoryId) : null;
}
