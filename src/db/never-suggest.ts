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

/** Every line, newest first: the Settings list (spec §8.6, "Never suggest"). */
export async function neverSuggestRules(
	db: D1Database,
): Promise<NeverSuggestRule[]> {
	const { results } = await db
		.prepare(`${RULE_SELECT} ORDER BY r.decided_on DESC, r.id DESC`)
		.all<Row>();
	return results.map(toRule);
}

/**
 * The stores a question about one item may write a line for: the item's own store, read from the database
 * by the item's key (`income-12`, `transfer-12` or `new-3`, a suggestion's number). A store the form names
 * that isn't one of these is refused, so an answer can't write a line for text the question never named.
 */
export async function questionStores(
	db: D1Database,
	kind: NeverSuggestKind,
	id: string,
): Promise<Set<string>> {
	const found = /^(income|transfer|new)-(\d+)$/.exec(id);
	if (!found) return new Set();
	const [, prefix, number] = found;
	if (kind !== (prefix === "new" ? "new_category" : prefix)) return new Set();
	const sql =
		prefix === "new"
			? `SELECT DISTINCT ${merchantKeySql("t")} AS key FROM transactions t WHERE t.category_suggestion_id = ?`
			: `SELECT ${merchantKeySql("t")} AS key FROM transactions t WHERE t.id = ?`;
	const { results } = await db
		.prepare(sql)
		.bind(Number(number))
		.all<{ key: string }>();
	return new Set(results.map((row) => row.key));
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
 * (the line is gone already) returns null and changes nothing.
 */
export async function removeNeverSuggest(
	db: D1Database,
	id: number,
): Promise<{ rule: NeverSuggestRule; removedCount: number } | null> {
	const rule = await db
		.prepare(`${RULE_SELECT} WHERE r.id = ?`)
		.bind(id)
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
 * SQL that is true when the store (`merchantKeySql`, an expression for the merchant key) has a "Never
 * suggest" line of `kind`. Used by the Maybe rows, the review queue and the new-category grouping, so a
 * refused suggestion never comes back. `kind` is one of the typed kinds, never user input.
 */
export const neverSuggestedSql = (
	merchantKeySql: string,
	kind: NeverSuggestKind,
): string =>
	`EXISTS (SELECT 1 FROM never_suggest_rules n WHERE n.merchant_key = ${merchantKeySql} AND n.kind = '${kind}')`;
