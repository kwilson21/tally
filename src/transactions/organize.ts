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
import { nameSource } from "./name-suggestions";
import { tidyName } from "./tidy-name";

// The same set Home counts as needing a category (a linked refund goes by its purchase's category).
// A linked refund is left to its purchase, as in src/db/transactions.ts.
const NEEDS_CATEGORY = `${countedCategorySql()} IS NULL AND ${INCLUDED} AND t.is_split = 0 AND t.flag_income = 0 AND NOT ${FOLLOWS_PURCHASE} AND (t.amount_cents >= 0 OR t.credit_reviewed = 1)`;
const NEEDS_CATEGORY_UPDATE = `category_id IS NULL AND ${INCLUDED_ROW} AND is_split = 0 AND flag_income = 0 AND (amount_cents >= 0 OR credit_reviewed = 1) AND (refund_of_id IS NULL OR refund_of_id IN (SELECT id FROM transactions WHERE excluded = 1))`;
const KEY = merchantKeySql("t");
const KEY_UPDATE = merchantKeySql("transactions");
const CHUNK_SIZE = 90;

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
 */
export async function saveOrganizeGroup(
	db: D1Database,
	merchantKeys: string[],
	categoryId: number,
	displayName: string | null,
	updatedBy: string,
): Promise<number> {
	const names = [...new Set(merchantKeys)];
	if (names.length === 0) return 0;
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
	// A stale form must not alter rules after another request categorized the group.
	if (saved === 0) return 0;

	const updates: D1PreparedStatement[] = [];
	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		updates.push(
			db
				.prepare(
					`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE ${NEEDS_CATEGORY_UPDATE} AND ${KEY_UPDATE} IN (${marks})`,
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
		.reduce((changed, result) => changed + result.meta.changes, 0);
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
 * Yes on Organize's question (#353, decision 101): makes `categoryId` the rule of each merchant key, creating the
 * `merchants` rows that don't exist yet, so later charges follow. A key gets the rule only where a charge a person
 * filed in `categoryId` carries it, so a posted key that has no such charge sets nothing. Like the save that filed
 * the group, it changes no charge: the rule reaches the next ones.
 */
export async function setOrganizeRule(
	db: D1Database,
	merchantKeys: string[],
	categoryId: number,
): Promise<void> {
	const statements = [...new Set(merchantKeys)].map((merchantKey) =>
		db
			.prepare(
				`INSERT INTO merchants (raw_name, default_category_id)
				SELECT ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE ${KEY_UPDATE} = ? AND category_id = ? AND category_source = 'user')
				ON CONFLICT(raw_name) DO UPDATE SET default_category_id = excluded.default_category_id`,
			)
			.bind(merchantKey, categoryId, merchantKey, categoryId),
	);
	if (statements.length > 0) await db.batch(statements);
}
