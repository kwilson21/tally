import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { JEV_THRESHOLD } from "../ai/categorize";
import { householdToday } from "../dates";
import { NameTaken, type StoredCategory } from "../rules/categories";
import {
	type CreateFacts,
	type CreateRequest,
	type CreateWrite,
	createFromSuggestion as createRule,
	type DismissWrite,
	dismissNewCategory,
	type SuggestionState,
} from "../rules/suggestions";
import { tidyName } from "../transactions/tidy-name";
import { LIST, LIST_VERSION } from "./category-saves";
import { Database, runWith } from "./database";
import { isUniqueViolation } from "./errors";
import { ChangedSinceRead, decideAndSave, guardedSave } from "./guarded-save";
import { merchantKeySql } from "./merchant-key";
import { neverSuggestedSql } from "./never-suggest";
import { ownNameSql } from "./own-name";
import { leftEmpty } from "./refused";
import { categorySuggestions } from "./schema";
import type { ListRow } from "./transactions";

export type NoneFitTransaction = {
	id: number;
	theme: string;
	merchantKey: string;
	merchant: string;
};

export async function noneFitTransactions(
	db: D1Database,
): Promise<NoneFitTransaction[]> {
	const theme = `COALESCE(NULLIF(t.plaid_category,''), 'merchant:' || ${merchantKeySql("t")})`;

	// A store with a "Never suggest" line for a new category is never grouped (decision 101).
	const eligible = `t.jev_none_fit = 1 AND t.category_confidence >= ? AND t.jev_category_id IS NULL
		AND t.category_id IS NULL AND t.category_source IS NULL AND t.category_suggestion_id IS NULL
		AND t.amount_cents > 0 AND t.pending = 0 AND t.excluded = 0 AND t.flag_income = 0
		AND t.is_split = 0 AND t.parent_id IS NULL
		AND NOT ${neverSuggestedSql("t", "new_category")}`;

	const { results: groups } = await db
		.prepare(`SELECT COALESCE(NULLIF(t.plaid_category,''), 'merchant:' || ${merchantKeySql("t")}) theme,
			COUNT(*) count FROM transactions t WHERE ${eligible} GROUP BY theme HAVING COUNT(*) >= 3
			ORDER BY count DESC, theme LIMIT 10`)
		.bind(JEV_THRESHOLD)
		.all<{ theme: string; count: number }>();

	if (!groups.length) return [];

	const { results } = await db
		.prepare(`SELECT t.id, ${theme} theme, ${merchantKeySql("t")} merchantKey,
			COALESCE(m.display_name, NULLIF(t.merchant_name,''), t.raw_name) merchant, ${ownNameSql("t")} ownName
		FROM transactions t LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")}
		JOIN json_each(?) selected ON selected.value = ${theme}
		WHERE ${eligible} ORDER BY t.date DESC, t.id DESC LIMIT 500`)
		.bind(JSON.stringify(groups.map((group) => group.theme)), JEV_THRESHOLD)
		.all<NoneFitTransaction & { ownName: string | null }>();

	// A one-off name is the name a person typed, so the model sees it exactly as typed; the rest are tidied.
	return results.map(({ ownName, ...row }) => ({
		...row,
		merchant: ownName ?? tidyName(row.merchant),
	}));
}

const placeholders = () => `SELECT value FROM json_each(?)`;

/** The condition for a suggestion still waiting; every query about a pending one reads it from here. */
const pendingSuggestion = eq(categorySuggestions.status, "pending");

/**
 * The pending suggestion with this name, matched as SQLite's NOCASE does (ASCII case only, the rule of the partial unique
 * index on lower(name)). Drizzle has no collation helper, so the NOCASE stays in the sql template.
 */
function pendingSuggestionIdByName(db: D1Database, name: string) {
	return drizzle(db)
		.select({ id: categorySuggestions.id })
		.from(categorySuggestions)
		.where(
			and(
				sql`${categorySuggestions.name} = ${name} COLLATE NOCASE`,
				pendingSuggestion,
			),
		)
		.get();
}

