// Change on a learned line (decision 163): a rule on the cleaned bank text files a matching transaction in the chosen
// category before Jev is asked. It is made only from the learned page's Change, and it never changes a merchant rule.
// It fills what nothing has filled, or a bill's category, exactly as a merchant rule does (applyMerchantRules): a
// person's choice, a Jev guess and a split are never touched.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { cleanBankText } from "../clean-bank-text";
import { bankTextRules, categories, transactions } from "./schema";
import { merchantRuleStatement } from "./transactions";

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

/** The part of a rule the apply needs: which cleaned text, and the category it files in. */
export type RuleMapping = { cleanedText: string; categoryId: number };

/** The rules whose category is active, for the learned lines and for applying them. */
export async function activeBankTextRules(
	db: D1Database,
): Promise<BankTextRule[]> {
	return drizzle(db)
		.select({
			cleanedText: bankTextRules.cleanedText,
			categoryId: bankTextRules.categoryId,
			categoryName: categories.name,
			icon: categories.icon,
			color: categories.color,
		})
		.from(bankTextRules)
		.innerJoin(categories, eq(categories.id, bankTextRules.categoryId))
		.where(eq(categories.archived, 0))
		.orderBy(asc(bankTextRules.cleanedText))
		.all();
}

/** The upsert that makes the rule for a cleaned text, or moves it to another category: one row per text (decision 163). */
// stays raw: its statement feeds a raw db.batch in settings-saves.ts; moves with that batch.
function upsertBankTextRule(
	db: D1Database,
	cleanedText: string,
	categoryId: number,
): D1PreparedStatement {
	// Only an active category can take a rule (review of #838, round 2): the insert and the update are both conditional
	// on the category's state as the batch runs, so a category archived after the route checked it writes nothing. The
	// WHERE on the SELECT is what lets the upsert follow an INSERT ... SELECT without a parsing ambiguity.
	return db
		.prepare(
			`INSERT INTO bank_text_rules (cleaned_text, category_id)
			SELECT ?, ? WHERE EXISTS (SELECT 1 FROM categories WHERE id = ? AND archived = 0)
			ON CONFLICT(cleaned_text) DO UPDATE SET
				category_id = excluded.category_id, updated_at = datetime('now')
			WHERE EXISTS (SELECT 1 FROM categories WHERE id = excluded.category_id AND archived = 0)`,
		)
		.bind(cleanedText, categoryId, categoryId);
}

/** Makes the rule for a cleaned text, or moves it to another category, without applying it. */
export async function saveBankTextRule(
	db: D1Database,
	cleanedText: string,
	categoryId: number,
): Promise<void> {
	await upsertBankTextRule(db, cleanedText, categoryId).run();
}

/**
 * The statements that fill the rows nothing has filled yet, and a bill's category, with the given rules. Each row is
 * matched by cleanBankText of its raw name, which SQL cannot compute, so the raw names still open are read here, once,
 * grouped in code, and each rule's names go in chunks. Every UPDATE is guarded on the rule as it is when the statement
 * runs (`bank_text_rules` still maps its text to that category, and the category is active), so statements built from an
 * older read fill nothing once the rule was deleted or moved. Reading can throw, and it writes nothing: a caller that
 * batches these statements decides what else goes in the batch.
 */
