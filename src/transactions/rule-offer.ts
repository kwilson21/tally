import { merchantKeySql } from "../db/merchant-key";
import { setMerchantRule } from "../db/transactions";

export type RuleOffer = {
	merchantKey: string;
	categoryId: number;
	count: number;
};

export { setMerchantRule };

/** Counts a person's picks in the merchant's own transaction history, using its history index. */
export async function categoryRuleOffer(
	db: D1Database,
	merchantKey: string,
	categoryId: number,
): Promise<RuleOffer | null> {
	const rows = await db
		.prepare(
			`SELECT SUM(CASE WHEN category_id = ? THEN 1 ELSE 0 END) AS count,
				COUNT(DISTINCT category_id) AS categories
			FROM transactions INDEXED BY transactions_merchant_history
			WHERE ${merchantKeySql("transactions")} = ? AND parent_id IS NULL
				AND amount_cents > 0
				AND category_source = 'user' AND category_id IS NOT NULL AND flag_transfer = 0 AND flag_income = 0
				AND is_split = 0
				AND NOT EXISTS (SELECT 1 FROM merchants m WHERE m.raw_name = ${merchantKeySql("transactions")} AND m.default_category_id IS NOT NULL)`,
		)
		.bind(categoryId, merchantKey)
		.first<{ count: number; categories: number }>();
	if ((rows?.categories ?? 0) > 1) return null;
	const count = rows?.count ?? 0;
	if (count < 3) return null;
	return { merchantKey, categoryId, count };
}
