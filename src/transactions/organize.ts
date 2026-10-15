import { householdToday } from "../dates";
import { KEPT_NAMES_LOG_SQL } from "../db/ai-log";
import {
	COUNTED_JOINS,
	countedCategorySql,
	FOLLOWS_PURCHASE,
	INCLUDED,
	INCLUDED_ROW,
} from "../db/counted-month";
import { merchantColumnSql, merchantKeySql } from "../db/merchant-key";
import { SETTLE_SUGGESTION_SQL } from "../db/merchant-names";
import { jevSaysMixedAmong } from "../db/mixed-trip";
import { applyMerchantRuleSql } from "../db/transactions";
import { nameSource } from "./name-suggestions";
import { tidyName } from "./tidy-name";

// The same set Home counts as needing a category (a linked refund goes by its purchase's category).
// A linked refund is left to its purchase, as in src/db/transactions.ts.
const NEEDS_CATEGORY = `${countedCategorySql()} IS NULL AND ${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE} AND (t.amount_cents >= 0 OR t.credit_reviewed = 1)`;
const NEEDS_CATEGORY_UPDATE = `category_id IS NULL AND ${INCLUDED_ROW} AND is_split = 0 AND flag_income = 0 AND (amount_cents >= 0 OR credit_reviewed = 1) AND (refund_of_id IS NULL OR refund_of_id IN (SELECT id FROM transactions WHERE excluded = 1))`;
const KEY = merchantKeySql("t");
const KEY_UPDATE = merchantKeySql("transactions");
const CHUNK_SIZE = 90;
/**
 * Every charge in a saved list (a JSON array of ids) still exists and holds the category as a person's choice
 * (#353). Its binds, in order, are `savedStillHoldArgs`.
 */
export const SAVED_STILL_HOLD_SQL = `(SELECT COUNT(DISTINCT value) FROM json_each(?)) = (SELECT COUNT(*) FROM transactions s WHERE s.id IN (SELECT value FROM json_each(?)) AND s.category_id = ? AND s.category_source = 'user')`;
/** The binds for SAVED_STILL_HOLD_SQL's `?`s: the saved list, the saved list again, then the category. */
export const savedStillHoldArgs = (savedIds: string, categoryId: number) => [
	savedIds,
	savedIds,
	categoryId,
];
/**
 * Every saved charge's key still shows the name the question offered (#353): its display name, or with none, its
 * tidied key, as organizeOffer names it (an empty display name is none, as `||` reads it). Only compared, never
 * written. A key with no `merchants` row has no name either. Its binds, in order, are `savedStillNamedArgs`.
 */
export const SAVED_STILL_NAMED_SQL = `NOT EXISTS (SELECT 1 FROM transactions s2 LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("s2")} WHERE s2.id IN (SELECT value FROM json_each(?)) AND CASE WHEN NULLIF(m.display_name, '') IS NULL THEN ${merchantKeySql("s2")} NOT IN (SELECT value FROM json_each(?)) ELSE m.display_name != ? END)`;
/**
 * The binds for SAVED_STILL_NAMED_SQL's `?`s: the saved list, the tidied keys (a JSON array of the saved keys whose
 * tidied name is the question's), then the name the question offered.
 */
export const savedStillNamedArgs = (
	savedIds: string,
	tidyKeys: string,
	merchant: string,
) => [savedIds, tidyKeys, merchant];

export type OrganizeGroup = {
	name: string;
	count: number;
	totalCents: number;
	/** The group's merchant keys (Plaid's merchant name, or the raw name when it sent none), one `merchants` row each. */
	merchantKeys: string[];
	/** The bank texts its charges carry, most charges first, so a person sees everything one choice changes. */
	bankTexts: string[];
};

/** Most charges first, then alphabetical, so the order never depends on how the database returns rows. */
const byCountThenName = (a: [string, number], b: [string, number]) =>
	b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Aggregates transactions in SQL, once per merchant key and bank text, then combines the keys that
 * share a shown name. A key is one merchant whatever bank texts its charges carry, so it is always one
 * group, and saving it categorizes all of its charges. Its name is the one its key's row gives, which
 * every charge with the key shows.
 */