export async function bankTextRuleStatements(
	db: D1Database,
	rules: readonly RuleMapping[],
): Promise<D1PreparedStatement[]> {
	if (rules.length === 0) return [];
	const categoryFor = new Map(rules.map((rule) => [rule.cleanedText, rule]));

	const open = await drizzle(db)
		.selectDistinct({ rawName: transactions.rawName })
		.from(transactions)
		.where(
			and(
				eq(transactions.isSplit, 0),
				or(
					and(
						isNull(transactions.categoryId),
						isNull(transactions.categorySource),
					),
					eq(transactions.categorySource, "bill"),
				),
				// NOT (a removed part AND a category): both are never NULL, so this is the same as the two IS NULLs below.
				or(
					isNull(transactions.splitRemovedFromCents),
					isNull(transactions.categoryId),
				),
			),
		)
		.all();

	const namesByText = new Map<string, string[]>();

	for (const { rawName } of open) {
		const cleanedText = cleanBankText(rawName);

		if (!categoryFor.has(cleanedText)) continue;
		const names = namesByText.get(cleanedText);

		if (names) names.push(rawName);
		else namesByText.set(cleanedText, [rawName]);
	}

	const statements: D1PreparedStatement[] = [];

	for (const [cleanedText, names] of namesByText) {
		const rule = categoryFor.get(cleanedText);

		if (!rule) continue;

		for (let i = 0; i < names.length; i += RAW_NAMES_PER_UPDATE) {
			const chunk = names.slice(i, i + RAW_NAMES_PER_UPDATE);
			// stays raw: returned to a raw db.batch in settings-saves.ts (via changeBankTextRuleStatements); moves with that batch.
			statements.push(
				db
					.prepare(
						`UPDATE transactions SET
							category_id = ?, category_source = 'merchant_rule', category_confidence = NULL,
							updated_at = datetime('now')
						WHERE raw_name IN (SELECT value FROM json_each(?))
							AND is_split = 0 AND ((category_id IS NULL AND category_source IS NULL) OR category_source = 'bill')
							AND NOT (split_removed_from_cents IS NOT NULL AND category_id IS NOT NULL)
							AND EXISTS (SELECT 1 FROM categories c WHERE c.id = ? AND c.archived = 0)
							AND EXISTS (SELECT 1 FROM bank_text_rules b WHERE b.cleaned_text = ? AND b.category_id = ?)`,
					)
					.bind(
						rule.categoryId,
						JSON.stringify(chunk),
						rule.categoryId,
						cleanedText,
						rule.categoryId,
					),
			);
		}
	}

	return statements;
}

/**
 * Applies the stored bank-text rules to the rows nothing has filled yet, after the merchant rules have run (so a merchant
 * rule wins). A person's choice, a Jev guess, a split parent and a split's removed part are never a target, and nothing
 * about bank text is logged.
 */
export async function applyBankTextRules(db: D1Database): Promise<void> {
	const any = await drizzle(db)
		.select({ id: bankTextRules.id })
		.from(bankTextRules)
		.limit(1)
		.get();

	if (!any) return;
	const rules = await activeBankTextRules(db);
	const statements = await bankTextRuleStatements(db, rules);

	if (statements.length > 0) await db.batch(statements);
}

/**
 * A Change (decision 163, review of #838): the rule is saved and applied in ONE batch, so a failed apply leaves no rule
 * behind and the person is told nothing changed. The batch runs the merchant rules first, then the bank-text rule, as the
 * sync and the sort step do, so a merchant rule still wins. The statements are read before the batch and reading writes
 * nothing; each bank-text UPDATE is guarded on the rule as it stands when it runs.
 *
 * Returns false when no rule was written, because the category was archived after the caller checked it (round 2): the
 * upsert writes nothing then, the guarded fills match nothing, and any older rule stays as it was.
 */
export async function changeBankTextRule(
	db: D1Database,
	cleanedText: string,
	categoryId: number,
): Promise<boolean> {
	const [upsert] = await db.batch(
		await changeBankTextRuleStatements(db, cleanedText, categoryId),
	);

	return (upsert?.meta.changes ?? 0) > 0;
}

/** A Change's statements, for one batch: the rule's upsert first, then the merchant rules, then every bank-text rule's fill. */
export async function changeBankTextRuleStatements(
	db: D1Database,
	cleanedText: string,
	categoryId: number,
): Promise<D1PreparedStatement[]> {
	const others = (await activeBankTextRules(db)).filter(
		(rule) => rule.cleanedText !== cleanedText,
	);

	return [
		upsertBankTextRule(db, cleanedText, categoryId),
		merchantRuleStatement(db),
		...(await bankTextRuleStatements(db, [
			...others,
			{ cleanedText, categoryId },
		])),
	];
}
