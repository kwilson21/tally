import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { householdToday } from "../dates";
import { KEPT_NAMES_LOG_SQL } from "../db/ai-log";
import { LIST, LIST_VERSION } from "../db/category-saves";
import { COUNTED_JOINS, INCLUDED_ROW } from "../db/counted-month";
import { Database } from "../db/database";
import { decideAndSave, guardedSave } from "../db/guarded-save";
import { merchantColumnSql, merchantKeySql } from "../db/merchant-key";
import { SETTLE_SUGGESTION_SQL } from "../db/merchant-names";
import { jevSaysMixedAmong } from "../db/mixed-trip";
import { applyMerchantRuleSql, NEEDS_CATEGORY } from "../db/transactions";
import { NameTaken, type StoredCategory } from "../rules/categories";
import type {
	FileGroupFacts,
	FileGroupRequest,
	FileGroupWrite,
	StoreRuleFacts,
	StoreRuleRequest,
	StoreRuleWrite,
} from "../rules/organize";
import { nameSource } from "./name-suggestions";
import { tidyName } from "./tidy-name";

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

/** The ids the update statements filed. */
function filedIds(updates: D1Result[]): number[] {
	// SAFETY: each update statement ends in RETURNING id, so every row these results hold has an id.
	const rows = updates.flatMap((result) => result.results as { id: number }[]);

	return rows.map((row) => row.id);
}

/** Where a group's charges go: a category the family has, by its id, or the one the same batch makes, by its name's key. */
type GroupCategory = { id: number } | { nameKey: string };

/**
 * The statements that name a group's merchants (`settles`) and file its charges (`updates`), for one batch. The charges
 * have no cap, so SQL files them (decision 209), 90 merchant keys a statement to stay under D1's 100 bound values.
 * `kept` is the keys for which `displayName` is Tally's guess kept by a person; `today` is the day that is logged on.
 */
function groupStatements(
	db: D1Database,
	names: string[],
	category: GroupCategory,
	displayName: string | null,
	kept: string[],
	today: string | null,
	updatedBy: string,
) {
	const categoryId = "id" in category ? category.id : null;
	const nameKey = "id" in category ? null : category.nameKey;
	const updates: D1PreparedStatement[] = [];

	for (let offset = 0; offset < names.length; offset += CHUNK_SIZE) {
		const chunk = names.slice(offset, offset + CHUNK_SIZE);
		const marks = chunk.map(() => "?").join(", ");
		updates.push(
			db
				.prepare(
					`UPDATE transactions SET category_id = COALESCE(?, (SELECT id FROM categories WHERE name_key = ? AND archived = 0)), category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
						updated_by = ?, updated_at = datetime('now')
					WHERE ${NEEDS_CATEGORY_UPDATE} AND ${KEY_UPDATE} IN (${marks})
					RETURNING id`,
				)
				.bind(categoryId, nameKey, updatedBy, ...chunk),
		);
	}

	// A merchant's row is written only while one of its charges still needs a category when this batch starts, so a
	// group another save filed first keeps its name. The checks run ahead of the updates that file the charges.
	// The guessed names a person keeps are logged in this batch, in one statement ahead of every merchant's settling
	// upsert (spec §8.6). The log reads each merchant as its upsert finds it, so it must come first. It has the
	// upsert's EXISTS guard too, so a group another save filed first logs no rename.
	const settles: D1PreparedStatement[] = [];

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

	return { settles, updates };
}

/**
 * Files a merchant group's charges that need a category under `categoryId`, and names its merchants. It makes
 * no rule: Organize asks first, and only Yes on that question makes one (`setOrganizeRule`, decision 101).
 * Returns the ids of the charges it filed. The question's address names their store by a merchant row (`storeRowOf`,
 * #532), and nothing carries these ids back.
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

	const { settles, updates } = groupStatements(
		db,
		names,
		{ id: categoryId },
		displayName,
		displayName
			? names.filter(
					(merchantKey) => nameSource([displayName], merchantKey) === "tally",
				)
			: [],
		displayName ? await householdToday(db) : null,
		updatedBy,
	);

	const results = await db.batch([...settles, ...updates]);

	// Only the update statements count: the logged rows and upserts ahead of them are skipped.
	return filedIds(results.slice(settles.length));
}

/** How many charges of the merchant keys ?1 (a JSON list) still need a category, as SQL. */
const WAITING_COUNT = `(SELECT COUNT(*) FROM transactions t ${COUNTED_JOINS} WHERE ${NEEDS_CATEGORY} AND ${KEY} IN (SELECT value FROM json_each(?1)))`;