export async function saveSuggestion(
	db: D1Database,
	name: string | null,
	ids: number[],
	avoid: string[] = [],
): Promise<number | null> {
	if (!ids.length) return null;
	const cleaned = name?.trim() ?? "";
	const currentAvoid = [...new Set([...avoid, ...(await namesToAvoid(db))])];

	const safeName =
		cleaned &&
		!currentAvoid.some((n) => n.toLowerCase() === cleaned.toLowerCase())
			? cleaned
			: "";

	if (safeName) {
		const existing = await pendingSuggestionIdByName(db, safeName);

		if (existing) {
			await db
				.prepare(
					`UPDATE transactions SET category_suggestion_id = ? WHERE id IN (${placeholders()}) AND category_confidence >= ? AND jev_none_fit=1 AND jev_category_id IS NULL AND amount_cents>0 AND pending=0 AND excluded=0 AND flag_income=0 AND is_split=0 AND parent_id IS NULL AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`,
				)
				.bind(existing.id, JSON.stringify(ids), JEV_THRESHOLD)
				.run();

			return existing.id;
		}
	}

	const status = safeName ? "pending" : "none";
	const eligible = `id IN (${placeholders()}) AND category_confidence >= ? AND jev_none_fit=1 AND jev_category_id IS NULL AND amount_cents>0 AND pending=0 AND excluded=0 AND flag_income=0 AND is_split=0 AND parent_id IS NULL AND category_id IS NULL AND category_source IS NULL AND category_suggestion_id IS NULL`;

	try {
		const results = await db.batch<{ id: number }>([
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=NULL WHERE id IN (${placeholders()}) AND category_suggestion_id IN (SELECT id FROM category_suggestions WHERE status='none')`,
				)
				.bind(JSON.stringify(ids)),
			db
				.prepare(
					`INSERT INTO category_suggestions (name,status) SELECT ?,? WHERE (SELECT COUNT(*) FROM transactions WHERE ${eligible}) >= 3 RETURNING id`,
				)
				.bind(safeName, status, JSON.stringify(ids), JEV_THRESHOLD),
			db
				.prepare(
					`UPDATE transactions SET category_suggestion_id=(SELECT id FROM category_suggestions WHERE name=? COLLATE NOCASE AND status=? ORDER BY id DESC LIMIT 1) WHERE ${eligible} AND (SELECT COUNT(*) FROM transactions WHERE ${eligible}) >= 3 AND EXISTS (SELECT 1 FROM category_suggestions WHERE name=? COLLATE NOCASE AND status=?)`,
				)
				.bind(
					safeName,
					status,
					JSON.stringify(ids),
					JEV_THRESHOLD,
					JSON.stringify(ids),
					JEV_THRESHOLD,
					safeName,
					status,
				),
		]);

		const id = results[1]?.results?.[0]?.id;

		if (id) return id;

		return (await pendingSuggestionIdByName(db, safeName))?.id ?? null;
	} catch (error) {
		// A concurrent nightly run may win the partial unique index; attach this group to that row.
		if (!safeName || !isUniqueViolation(error)) throw error;

		const existing = await pendingSuggestionIdByName(db, safeName);

		if (!existing) throw error;
		await db
			.prepare(
				`UPDATE transactions SET category_suggestion_id=? WHERE ${eligible}`,
			)
			.bind(existing.id, JSON.stringify(ids), JEV_THRESHOLD)
			.run();

		return existing.id;
	}
}

export async function namesToAvoid(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT name FROM categories UNION SELECT name FROM category_suggestions WHERE status = 'dismissed'",
		)
		.all<{ name: string }>();

	return results.map((row) => row.name);
}

/**
 * The names a single purchase's naming call must not offer (decision 165): the archived categories, which are names not
 * to create, and the dismissed suggestions. The active categories are not here: the call is given them as choices
 * instead, so it can name one that fits. The nightly naming keeps namesToAvoid.
 */
export async function purchaseNamesToAvoid(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			"SELECT name FROM categories WHERE archived = 1 UNION SELECT name FROM category_suggestions WHERE status = 'dismissed'",
		)
		.all<{ name: string }>();

	return results.map((row) => row.name);
}

export type PendingSuggestion = { id: number; name: string; rows: ListRow[] };

/** The pending suggestions to show, and how many more wait beyond the limit. */
export type PendingSuggestionPage = {
	suggestions: PendingSuggestion[];
	more: number;
};

/** How many suggestions Settings lists; the review screen asks every one, so it passes no limit. */
export const SETTINGS_SUGGESTION_LIMIT = 10;

/**
 * The per-row checks a purchase in a new-category suggestion passes to be filed under it (pendingSuggestions), without the
 * "Never suggest" line. `alias` is the transactions table's name or alias, as for `merchantKeySql`. The rest of the queue
 * reads the same checks through this, so they can't drift apart (#440).
 */
export const suggestedRowSql = (alias: string) =>
	`${alias}.category_id IS NULL AND ${alias}.category_source IS NULL AND ${alias}.pending = 0 AND ${alias}.amount_cents > 0
		AND ${alias}.excluded = 0 AND ${alias}.flag_income = 0 AND ${alias}.is_split = 0 AND ${alias}.parent_id IS NULL`;

/**
 * Narrows pendingSuggestions to the one suggestion Organize's card asks about (decision 120): the pending one that holds a
 * purchase from these merchant keys, or the one with this id. The purchases a suggestion holds are still all of them.
 */
export type SuggestionFilter = { merchantKeys: string[] } | { id: number };

/**
 * The candidate query's clause and its bind for a filter, none when the list is unfiltered. The EXISTS keeps a
 * suggestion's own count (n) over all its eligible purchases, so the order matches the unfiltered list.
 */
function filterClause(only?: SuggestionFilter): [string, unknown[]] {
	if (!only) return ["", []];

	if ("id" in only) return ["AND cs.id = ?", [only.id]];

	return [
		`AND EXISTS (SELECT 1 FROM transactions k WHERE k.category_suggestion_id = cs.id AND ${suggestedRowSql("k")}
			AND NOT ${neverSuggestedSql("k", "new_category")} AND ${merchantKeySql("k")} IN (SELECT value FROM json_each(?)))`,
		[JSON.stringify(only.merchantKeys)],
	];
}

/** The busiest pending suggestions (up to `limit`), for a caller that has no use for the count of those left out. */
export async function pendingSuggestions(
	db: D1Database,
	limit = SETTINGS_SUGGESTION_LIMIT,
	only?: SuggestionFilter,
): Promise<PendingSuggestion[]> {
	return (await pendingSuggestionPage(db, limit, only)).suggestions;
}

export async function pendingSuggestionPage(
	db: D1Database,
	limit = SETTINGS_SUGGESTION_LIMIT,
	only?: SuggestionFilter,
): Promise<PendingSuggestionPage> {
	await db.batch([
		db.prepare(
			`UPDATE transactions SET category_suggestion_id=NULL WHERE category_suggestion_id IN (SELECT cs.id FROM category_suggestions cs WHERE cs.status='pending' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_suggestion_id=cs.id AND ${suggestedRowSql("t")}))`,
		),
		db.prepare(
			`UPDATE category_suggestions SET status='none' WHERE status='pending' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_suggestion_id=category_suggestions.id AND ${suggestedRowSql("t")})`,
		),
	]);
	// Select the busiest eligible pending suggestions (up to `limit`) before loading ids or purchase rows.
	const [onlyClause, onlyBinds] = filterClause(only);

	const { results: suggestions } = await db
		.prepare(
			`WITH candidates AS (
				SELECT cs.id, cs.name, COUNT(t.id) n
				FROM category_suggestions cs JOIN transactions t ON t.category_suggestion_id=cs.id
				AND ${suggestedRowSql("t")}
				AND NOT ${neverSuggestedSql("t", "new_category")}
				WHERE cs.status='pending' ${onlyClause} GROUP BY cs.id HAVING COUNT(t.id)>0
			), ranked AS (SELECT *, COUNT(*) OVER() total, ROW_NUMBER() OVER(ORDER BY n DESC,id) rank FROM candidates)
			SELECT id,name,n,total FROM ranked WHERE rank<=? ORDER BY rank`,
		)
		.bind(...onlyBinds, limit)
		.all<{ id: number; name: string; n: number; total: number }>();

	if (!suggestions.length) return { suggestions: [], more: 0 };

	const { results } = await db
		.prepare(`WITH pending AS (
			SELECT value AS id FROM json_each(?)
		), candidates AS (
			SELECT cs.id, cs.name, COUNT(t.id) AS n
			FROM pending p JOIN category_suggestions cs ON cs.id = p.id AND cs.status = 'pending'
			JOIN transactions t ON t.category_suggestion_id = cs.id AND ${suggestedRowSql("t")}
				AND NOT ${neverSuggestedSql("t", "new_category")}
			GROUP BY cs.id HAVING COUNT(t.id) > 0
		), ranked AS (
			SELECT *, COUNT(*) OVER() AS total, ROW_NUMBER() OVER(ORDER BY n DESC, id) AS rank FROM candidates
		)
		SELECT r.id, r.name, r.n, r.total, t.id AS transactionId, t.date, t.amount_cents amountCents, t.raw_name rawName,
			COALESCE(m.display_name, t.merchant_name, t.raw_name) displayName, t.note, t.excluded, t.flag_income income,
			t.category_id categoryId, c.name categoryName, c.icon categoryIcon, c.color categoryColor, t.pending, ${ownNameSql("t")} AS ownName
		FROM ranked r JOIN transactions t ON t.category_suggestion_id = r.id
		LEFT JOIN merchants m ON m.raw_name = ${merchantKeySql("t")} LEFT JOIN categories c ON c.id = t.category_id
		WHERE r.rank <= ? AND ${suggestedRowSql("t")}
			AND NOT ${neverSuggestedSql("t", "new_category")}
		ORDER BY r.rank, t.date DESC, t.id DESC`)
		.bind(JSON.stringify(suggestions.map((s) => s.id)), limit)
		.all<
			Omit<ListRow, "pending" | "id"> & {
				id: number;
				name: string;
				transactionId: number;
				pending: number;
				n: number;
				total: number;
				ownName: string | null;
			}
		>();

	const byId = new Map<number, PendingSuggestion>();

	for (const row of results) {
		let suggestion = byId.get(row.id);

		if (!suggestion) {
			suggestion = { id: row.id, name: row.name, rows: [] };
			byId.set(row.id, suggestion);
		}

		const { transactionId, n: _n, total: _total, ownName, ...tx } = row;
		suggestion.rows.push({
			...tx,
			id: transactionId,
			// A name given to this row alone is shown exactly as typed; only the store's or bank's text is tidied.
			displayName:
				ownName ??
				(tx.displayName === tx.displayName.toUpperCase()
					? tidyName(tx.displayName)
					: tx.displayName),
			excluded: !!tx.excluded,
			income: !!tx.income,
			pending: !!tx.pending,
		});
	}

	return {
		suggestions: [...byId.values()],
		more: Math.max(0, (suggestions[0]?.total ?? 0) - byId.size),
	};
}

export type CreateResult =
	/**
	 * `attached` is true when a category the family already had as active with that name took the ticks (decision
	 * 101). `restored` is true when an archived one with that name came back to take them (decision 110).
	 */
	| {
			ok: true;
			name: string;
			moved: number;
			/** The ids the write filed, lowest first (a re-sort starts from the first, #821). */
			filed: number[];
			leftOut: number[];
			attached: boolean;
			restored: boolean;
	  }
	// "empty": no ticked purchase could be filed; Organize, which ticks them all, reads it as changed elsewhere.
	| { ok: false; reason: "gone" | "empty" | "invalid"; error?: string };

/**
 * The shown purchases (?2, a JSON list) the suggestion ?1 still holds: each still waits for a category
 * (suggestedRowSql) and no Never suggest line hides it. Lowest id first.
 */
const STILL_SUGGESTED = `SELECT t.id FROM transactions t WHERE t.category_suggestion_id = ?1 AND ${suggestedRowSql("t")}
	AND NOT ${neverSuggestedSql("t", "new_category")} AND t.id IN (SELECT value FROM json_each(?2)) ORDER BY t.id`;

/** Everything the Yes's rule reads as one text, as SQL: the suggestion's status, the whole category list, and the shown purchases it still holds. */
const CREATE_VERSION = `(COALESCE((SELECT status FROM category_suggestions WHERE id = ?1), 'none') || '/' || ${LIST_VERSION}
	|| '/' || COALESCE((SELECT group_concat(id, '|') FROM (${STILL_SUGGESTED})), ''))`;

const shownJson = (shown: number[]) =>
	JSON.stringify([...new Set(shown)].sort((x, y) => x - y));

/** What the Yes's rule reads, with its version, in one batch. */
export async function createFacts(
	db: D1Database,
	id: number,
	shown: number[],
): Promise<CreateFacts> {
	// SAFETY: the batch below lists exactly four statements, so its results are the four D1Results typed here. A batch
	// is one transaction, so the version is of the very rows read beside it.
	const [suggestion, list, suggested, version] = (await db.batch([
		db
			.prepare("SELECT status, name FROM category_suggestions WHERE id = ?1")
			.bind(id),
		db.prepare(LIST),
		db.prepare(STILL_SUGGESTED).bind(id, shownJson(shown)),
		db
			.prepare(`SELECT ${CREATE_VERSION} AS version`)
			.bind(id, shownJson(shown)),
	])) as [
		D1Result<{ status: string; name: string }>,
		D1Result<Omit<StoredCategory, "archived"> & { archived: number }>,
		D1Result<{ id: number }>,
		D1Result<{ version: string }>,
	];

	return {
		suggestion: {
			status: suggestion.results[0]?.status ?? null,
			name: suggestion.results[0]?.name ?? "",
		},
		categories: list.results.map((c) => ({ ...c, archived: c.archived === 1 })),
		suggested: suggested.results.map((row) => row.id),
		version: version.results[0]?.version ?? "",
	};
}

/** What makes the category, or brings it back with its archive period closed (as setArchived's restore does); an Add to changes none. */
const categoryStatements = (
	db: D1Database,
	category: CreateWrite["category"],
) =>
	category.kind === "create"
		? [
				db
					.prepare(
						"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES (?, ?, 'tag', ?, ?)",
					)
					.bind(
						category.name,
						category.nameKey,
						category.color,
						category.sortOrder,
					),
			]
		: category.kind === "restore"
			? [
					db
						.prepare(
							"UPDATE categories SET archived = 0, archived_on = NULL, sort_order = ? WHERE id = ?",
						)
						.bind(category.sortOrder, category.id),
					db
						.prepare(
							"UPDATE category_archive_periods SET restored_on = ? WHERE category_id = ? AND restored_on IS NULL",
						)
						.bind(category.on, category.id),
				]
			: [];

/**
 * The Yes's save, one batch. First the guard: it adds nothing while the suggestion, the category list and the shown
 * purchases are still as the rule read them, and tries to add a category with no name when they are not, which fails
 * the batch (the name is NOT NULL; SQLite's RAISE works only inside a trigger). Then the category, the suggestion's
 * move, the ticked purchases and the notes, each list as one JSON value. The last two statements release the
 * suggestion's other purchases, whatever their number (decision 209): the ones still waiting are cleared for the
 * night's sorting to ask about again, and none keeps the suggestion's number.
 */
export const createStatements = (
	db: D1Database,
	save: CreateWrite,
	shown: number[],
) => [
	db
		.prepare(
			`INSERT INTO categories (name, icon, color) SELECT NULL, 'tag', 'cat-blue' WHERE ${CREATE_VERSION} IS NOT ?3`,
		)
		.bind(save.suggestionId, shownJson(shown), save.expectedVersion),
	...categoryStatements(db, save.category),
	db
		.prepare(
			"UPDATE category_suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?",
		)
		.bind(save.status, save.suggestionId),
	db
		.prepare(
			`UPDATE transactions SET category_id = COALESCE(?1, (SELECT id FROM categories WHERE name_key = ?2 AND archived = 0)),
				category_source = 'user', category_confidence = NULL, jev_none_fit = 0, category_suggestion_id = NULL,
				split_removed_from_cents = NULL, split_removed_bills = NULL, updated_by = ?3, updated_at = datetime('now')
			WHERE id IN (SELECT value FROM json_each(?4))`,
		)
		.bind(
			save.category.kind === "create" ? null : save.category.id,
			save.category.kind === "create" ? save.category.nameKey : null,
			save.who,
			JSON.stringify(save.file),
		),
	db
		.prepare(
			`UPDATE transactions SET note = json_extract(note.value, '$.note'), note_guessed = 0, note_state = 'written',
				updated_by = ?1, updated_at = datetime('now')
			FROM json_each(?2) AS note WHERE transactions.id = json_extract(note.value, '$.id')`,
		)
		.bind(save.who, JSON.stringify(save.notes)),
	db
		.prepare(
			`UPDATE transactions SET category_suggestion_id = NULL, category_confidence = NULL, jev_none_fit = 0
			WHERE category_suggestion_id = ? AND ${suggestedRowSql("transactions")}`,
		)
		.bind(save.suggestionId),
	db
		.prepare(
			"UPDATE transactions SET category_suggestion_id = NULL WHERE category_suggestion_id = ?",
		)
		.bind(save.suggestionId),
];

/** Whether a Yes's save failed because its guard raised. Only the guard can try to add a category with no name. */
const createGuardRaised = leftEmpty("categories", "name");

/**
 * Reads the Yes's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when the
 * guard raises (decideAndSave). The unique indexes on a category's name stay as the backstop: a name they refuse that
 * the rule's own comparison let through is answered as taken. Answers with what the rule saved.
 */
export const decideCreate = <E>(
	createRule: {
		decide: (
			request: CreateRequest,
			facts: CreateFacts,
		) => Effect.Effect<Option.Option<CreateWrite>, E>;
	},
	request: CreateRequest,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const { decided } = yield* decideAndSave({
			facts: Effect.promise(() =>
				createFacts(db, request.suggestionId, request.shown),
			),
			decide: (facts) => createRule.decide(request, facts),
			save: (write) =>
				guardedSave(
					() => db.batch(createStatements(db, write, request.shown)),
					createGuardRaised,
					() => new NameTaken(),
				),
			gaveUp: "A suggestion kept changing while its Yes was being saved.",
		});

		// The rule's Yes always has something to save, so a write is always here.
		return Option.getOrThrow(decided);
	});

/**
 * The Yes on a suggested new category, as the rule decides it, in the words its callers read: what was filed and
 * where, or why nothing was ("gone" when the suggestion was answered elsewhere, "empty" when no ticked purchase could
 * be filed, "invalid" with the sentence for every other refusal).
 */
export const createFromSuggestion = async (
	db: D1Database,
	id: number,
	input: {
		ticked: number[];
		shown: number[];
		notes: Record<number, string>;
		/** Organize's Create (#705): every shown purchase is filed or none is, so a change since the card was drawn stops all. */
		whole?: boolean;
	},
	actor: string,
): Promise<CreateResult> =>
	runWith(
		db,
		decideCreate(createRule, {
			suggestionId: id,
			...input,
			whole: input.whole ?? false,
			today: await householdToday(db),
			who: actor,
		}).pipe(
			Effect.map(
				(saved): CreateResult => ({
					ok: true,
					name: saved.category.name,
					moved: saved.file.length,
					filed: saved.file,
					leftOut: saved.leftOut,
					attached: saved.category.kind === "attach",
					restored: saved.category.kind === "restore",
				}),
			),
			Effect.catchTags({
				SuggestionChanged: (): Effect.Effect<CreateResult> =>
					Effect.succeed({ ok: false, reason: "gone" }),
				NothingTicked: (refusal): Effect.Effect<CreateResult> =>
					Effect.succeed({ ok: false, reason: "empty", error: refusal.say }),
			}),
			Effect.catch(
				(refusal): Effect.Effect<CreateResult> =>
					Effect.succeed({ ok: false, reason: "invalid", error: refusal.say }),
			),
		),
	);

/** What the No's rule reads: the suggestion's status and name. */
export async function suggestionState(
	db: D1Database,
	id: number,
): Promise<SuggestionState> {
	const row = await drizzle(db)
		.select({
			status: categorySuggestions.status,
			name: categorySuggestions.name,
		})
		.from(categorySuggestions)
		.where(eq(categorySuggestions.id, id))
		.get();

	return { status: row?.status ?? null, name: row?.name ?? "" };
}

/**
 * Reads the suggestion's state, asks the rule and saves the move it decides. The save is one statement that lands only
 * while the suggestion still has the status the rule read (its guard, decision 190); when it does not, the rule is
 * asked again on the fresh state (decideAndSave), which then refuses. Answers with the suggestion's name.
 */
export const decideDismiss = <E>(
	dismissRule: {
		decide: (
			request: { suggestionId: number },
			facts: SuggestionState,
		) => Effect.Effect<Option.Option<DismissWrite>, E>;
	},
	request: { suggestionId: number },
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const { facts } = yield* decideAndSave({
			facts: Effect.promise(() => suggestionState(db, request.suggestionId)),
			decide: (facts) => dismissRule.decide(request, facts),
			save: (write) =>
				Effect.promise(() =>
					db
						.prepare(
							"UPDATE category_suggestions SET status = ?1, decided_at = datetime('now') WHERE id = ?2 AND status = ?3",
						)
						.bind(write.status, write.suggestionId, write.expectedStatus)
						.run(),
				).pipe(
					Effect.filterOrFail(
						(result) => result.meta.changes > 0,
						() => new ChangedSinceRead(),
					),
				),
			gaveUp: "A suggestion kept changing while its No was being saved.",
		});

		return { name: facts.name };
	});

/** The No on a suggested new category, as the rule decides it: the suggestion's name, or null when the rule refuses. */
export const dismissSuggestion = (
	db: D1Database,
	id: number,
): Promise<{ name: string } | null> =>
	runWith(
		db,
		decideDismiss(dismissNewCategory, { suggestionId: id }).pipe(
			Effect.catchTag("SuggestionChanged", () => Effect.succeed(null)),
		),
	);
