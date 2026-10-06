import { merchantKeySql } from "./merchant-key";

export const CLEAR_MERCHANT_RULE_SQL =
	"UPDATE merchants SET default_category_id = NULL WHERE raw_name = ?";

export type MerchantRuleRow = {
	merchantKey: string;
	merchant: string;
	categoryId: number;
	category: string;
	icon: string;
	color: string;
	archived: number;
	transactions: number;
};

/** All active rules and the matching subset, with one grouped all-time transaction count. */
export async function merchantRules(
	db: D1Database,
	search = "",
): Promise<{ rules: MerchantRuleRow[]; total: number }> {
	const [count, rows] = await Promise.all([
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE default_category_id IS NOT NULL",
			)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT m.raw_name AS merchantKey, COALESCE(NULLIF(m.display_name, ''), m.raw_name) AS merchant,
					c.id AS categoryId, c.name AS category, c.icon, c.color, c.archived,
					COALESCE(transaction_counts.transactions, 0) AS transactions
				FROM merchants m JOIN categories c ON c.id = m.default_category_id
				LEFT JOIN (
					SELECT ${merchantKeySql("t")} AS merchantKey, COUNT(*) AS transactions
					FROM transactions t WHERE t.parent_id IS NULL
					GROUP BY ${merchantKeySql("t")}
				) transaction_counts ON transaction_counts.merchantKey = m.raw_name
				WHERE m.default_category_id IS NOT NULL
					AND (? = '' OR instr(lower(COALESCE(NULLIF(m.display_name, ''), m.raw_name)), lower(?)) > 0)
				ORDER BY merchant COLLATE NOCASE, merchantKey`,
			)
			.bind(search, search)
			.all<MerchantRuleRow>(),
	]);
	return { rules: rows.results, total: count?.n ?? 0 };
}

/** Clears only the rule; transactions already sorted under it remain as they are. */
export async function removeMerchantRule(
	db: D1Database,
	merchantKey: string,
): Promise<string | null> {
	const result = await db
		.prepare(
			`${CLEAR_MERCHANT_RULE_SQL} AND default_category_id IS NOT NULL
			RETURNING COALESCE(NULLIF(display_name, ''), raw_name) AS merchant`,
		)
		.bind(merchantKey)
		.first<{ merchant: string }>();
	return result?.merchant ?? null;
}