/** Everything the filing rule reads as one text, as SQL: the whole category list and that count. */
const GROUP_VERSION = `(${LIST_VERSION} || '/' || ${WAITING_COUNT})`;

/** What the filing rule reads: the family's categories and how many of the store's charges wait, with their version, in one batch. */
export async function fileGroupFacts(
	db: D1Database,
	merchantKeys: string[],
): Promise<FileGroupFacts> {
	const keys = JSON.stringify(merchantKeys);

	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch is
	// one transaction, so the version is of the very rows read beside it.
	const [list, state] = (await db.batch([
		db.prepare(LIST),
		db
			.prepare(
				`SELECT ${WAITING_COUNT} AS waiting, ${GROUP_VERSION} AS version`,
			)
			.bind(keys),
	])) as [
		D1Result<Omit<StoredCategory, "archived"> & { archived: number }>,
		D1Result<{ waiting: number; version: string }>,
	];

	return {
		categories: list.results.map((c) => ({ ...c, archived: c.archived === 1 })),
		waiting: state.results[0]?.waiting ?? 0,
		version: state.results[0]?.version ?? "",
	};
}

/** The text of the guard's failure, as D1 passes SQLite's message on. Only the guard can try to add a category with no name. */
const GROUP_GUARD_RAISED = /NOT NULL constraint failed: categories\.name/;

/**
 * Reads the filing's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when the
 * guard raises (decideAndSave). The batch is the guard (it tries to add a category with no name when the list or the
 * store's waiting charges changed since the read, which fails the batch), the new category when the rule makes one,
 * and the statements that name the store and file its charges. The category and the filing land together or not at
 * all. Answers with the category's name and the ids of the charges filed.
 */
export const decideFileGroup = <E>(
	groupRule: {
		decide: (
			request: FileGroupRequest,
			facts: FileGroupFacts,
		) => Effect.Effect<Option.Option<FileGroupWrite>, E>;
	},
	request: FileGroupRequest,
	today: string,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const { decided, saved } = yield* decideAndSave({
			facts: Effect.promise(() => fileGroupFacts(db, request.merchantKeys)),
			decide: (facts) => groupRule.decide(request, facts),
			save: (write) => {
				const { settles, updates } = groupStatements(
					db,
					write.merchantKeys,
					// The rule names an existing category's id whenever it makes none, so the 0 is never used.
					write.create
						? { nameKey: write.create.nameKey }
						: { id: write.categoryId ?? 0 },
					write.displayName,
					write.keptGuessFor,
					today,
					write.who,
				);

				const before = [
					db
						.prepare(
							`INSERT INTO categories (name, icon, color) SELECT NULL, 'tag', 'cat-blue' WHERE ${GROUP_VERSION} IS NOT ?2`,
						)
						.bind(JSON.stringify(write.merchantKeys), write.expectedVersion),
					...(write.create
						? [
								db
									.prepare(
										"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES (?, ?, 'tag', ?, ?)",
									)
									.bind(
										write.create.name,
										write.create.nameKey,
										write.create.color,
										write.create.sortOrder,
									),
							]
						: []),
					...settles,
				];

				return guardedSave(
					() => db.batch([...before, ...updates]),
					(error) => GROUP_GUARD_RAISED.test(error.message),
					() => new NameTaken(),
				).pipe(Effect.map((results) => filedIds(results.slice(before.length))));
			},
			gaveUp: "A store's charges kept changing while they were being filed.",
		});

		const write = Option.getOrThrow(decided);

		// A category made in the batch has its number only once the batch has run.
		const made = write.create
			? yield* Effect.promise(() =>
					db
						.prepare("SELECT id FROM categories WHERE name_key = ?")
						.bind(write.create?.nameKey ?? "")
						.first<{ id: number }>(),
				)
			: null;

		return {
			categoryId: write.categoryId ?? made?.id ?? 0,
			categoryName: write.categoryName,
			filed: saved ?? [],
		};
	});