export async function organizeGroups(db: D1Database): Promise<OrganizeGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT ${KEY} AS merchantKey, t.raw_name AS rawName, COUNT(*) AS count, SUM(t.amount_cents) AS totalCents,
				${merchantColumnSql("t", "display_name")} AS shownName
			FROM transactions t
			${COUNTED_JOINS}
			WHERE ${NEEDS_CATEGORY}
			GROUP BY ${KEY}, t.raw_name`,
		)
		.all<{
			merchantKey: string;
			rawName: string;
			count: number;
			totalCents: number;
			shownName: string | null;
		}>();
	const byKey = new Map<
		string,
		{
			count: number;
			totalCents: number;
			shownNames: Map<string, number>;
			bankTexts: Map<string, number>;
		}
	>();
	for (const row of results) {
		const key = byKey.get(row.merchantKey) ?? {
			count: 0,
			totalCents: 0,
			shownNames: new Map<string, number>(),
			bankTexts: new Map<string, number>(),
		};
		key.bankTexts.set(row.rawName, row.count);
		key.count += row.count;
		key.totalCents += row.totalCents;
		if (row.shownName)
			key.shownNames.set(
				row.shownName,
				(key.shownNames.get(row.shownName) ?? 0) + row.count,
			);
		byKey.set(row.merchantKey, key);
	}
	const groups = new Map<string, OrganizeGroup>();
	const bankTextCounts = new Map<string, Map<string, number>>();
	for (const [merchantKey, key] of byKey) {
		const shown = [...key.shownNames].sort(byCountThenName)[0]?.[0];
		const name = shown ?? tidyName(merchantKey);
		const group = groups.get(name) ?? {
			name,
			count: 0,
			totalCents: 0,
			merchantKeys: [],
			bankTexts: [],
		};
		group.count += key.count;
		group.totalCents += key.totalCents;
		group.merchantKeys.push(merchantKey);
		const counts = bankTextCounts.get(name) ?? new Map<string, number>();
		for (const [text, count] of key.bankTexts)
			counts.set(text, (counts.get(text) ?? 0) + count);
		bankTextCounts.set(name, counts);
		groups.set(name, group);
	}
	for (const [name, counts] of bankTextCounts) {
		const group = groups.get(name);
		if (group)
			group.bankTexts = [...counts].sort(byCountThenName).map(([text]) => text);
	}
	return [...groups.values()].sort(
		(a, b) =>
			b.totalCents - a.totalCents ||
			b.count - a.count ||
			a.name.localeCompare(b.name),
	);
}

/**
 * Files a merchant group's charges that need a category under `categoryId`, and names its merchants. It makes
 * no rule: Organize asks first, and only Yes on that question makes one (`setOrganizeRule`, decision 101).
 * Returns the ids of the charges it filed, which the question carries back so Yes can tell whether they still hold it.
 */
export async function saveOrganizeGroup(
	db: D1Database,
	merchantKeys: string[],
	categoryId: number,
	displayName: string | null,
	updatedBy: string,
): Promise<number[]> {
	const names = [...new Set(merchantKeys)];
	if (names.length === 0) return [];
	let saved = 0;
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		const count = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM transactions t ${COUNTED_JOINS} WHERE ${NEEDS_CATEGORY} AND ${KEY} IN (${marks})`,
			)
			.bind(...chunk)
			.first<{ n: number }>();
		saved += count?.n ?? 0;
	}
	// A stale form files nothing after another request categorized the group.
	if (saved === 0) return [];

	const updates: D1PreparedStatement[] = [];
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		updates.push(
			db
				.prepare(
					`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE ${NEEDS_CATEGORY_UPDATE} AND ${KEY_UPDATE} IN (${marks})
					RETURNING id`,
				)
				.bind(categoryId, updatedBy, ...chunk),
		);
	}
	// A merchant's row is written only while one of its charges still needs a category when this batch starts, so a
	// group another save filed first keeps its name. The checks run ahead of the updates that file the charges.
	// The guessed names a person keeps are logged in this batch, in one statement ahead of every merchant's settling
	// upsert (spec §8.6). The log reads each merchant as its upsert finds it, so it must come first. It has the
	// upsert's EXISTS guard too, so a group another save filed first logs no rename.
	const today = displayName ? await householdToday(db) : null;
	const settles: D1PreparedStatement[] = [];
	const kept = displayName
		? names.filter(
				(merchantKey) => nameSource([displayName], merchantKey) === "tally",
			)
		: [];
	if (kept.length > 0)
		settles.push(
			db
				.prepare(
					`${KEPT_NAMES_LOG_SQL} AND EXISTS (SELECT 1 FROM transactions WHERE ${NEEDS_CATEGORY_UPDATE} AND ${KEY_UPDATE} = m.raw_name)`,
				)
				.bind(today, JSON.stringify(kept), displayName),
		);
	for (const merchantKey of names) {
		settles.push(
			db
				.prepare(
					`INSERT INTO merchants (raw_name, display_name)
					SELECT ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE ${NEEDS_CATEGORY_UPDATE} AND ${KEY_UPDATE} = ?)
					ON CONFLICT(raw_name) DO UPDATE SET
						display_name = CASE WHEN ? IS NULL THEN merchants.display_name ELSE excluded.display_name END,
						${SETTLE_SUGGESTION_SQL}`,
				)
				.bind(merchantKey, displayName, merchantKey, displayName),
		);
	}
	const results = await db.batch([...settles, ...updates]);
	// Only the update statements count: the logged rows and upserts ahead of them are skipped.
	return results
		.slice(settles.length)
		.flatMap((result) =>
			(result.results as { id: number }[]).map((row) => row.id),
		);
}

