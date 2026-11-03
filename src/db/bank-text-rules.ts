// Change on a learned line (decision 163): a rule on the cleaned bank text files a matching transaction in the chosen
// category before Jev is asked. It is made only from the learned page's Change, and it never changes a merchant rule.
// It fills what nothing has filled, or a bill's category, exactly as a merchant rule does (applyMerchantRules): a
// person's choice, a Jev guess and a split are never touched.

import { cleanBankText } from "../clean-bank-text";

/** The raw names one UPDATE takes at most: a few hundred ids in all, per the bounded-work rule (decision 163). */
const RAW_NAMES_PER_UPDATE = 100;

/** A rule with its category, joined to the categories that are active (an archived category's rule does nothing). */
export type BankTextRule = {
	cleanedText: string;
	categoryId: number;
	categoryName: string;
	icon: string;
	color: string;
};

/** The rules whose category is active, for the learned lines and for applying them. */
export async function activeBankTextRules(
	db: D1Database,
): Promise<BankTextRule[]> {
	const { results } = await db
		.prepare(
			`SELECT b.cleaned_text AS cleanedText, b.category_id AS categoryId,
				c.name AS categoryName, c.icon, c.color
			FROM bank_text_rules b JOIN categories c ON c.id = b.category_id
			WHERE c.archived = 0
			ORDER BY b.cleaned_text`,
		)
		.all<BankTextRule>();
	return results;
}

/** Makes the rule for a cleaned text, or moves it to another category: one row per text (decision 163). */
export async function saveBankTextRule(
	db: D1Database,
	cleanedText: string,
	categoryId: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES (?, ?)
			ON CONFLICT(cleaned_text) DO UPDATE SET
				category_id = excluded.category_id, updated_at = datetime('now')`,
		)
		.bind(cleanedText, categoryId)
		.run();
}

/**
 * Applies the bank-text rules to the rows nothing has filled yet, and to a bill's category, after the merchant rules
 * have run (so a merchant rule wins). A row is matched by cleanBankText of its raw name, which SQL cannot compute, so the
 * raw names still open are read once, grouped in code, and each rule's names are updated in chunks, in one batch. A
 * person's choice, a Jev guess, a split parent and a split's removed part are never a target, and nothing about bank
 * text is logged.
 */
export async function applyBankTextRules(db: D1Database): Promise<void> {
	const any = await db
		.prepare("SELECT 1 AS one FROM bank_text_rules LIMIT 1")
		.first<{ one: number }>();
	if (!any) return;
	const rules = await activeBankTextRules(db);
	if (rules.length === 0) return;
	const categoryFor = new Map(rules.map((rule) => [rule.cleanedText, rule]));

	const { results: open } = await db
		.prepare(
			`SELECT DISTINCT raw_name AS rawName FROM transactions
			WHERE is_split = 0 AND ((category_id IS NULL AND category_source IS NULL) OR category_source = 'bill')
				AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL)`,
		)
		.all<{ rawName: string }>();

	const namesByRule = new Map<BankTextRule, string[]>();
	for (const { rawName } of open) {
		const rule = categoryFor.get(cleanBankText(rawName));
		if (!rule) continue;
		const names = namesByRule.get(rule);
		if (names) names.push(rawName);
		else namesByRule.set(rule, [rawName]);
	}
	if (namesByRule.size === 0) return;

	const statements = [];
	for (const [rule, names] of namesByRule) {
		for (let i = 0; i < names.length; i += RAW_NAMES_PER_UPDATE) {
			const chunk = names.slice(i, i + RAW_NAMES_PER_UPDATE);
			statements.push(
				db
					.prepare(
						`UPDATE transactions SET
							category_id = ?, category_source = 'merchant_rule', category_confidence = NULL,
							updated_at = datetime('now')
						WHERE raw_name IN (SELECT value FROM json_each(?))
							AND is_split = 0 AND ((category_id IS NULL AND category_source IS NULL) OR category_source = 'bill')
							AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL)
							AND EXISTS (SELECT 1 FROM categories c WHERE c.id = ? AND c.archived = 0)`,
					)
					.bind(rule.categoryId, JSON.stringify(chunk), rule.categoryId),
			);
		}
	}
	await db.batch(statements);
}