/**
 * Rebuilds Organize's question for the store and category the form posted, asks the rule and, on a Yes, writes the
 * rule (setOrganizeRule, whose SQL carries its own guards: decision 209, the store's charges have no cap). Answers with
 * the question and the merchant keys whose rule was written; none when the rule had nothing to do or the Yes was stale.
 */
export const decideStoreRule = <E>(
	storeRule: {
		decide: (
			request: StoreRuleRequest,
			facts: StoreRuleFacts,
		) => Effect.Effect<Option.Option<StoreRuleWrite>, E>;
	},
	request: StoreRuleRequest,
	store: number,
	categoryId: number,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const offer = yield* Effect.promise(() =>
			storeOffer(db, store, categoryId),
		);

		const mixed = offer
			? yield* Effect.promise(() => jevSaysMixedAmong(db, offer.savedIds))
			: false;

		const decided = yield* storeRule.decide(request, { offer, mixed });

		if (Option.isNone(decided)) return { offer: null, written: [] };
		const write = decided.value;

		const written = yield* Effect.promise(() =>
			setOrganizeRule(
				db,
				write.categoryId,
				JSON.stringify(write.savedIds),
				write.merchant,
				write.who,
			),
		);

		return { offer: write, written };
	});

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
 * Yes on Organize's question (#353, decision 101, #532): makes `categoryId` the rule of each merchant key of the store's
 * charges in that category, creating the `merchants` rows that don't exist yet, and applies it to the store's transactions
 * a person hasn't chosen, as setMerchantRule (#209's Yes) does, so later ones follow. `savedIds` (a JSON array) is those
 * charges, rebuilt by storeOffer when Yes is answered and never read from the request. Keys come from those rows, and a
 * key gets the rule only where a row carries it as a person's choice. The guard acts only while every row still exists
 * and holds `categoryId` as a person's choice, so a change between that rebuild and this batch makes the Yes stale (no
 * rule, no charge changed, no toast). A pending charge that sync merges into its posted row (src/plaid/pending-merge.ts
 * deletes the pending row) makes it stale too, the safe outcome; the edit panel's tick can still make the rule.
 * `merchant` is the store's name the question offered: a key whose display name is another name, or whose cleared name
 * tidies to another, makes the Yes stale too, so the toast can't name a store the rule doesn't cover. The name is only
 * compared, never written. Returns the keys whose rule was written, so a caller can tell whether there is a rule to name.
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
	// SAFETY: savedIds is JSON.stringify of the offer's saved transaction ids, a number array (routes/organize.tsx).
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

	// SAFETY: the rule statement ends in RETURNING raw_name, so every row in its results has a raw_name.
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

/** Organize's question for a store, as `storeOffer` rebuilds it; the view draws it (#353, #532). */
export type GroupOffer = {
	/** The store's charges in the category that the question is about: Yes makes the rule on their keys. */
	savedIds: number[];
	merchant: string;
	categoryId: number;
	category: string;
	/** The store's merchant row number, which the question's address and form carry (#532). */
	store: number;
};

/**
 * Rebuilds Organize's question from the charges it is given, or returns nothing when they no longer hold the category
 * (#353). storeOffer passes the store's charges in the category (#532). Every key and name here comes from the database,
 * so a crafted request can show a question that is true of the data, or none. It returns nothing unless those charges
 * are one store's, so ids from two stores can't name one of them, nothing while one of them looks mixed (decision 113),
 * and nothing once every key already has the rule, so Back after Yes shows no question.
 */
export async function organizeOffer(
	db: D1Database,
	savedIds: number[],
	categoryId: number,
): Promise<Omit<GroupOffer, "store"> | null> {
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

/**
 * Organize's question for a store (#532): the store's charges in `categoryId` that a person chose there, asked through
 * organizeOffer's rules. Save, a reload of the question's address and Yes all rebuild the question here, so they agree.
 * Nothing unless both numbers are safe integers above 0, and nothing when the store has no charges in the category.
 */
export async function storeOffer(
	db: D1Database,
	storeRow: number,
	categoryId: number,
): Promise<GroupOffer | null> {
	if (
		!Number.isSafeInteger(storeRow) ||
		storeRow <= 0 ||
		!Number.isSafeInteger(categoryId) ||
		categoryId <= 0
	)
		return null;
	const ids = await storeChargeIds(db, storeRow, categoryId);

	if (ids.length === 0) return null;
	const offer = await organizeOffer(db, ids, categoryId);

	return offer && { ...offer, store: storeRow };
}
