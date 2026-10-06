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

/** All active rules and the matching subset, with indexed per-merchant all-time counts. */
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
					(SELECT COUNT(*) FROM transactions t
						WHERE t.parent_id IS NULL AND ${merchantKeySql("t")} = m.raw_name) AS transactions
				FROM merchants m JOIN categories c ON c.id = m.default_category_id
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