/**
 * Whether every merchant key of a group already has `categoryId` as its rule, so Organize has no question to
 * ask after the group is saved (#353). A key with no `merchants` row has no rule.
 */
export async function groupHasRule(
	db: D1Database,
	merchantKeys: string[],
	categoryId: number,
): Promise<boolean> {
	const names = [...new Set(merchantKeys)];
	let ruled = 0;
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		const row = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM merchants WHERE default_category_id = ? AND raw_name IN (${marks})`,
			)
			.bind(categoryId, ...chunk)
			.first<{ n: number }>();
		ruled += row?.n ?? 0;
	}
	return ruled === names.length;
}

/**
 * Yes on Organize's question (#353, decision 101): makes `categoryId` the rule of each merchant key of the charges
 * Save filed, creating the `merchants` rows that don't exist yet, and applies it to the store's transactions a person
 * hasn't chosen, as setMerchantRule (#209's Yes) does, so later ones follow. Keys come from the saved rows, never from
 * the request, and a key gets the rule only where a saved row carries it as a person's choice. It acts only while every
 * row that Save filed (`savedIds`, a JSON array) still exists and holds `categoryId` as a person's choice: a deleted or
 * recategorized row makes the Yes stale (no rule, no charge changed, no toast). A pending charge that sync merges into
 * its posted row (src/plaid/pending-merge.ts deletes the pending row) makes it stale too, the safe outcome; the edit
 * panel's tick can still make the rule. `merchant` is the store's name the question offered: a key whose display name is
 * another name, or whose cleared name tidies to another, makes the Yes stale too, so the toast can't name a store the rule
 * doesn't cover. The name is only compared, never written. Returns the keys whose rule was written, so a caller can tell
 * whether there is a rule to name.
 */
export async function setOrganizeRule(
	db: D1Database,
	categoryId: number,
	savedIds: string,
	merchant: string,
	actor: string,
): Promise<string[]> {
	const savedRows = `transactions s WHERE s.id IN (SELECT value FROM json_each(?)) AND s.category_id = ? AND s.category_source = 'user'`;
	// Nothing is asked about a trip that looks mixed (decision 113), so a Yes on a question that went stale makes no rule either.
	if (await jevSaysMixedAmong(db, JSON.parse(savedIds) as number[])) return [];
	// SQL can't tidy a name, so the saved keys that tidy to the offered name are read here, once, and the guard that
	// uses them stays inside both statements below. An empty list (no saved key tidies to it) fails a cleared key.
	const { results: keyRows } = await db
		.prepare(
			`SELECT DISTINCT ${merchantKeySql("s")} AS merchantKey FROM transactions s WHERE s.id IN (SELECT value FROM json_each(?))`,
		)
		.bind(savedIds)
		.all<{ merchantKey: string }>();
	const tidyKeys = JSON.stringify(
		keyRows
			.map((row) => row.merchantKey)
			.filter((key) => tidyName(key) === merchant),
	);
	// Two statements whatever the group's size, and both carry the guard, so the rules and the charges they name
	// move together or not at all.
	const rule = db
		.prepare(
			`INSERT INTO merchants (raw_name, default_category_id)
			SELECT DISTINCT ${merchantKeySql("s")}, ? FROM ${savedRows} AND ${SAVED_STILL_HOLD_SQL} AND ${SAVED_STILL_NAMED_SQL}
			ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id
			RETURNING raw_name`,
		)
		.bind(
			categoryId,
			savedIds,
			categoryId,
			...savedStillHoldArgs(savedIds, categoryId),
			...savedStillNamedArgs(savedIds, tidyKeys, merchant),
		);
	const apply = db
		.prepare(
			`${applyMerchantRuleSql(`IN (SELECT ${merchantKeySql("s")} FROM ${savedRows})`)} AND ${SAVED_STILL_HOLD_SQL} AND ${SAVED_STILL_NAMED_SQL}`,
		)
		.bind(
			categoryId,
			actor,
			savedIds,
			categoryId,
			...savedStillHoldArgs(savedIds, categoryId),
			...savedStillNamedArgs(savedIds, tidyKeys, merchant),
		);
	// Only the rule's statement returns rows: the keys it wrote.
	const [written] = await db.batch([rule, apply]);
	return ((written?.results ?? []) as { raw_name: string }[]).map(
		(row) => row.raw_name,
	);
}

/**
 * A store's name as organizeGroups shows it: the store's display name, else its merchant key tidied. Both the question
 * and the store's charges are matched on it, so it is named one way only.
 */
function storeNameOf(shownName: string | null, merchantKey: string): string {
	return shownName || tidyName(merchantKey);
}

/** Organize's question for a saved group, as `organizeOffer` rebuilds it; the view draws it (#353). */
export type GroupOffer = {
	savedIds: number[];
	merchant: string;
	categoryId: number;
	category: string;
};

/**
 * Rebuilds Organize's question from the charges a save filed, or returns nothing when they no longer hold the
 * category (#353). The question's address carries only the saved ids and the category, so every key and name here
 * comes from the database: a crafted address can show a question that is true of the data, or none. It returns
 * nothing unless those charges are one store's, so ids from two stores can't name one of them, and nothing once
 * every key already has the rule, so Back after Yes shows no question.
 */
export async function organizeOffer(
	db: D1Database,
	savedIds: number[],
	categoryId: number,
): Promise<GroupOffer | null> {
	const ids = [...new Set(savedIds)];
	if (ids.length === 0) return null;
	const category = await db
		.prepare("SELECT id, name FROM categories WHERE id = ? AND archived = 0")
		.bind(categoryId)
		.first<{ id: number; name: string }>();
	if (!category) return null;
	// Nothing is asked about a trip that looks mixed (decision 113), so a reload of the question shows none either.
	if (await jevSaysMixedAmong(db, ids)) return null;
	const savedJson = JSON.stringify(ids);
	// No rows come back unless every saved charge still holds the category, so one query decides both.
	const { results } = await db
		.prepare(
			`SELECT DISTINCT ${KEY} AS merchantKey, ${merchantColumnSql("t", "display_name")} AS shownName
			FROM transactions t
			WHERE t.id IN (SELECT value FROM json_each(?)) AND ${SAVED_STILL_HOLD_SQL}`,
		)
		.bind(savedJson, ...savedStillHoldArgs(savedJson, categoryId))
		.all<{ merchantKey: string; shownName: string | null }>();
	const names = [
		...new Set(
			results.map((row) => storeNameOf(row.shownName, row.merchantKey)),
		),
	];
	const merchant = names[0];
	if (names.length !== 1 || merchant === undefined) return null;
	const merchantKeys = results.map((row) => row.merchantKey);
	if (await groupHasRule(db, merchantKeys, categoryId)) return null;
	return {
		savedIds: ids,
		merchant,
		categoryId,
		category: category.name,
	};
}

/**
 * The merchant row number that names a store on Organize's question address (#532): the `merchants` rowid, as Skip names
 * a merchant row, of the key of the first of the charges Save filed. Save writes every filed charge's key row before it
 * files the charge, so the row exists.
 */
export async function storeRowOf(
	db: D1Database,
	savedIds: number[],
): Promise<number | null> {
	const row = await db
		.prepare(
			`SELECT m.rowid AS id FROM transactions t JOIN merchants m ON m.raw_name = ${KEY} WHERE t.id IN (SELECT value FROM json_each(?)) ORDER BY t.id LIMIT 1`,
		)
		.bind(JSON.stringify(savedIds))
		.first<{ id: number }>();
	return row?.id ?? null;
}

/**
 * The charges of a store that Organize's question asks about (#532): every charge in `categoryId` as a person's choice
 * whose merchant key shares the store's name, the name its merchant row gives (its display name, else its key tidied, as
 * organizeGroups names a group). A store with many keys is one name, so the question's address needs only one row
 * number. The names are compared here, since tidyName has no SQL form: one scan of the category's distinct merchant
 * keys, then the charges of the keys that match, in id order. Nothing when the row is gone.
 */
export async function storeChargeIds(
	db: D1Database,
	storeRow: number,
	categoryId: number,
): Promise<number[]> {
	const seed = await db
		.prepare(
			"SELECT raw_name AS key, display_name AS displayName FROM merchants WHERE rowid = ?",
		)
		.bind(storeRow)
		.first<{ key: string; displayName: string | null }>();
	if (!seed) return [];
	const name = storeNameOf(seed.displayName, seed.key);
	const { results: keyRows } = await db
		.prepare(
			`SELECT DISTINCT ${KEY} AS merchantKey, ${merchantColumnSql("t", "display_name")} AS shownName
			FROM transactions t WHERE t.category_id = ? AND t.category_source = 'user'`,
		)
		.bind(categoryId)
		.all<{ merchantKey: string; shownName: string | null }>();
	const merchantKeys = keyRows
		.filter((row) => storeNameOf(row.shownName, row.merchantKey) === name)
		.map((row) => row.merchantKey);
	if (merchantKeys.length === 0) return [];
	const { results } = await db
		.prepare(
			`SELECT t.id AS id FROM transactions t WHERE ${KEY} IN (SELECT value FROM json_each(?)) AND t.category_id = ? AND t.category_source = 'user' ORDER BY t.id`,
		)
		.bind(JSON.stringify(merchantKeys), categoryId)
		.all<{ id: number }>();
	return results.map((row) => row.id);
}
