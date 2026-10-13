// "Never suggest" rules (spec §5, §7, §8.6, decision 101): the lines a person said Yes to, so Tally stops
// making that suggestion for that store. Only a Yes writes one; nothing else in the app does. A rule only
// hides the suggestion below the threshold: a guess Tally is sure of still applies (decision 101).
import { tidyName } from "../transactions/tidy-name";
import { merchantKeySql } from "./merchant-key";

// A name or a category has no No, so only these three suggestions ever write a line (decision 101).
export const NEVER_SUGGEST_KINDS = [
	"new_category",
	"income",
	"transfer",
] as const;
export type NeverSuggestKind = (typeof NEVER_SUGGEST_KINDS)[number];

export type NeverSuggestRule = {
	id: number;
	/** The merchant key (spec §6.1): the `merchants` row it belongs to. */
	merchantKey: string;
	/** What the line calls the store: its display name, or its key tidied. */
	merchant: string;
	kind: NeverSuggestKind;
	/** The household's day of the No, as YYYY-MM-DD. */
	decidedOn: string;
};

type Row = {
	id: number;
	merchantKey: string;
	displayName: string | null;
	kind: NeverSuggestKind;
	decidedOn: string;
};

const RULE_SELECT = `SELECT r.id, r.merchant_key AS merchantKey, m.display_name AS displayName, r.kind,
	r.decided_on AS decidedOn
	FROM never_suggest_rules r
	LEFT JOIN merchants m ON m.raw_name = r.merchant_key`;

const toRule = (row: Row): NeverSuggestRule => ({
	id: row.id,
	merchantKey: row.merchantKey,
	merchant: row.displayName || tidyName(row.merchantKey),
	kind: row.kind,
	decidedOn: row.decidedOn,
});

/**
 * The lines the family sees, newest first: the Settings list (spec §8.6, "Never suggest"). A bank-text line
 * that sync copied to the store's name (decision 101) shows once, as the store-name line, whose Remove takes
 * both. So a bank-text line is left out while a line of the same kind sits under a Plaid name one of its
 * charges carries. Every stored row stays in the table, and removeNeverSuggest still finds a hidden one.
 */
export async function neverSuggestRules(
	db: D1Database,
): Promise<NeverSuggestRule[]> {
	const { results } = await db
		.prepare(
			`${RULE_SELECT}
			WHERE NOT EXISTS (SELECT 1 FROM transactions t
				JOIN never_suggest_rules s ON s.merchant_key = t.merchant_name AND s.kind = r.kind
				WHERE t.raw_name = r.merchant_key AND NULLIF(t.merchant_name, '') IS NOT NULL AND t.merchant_name != r.merchant_key)
			ORDER BY r.decided_on DESC, r.id DESC`,
		)
		.all<Row>();
	return results.map(toRule);
}

/**
 * Adds one line when the person said Yes. A line already there stays as it is, so a repeat answer adds
 * nothing and keeps the day of the first. Returns whether a line was added.
 */
export async function addNeverSuggest(
	db: D1Database,
	{
		merchantKey,
		kind,
		decidedOn,
	}: {
		merchantKey: string;
		kind: NeverSuggestKind;
		decidedOn: string;
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO never_suggest_rules (merchant_key, kind, decided_on)
			VALUES (?, ?, ?)`,
		)
		.bind(merchantKey, kind, decidedOn)
		.run();
	return result.meta.changes > 0;
}

/**
 * Removes the clicked line and returns it, so the toast can name it, with how many lines went. The store's
 * other lines of the same kind go too: the store-name line and the bank-text lines of its charges, under
 * every key the store goes by (decision 101), so a later sync can't copy a removed line back. A stale Remove
 * changes nothing and returns null: the line is gone already, or its id now names another store's or kind's
 * line (SQLite can reuse a deleted id), so the form's store and kind must match the line too.
 */
export async function removeNeverSuggest(
	db: D1Database,
	{ id, merchantKey, kind }: { id: number; merchantKey: string; kind: string },
): Promise<{ rule: NeverSuggestRule; removedCount: number } | null> {
	if (!NEVER_SUGGEST_KINDS.includes(kind as NeverSuggestKind)) return null;
	const rule = await db
		.prepare(
			`${RULE_SELECT} WHERE r.id = ? AND r.merchant_key = ? AND r.kind = ?`,
		)
		.bind(id, merchantKey, kind)
		.first<Row>();
	if (!rule) return null;
	const result = await db
		.prepare(
			`WITH names(n) AS (SELECT ?1 UNION SELECT merchant_name FROM transactions WHERE raw_name = ?1 AND NULLIF(merchant_name, '') IS NOT NULL),
				keys(k) AS (SELECT n FROM names UNION SELECT raw_name FROM transactions WHERE merchant_name IN (SELECT n FROM names))
			DELETE FROM never_suggest_rules WHERE kind = ?2 AND merchant_key IN (SELECT k FROM keys)`,
		)
		.bind(rule.merchantKey, rule.kind)
		.run();
	return result.meta.changes > 0
		? { rule: toRule(rule), removedCount: result.meta.changes }
		: null;
}

/** The line as Settings reads it aloud and shows it: "Never suggest income for Venmo". */
export function neverSuggestRuleLine(rule: NeverSuggestRule): string {
	switch (rule.kind) {
		case "income":
			return `Never suggest income for ${rule.merchant}`;
		case "transfer":
			return `Never suggest a transfer for ${rule.merchant}`;
		case "new_category":
			return `Never suggest a new category for ${rule.merchant}`;
	}
}

/**
 * SQL that is true when the row `alias` names has a "Never suggest" line of `kind`, so a refused suggestion
 * never comes back. The row's store has the line either under its own key, or, for a charge with no Plaid name,
 * under the Plaid name of a charge with the same bank text (sameMerchantSql's relation, read here rather than
 * copied on Yes). So a named charge is hidden only by its own key's line, and two stores that share a bank text
 * never hide each other (#459). The subquery needs no check that its charge is named: an unnamed one has the bank
 * text's own key, which the first check already reads. Used by the Maybe rows, the review queue and the
 * new-category grouping.
 * `alias` is the transactions table's name or alias, as for `merchantKeySql`. `kind` is one of the typed kinds,
 * never user input.
 */
export const neverSuggestedSql = (
	alias: string,
	kind: NeverSuggestKind,
): string =>
	`(EXISTS (SELECT 1 FROM never_suggest_rules n WHERE n.merchant_key = ${merchantKeySql(alias)} AND n.kind = '${kind}')
		OR (NULLIF(${alias}.merchant_name, '') IS NULL AND EXISTS (SELECT 1 FROM transactions u
			JOIN never_suggest_rules n ON n.merchant_key = ${merchantKeySql("u")} AND n.kind = '${kind}'
			WHERE u.raw_name = ${alias}.raw_name)))`;
