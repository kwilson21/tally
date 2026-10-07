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
	search = "",
	removing = false,
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
					c.id AS categoryId, c.name AS category, c.icon, c.color, c.archived
				FROM merchants m JOIN categories c ON c.id = m.default_category_id
				WHERE m.default_category_id IS NOT NULL
				ORDER BY m.raw_name`,
			)
			.all<
				Omit<MerchantRuleRow, "merchant" | "transactions"> & {
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
	const query =
		(count?.n ?? 0) - Number(removing) > 20
			? search
					.normalize("NFC")
					.trim()
					.toLocaleLowerCase()
					.normalize("NFD")
					.replace(/\p{M}/gu, "")
			: "";
	const visible = rules.filter((rule) => {
		const merchant = rule.merchant
			.normalize("NFC")
			.toLocaleLowerCase()
			.normalize("NFD")
			.replace(/\p{M}/gu, "");
		const key = rule.merchantKey
			.normalize("NFC")
			.toLocaleLowerCase()
			.normalize("NFD")
			.replace(/\p{M}/gu, "");
		return !query || merchant.includes(query) || key.includes(query);
	});
	visible.sort(
		(a, b) =>
			a.merchant.localeCompare(b.merchant) ||
			a.merchantKey.localeCompare(b.merchantKey),
	);
	const keys = visible.map(({ merchantKey }) => merchantKey);
	const counts = keys.length
		? await db
				.prepare(
					`SELECT m.raw_name AS merchantKey, COUNT(t.id) AS transactions
					FROM json_each(?) AS visible
					JOIN merchants m ON m.raw_name = visible.value
				LEFT JOIN transactions t INDEXED BY transactions_merchant_history
						ON ${merchantKeySql("t")} = m.raw_name AND t.parent_id IS NULL
				GROUP BY m.raw_name`,
				)
				.bind(JSON.stringify(keys))
				.all<{ merchantKey: string; transactions: number }>()
		: { results: [] };
	const transactionCounts = new Map(
		counts.results.map((row) => [row.merchantKey, row.transactions]),
	);
	return {
		rules: visible.map((rule) => ({
			...rule,
			transactions: transactionCounts.get(rule.merchantKey) ?? 0,
		})),
		total: count?.n ?? 0,
	};
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
