// "Never suggest" rules (spec §5, §7, §8.6, decision 101): the lines a person said Yes to, so Tally stops
// making that suggestion for that store. Only a Yes writes one; nothing else in the app does. A rule only
// hides the suggestion below the threshold: a guess Tally is sure of still applies (decision 101).
import { tidyName } from "../transactions/tidy-name";
import { merchantKeySql } from "./merchant-key";

export const NEVER_SUGGEST_KINDS = [
	"name",
	"category",
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
	categoryId: number | null;
	/** The refused category's name, for a category line. */
	category: string | null;
	/** The household's day of the No, as YYYY-MM-DD. */
	decidedOn: string;
};

type Row = {
	id: number;
	merchantKey: string;
	displayName: string | null;
	kind: NeverSuggestKind;
	categoryId: number | null;
	category: string | null;
	decidedOn: string;
};

const RULE_SELECT = `SELECT r.id, r.merchant_key AS merchantKey, m.display_name AS displayName, r.kind,
	r.category_id AS categoryId, c.name AS category, r.decided_on AS decidedOn
	FROM never_suggest_rules r
	LEFT JOIN merchants m ON m.raw_name = r.merchant_key
	LEFT JOIN categories c ON c.id = r.category_id`;

const toRule = (row: Row): NeverSuggestRule => ({
	id: row.id,
	merchantKey: row.merchantKey,
	merchant: row.displayName || tidyName(row.merchantKey),
	kind: row.kind,
	categoryId: row.categoryId,
	category: row.category,
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
		categoryId = null,
		decidedOn,
	}: {
		merchantKey: string;
		kind: NeverSuggestKind;
		categoryId?: number | null;
		decidedOn: string;
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO never_suggest_rules (merchant_key, kind, category_id, decided_on)
			VALUES (?, ?, ?, ?)`,
		)
		.bind(merchantKey, kind, categoryId, decidedOn)
		.run();
	return result.meta.changes > 0;
}

/**
 * Removes one line and returns it, so the toast can name it. A stale Remove (the line is gone already)
 * returns null and changes nothing.
 */
export async function removeNeverSuggest(
	db: D1Database,
	id: number,
): Promise<NeverSuggestRule | null> {
	const rule = await db
		.prepare(`${RULE_SELECT} WHERE r.id = ?`)
		.bind(id)
		.first<Row>();
	if (!rule) return null;
	const result = await db
		.prepare("DELETE FROM never_suggest_rules WHERE id = ?")
		.bind(id)
		.run();
	return result.meta.changes > 0 ? toRule(rule) : null;
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
		case "name":
			return `Never suggest a name for ${rule.merchant}`;
		case "category":
			return `Never suggest ${rule.category ?? "a category"} for ${rule.merchant}`;
	}
}

/**
 * SQL that is true when the store (`merchantKeySql`, an expression for the merchant key) has no "Never
 * suggest" line of `kind`. Used by the review queue and the new-category grouping, so a refused
 * suggestion never comes back. `kind` is one of the typed kinds, never user input.
 */
export const neverSuggestedSql = (
	merchantKeySql: string,
	kind: NeverSuggestKind,
): string =>
	`EXISTS (SELECT 1 FROM never_suggest_rules n WHERE n.merchant_key = ${merchantKeySql} AND n.kind = '${kind}')`;
