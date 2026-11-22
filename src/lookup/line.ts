// The store's line, as the second ask reads it (spec §7, "The second ask"; decision 225): whether the line still stands for a
// bank text, whether the household has an answer of its own for it, and the read made just before each call. Plain
// TypeScript with SQL fragments; the save and the read live in second-ask.ts.

import { STILL_ON_SQL } from "../db/ai-switches";
import {
	LEARNED_SOURCES_SQL,
	loadLearnedLineSnapshot,
	loadLearnedLines,
} from "../db/learned-lines";
import { lineStandsSql } from "../db/line-stands";
import { merchantKeySql } from "../db/merchant-key";
import { waitingForJevSql } from "../db/transactions";

export { lineStandsSql } from "../db/line-stands";

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

/** Fail closed if a sibling raw name arrived after TypeScript cleaned the snapshot.
 * Cleaning is intentionally not reimplemented in SQL. In the final snapshot every
 * current name must have been checked; removed names only make the check stricter.
 */
export const siblingNamesCoveredSql = (text: string, rawNames: string) =>
	`NOT EXISTS (SELECT 1 FROM transactions snt JOIN merchant_lookup_texts snm
 ON snm.merchant_key = ${merchantKeySql("snt")} WHERE snm.lookup_text = ${text}
 AND snt.raw_name NOT IN (SELECT value FROM json_each(${rawNames})))`;

/** A save's WHERE guard as SQL, with the values it binds in order. */
export type LineGuard = { sql: string; binds: string[] };

/** Both, with the text bound, for a save's WHERE: the line stands and the household has no answer of its own. Binds in order. */
export function lineGuard(
	text: string,
	cleanedTexts: string[],
	rawNames: string[],
): LineGuard {
	return {
		sql: `${lineStandsSql("?")} AND NOT ${householdAnsweredSql("?", "?")} AND ${siblingNamesCoveredSql("?", "?")}`,
		binds: [
			text,
			text,
			text,
			text,
			JSON.stringify(cleanedTexts),
			text,
			JSON.stringify(rawNames),
		],
	};
}

/** The cleaned bank texts the household has a learned line or a Change rule for (decisions 156 to 163): point 6's TypeScript half. */
export async function learnedTexts(db: D1Database): Promise<string[]> {
	return (await loadLearnedLines(db)).map((line) => line.cleanedText);
}

/** Bound transient guard evidence below D1's bound-value limit; never truncate safety evidence. */
export async function learnedTextSnapshot(
	db: D1Database,
): Promise<{ texts: string[]; source: string | null }> {
	const snapshot = await loadLearnedLineSnapshot(db);

	return {
		texts: snapshot.lines.map((line) => line.cleanedText),
		source: snapshot.source,
	};
}

/**
 * The atomic claim made just before each second-ask call (spec §7:248): the line, or null when it no longer stands, the household now
 * has an answer of its own (the SQL part), or a switch in `switchKeys` (stillOnKeys) is off.
 */
export async function claimLineForAsk(
	db: D1Database,
	ask: {
		text: string;
		learnedSource: string;
		transactionId: number;
		turnId: string;
		cleanedTexts: string[];
		rawNames: string[];
		switchKeys: string;
		transactionGuard: { sql: string; binds: (string | number | null)[] };
	},
): Promise<string | null> {
	const row = await db
		.prepare(
			`INSERT INTO lookup_second_claims (transaction_id, turn_id)
             SELECT ?, ? FROM merchant_lookups ml WHERE ml.lookup_text = ?
				AND ${lineStandsSql("ml.lookup_text")} AND NOT ${householdAnsweredSql("ml.lookup_text", "?")} AND ${STILL_ON_SQL}
				AND ${siblingNamesCoveredSql("ml.lookup_text", "?")}
                AND ${LEARNED_SOURCES_SQL} = ?
                AND NOT EXISTS (SELECT 1 ${waitingForJevSql({ categories: true, income: true })})
                AND EXISTS (SELECT 1 FROM transactions WHERE ${ask.transactionGuard.sql})
                ON CONFLICT(transaction_id) DO NOTHING
                RETURNING (SELECT line FROM merchant_lookups WHERE lookup_text = ?) AS line`,
		)
		.bind(
			ask.transactionId,
			ask.turnId,
			ask.text,
			JSON.stringify(ask.cleanedTexts),
			ask.switchKeys,
			JSON.stringify(ask.rawNames),
			ask.learnedSource,
			...ask.transactionGuard.binds,
			ask.text,
		)
		.first<{ line: string | null }>();

	return row?.line ?? null;
}
