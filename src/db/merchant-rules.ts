import { shownName } from "../transactions/name-suggestions";
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
	namesOn = false,
): Promise<{ rules: MerchantRuleRow[]; total: number }> {
	const [count, rows] = await Promise.all([
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE default_category_id IS NOT NULL",
			)
			.first<{ n: number }>(),
		db
			.prepare(
				`SELECT m.raw_name AS merchantKey, m.display_name, m.suggested_name, m.suggestion_status,
					c.id AS categoryId, c.name AS category, c.icon, c.color, c.archived,
					COUNT(t.id) AS transactions
				FROM merchants m JOIN categories c ON c.id = m.default_category_id
				LEFT JOIN transactions t INDEXED BY transactions_merchant_history
					ON ${merchantKeySql("t")} = m.raw_name AND t.parent_id IS NULL
				WHERE m.default_category_id IS NOT NULL
				GROUP BY m.raw_name, m.display_name, m.suggested_name, m.suggestion_status, c.id, c.name, c.icon, c.color, c.archived`,
			)
			.all<
				Omit<MerchantRuleRow, "merchant"> & {
					display_name: string | null;
					suggested_name: string | null;
					suggestion_status: string | null;
				}
			>(),
	]);
	const rules = rows.results.map(
		({ display_name, suggested_name, suggestion_status, ...rule }) => ({
			...rule,
			merchant: shownName({
				chosen: display_name,
				stored: suggested_name,
				status: suggestion_status,
				key: rule.merchantKey,
				rawName: rule.merchantKey,
				namesOn,
			}).name,
		}),
	);
	rules.sort(
		(a, b) =>
			a.merchant.localeCompare(b.merchant) ||
			a.merchantKey.localeCompare(b.merchantKey),
	);
	return { rules, total: count?.n ?? 0 };
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
