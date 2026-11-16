// The store's line, as the second ask reads it (spec §7, "The second ask"; decision 225): whether the line still stands for a
// bank text, whether the household has an answer of its own for it, and the read made just before each call. Plain
// TypeScript with SQL fragments; the save and the read live in second-ask.ts.

import { STILL_ON_SQL } from "../db/ai-switches";
import { loadLearnedLines } from "../db/learned-lines";
import { merchantKeySql } from "../db/merchant-key";

/** The line of the lookup text `text` (an SQL expression) stands: found, with a line, and no key of the text private (spec §7). */
// stays raw: a fragment inlined into raw statements (decision 179)
export const lineStandsSql = (text: string) =>
	`(EXISTS (SELECT 1 FROM merchant_lookups lsl WHERE lsl.lookup_text = ${text} AND lsl.status = 'found' AND COALESCE(lsl.line, '') != '')
		AND NOT EXISTS (SELECT 1 FROM merchant_lookup_texts lsp WHERE lsp.lookup_text = ${text} AND lsp.private = 1))`;

/**
 * The household has its own answer for the lookup text `text` (987-plan 5.1 point 6, the part SQL can do): a row of any of its
 * keys filed by a person or a rule, an active merchant rule on any of its keys, or an active bank-text rule on one of `cleaned`,
 * an SQL expression for a JSON array of the cleaned bank texts of the text's rows. The learned line is checked in TypeScript
 * (learnedTexts), since cleanBankText is not SQL.
 */
// stays raw: a fragment inlined into raw statements (decision 179)
export const householdAnsweredSql = (text: string, cleaned: string) =>
	`(EXISTS (SELECT 1 FROM merchant_lookup_texts hak JOIN transactions hat ON ${merchantKeySql("hat")} = hak.merchant_key
				WHERE hak.lookup_text = ${text} AND hat.category_id IS NOT NULL AND hat.category_source IN ('user', 'merchant_rule'))
		OR EXISTS (SELECT 1 FROM merchant_lookup_texts hmk JOIN merchants ham ON ham.raw_name = hmk.merchant_key
				JOIN categories hac ON hac.id = ham.default_category_id AND hac.archived = 0 WHERE hmk.lookup_text = ${text})
		OR EXISTS (SELECT 1 FROM bank_text_rules hab JOIN categories hbc ON hbc.id = hab.category_id AND hbc.archived = 0
				WHERE hab.cleaned_text IN (SELECT value FROM json_each(${cleaned}))))`;

/** A save's WHERE guard as SQL, with the values it binds in order. */
export type LineGuard = { sql: string; binds: string[] };

/** Both, with the text bound, for a save's WHERE: the line stands and the household has no answer of its own. Binds in order. */
export function lineGuard(text: string, cleanedTexts: string[]): LineGuard {
	return {
		sql: `${lineStandsSql("?")} AND NOT ${householdAnsweredSql("?", "?")}`,
		binds: [text, text, text, text, JSON.stringify(cleanedTexts)],
	};
}

/** The cleaned bank texts the household has a learned line or a Change rule for (decisions 156 to 163): point 6's TypeScript half. */
export async function learnedTexts(db: D1Database): Promise<string[]> {
	return (await loadLearnedLines(db)).map((line) => line.cleanedText);
}

/**
 * The read made just before each second-ask call (spec §7:248): the line, or null when it no longer stands, the household now
 * has an answer of its own (the SQL part), or a switch in `switchKeys` (stillOnKeys) is off.
 */
export async function readLineForAsk(
	db: D1Database,
	ask: { text: string; cleanedTexts: string[]; switchKeys: string },
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT ml.line AS line FROM merchant_lookups ml WHERE ml.lookup_text = ?
				AND ${lineStandsSql("ml.lookup_text")} AND NOT ${householdAnsweredSql("ml.lookup_text", "?")} AND ${STILL_ON_SQL}`,
		)
		.bind(ask.text, JSON.stringify(ask.cleanedTexts), ask.switchKeys)
		.first<{ line: string | null }>();

	return row?.line ?? null;
}
