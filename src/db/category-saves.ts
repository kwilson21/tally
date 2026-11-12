// How the categories area's rules (src/rules/categories.ts) read their facts and save what they decide (decision 190).
// The rule decides in TypeScript; the database only checks that the list the rule read has not changed since, and
// raises an error when it has, so nothing is saved on a stale list.
import type {
	AddCategoryWrite,
	ArchiveCategoryWrite,
	CategoryFacts,
	MoveCategoryWrite,
	RenameCategoryWrite,
	RestoreCategoryWrite,
	StoredCategory,
} from "../rules/categories";
import type { Outcome } from "../rules/rule";
import { decideAndSaveWith } from "./guarded-save";

/**
 * The whole list as one text, as SQL: every category's id, whether it is archived, its place and its name. Two reads
 * give the same text only while nothing the rules look at has changed. The name is in hex, so no name can look like
 * the marks between the parts.
 */
const LIST_VERSION = `(SELECT COALESCE(group_concat(id || ':' || archived || ':' || sort_order || ':' || hex(name), '|'), '')
	FROM (SELECT id, archived, sort_order, name FROM categories ORDER BY id))`;

/** What the category rules read: every category, active ones first in the order the list shows, and the list's version. */
export async function categoryFacts(db: D1Database): Promise<CategoryFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch
	// is one transaction, so the version is of the very list read beside it.
	const [list, version] = (await db.batch([
		db.prepare(
			"SELECT id, name, archived, sort_order AS sortOrder FROM categories ORDER BY archived, sort_order, name, id",
		),
		db.prepare(`SELECT ${LIST_VERSION} AS version`),
	])) as [
		D1Result<Omit<StoredCategory, "archived"> & { archived: number }>,
		D1Result<{ version: string }>,
	];

	return {
		categories: list.results.map((c) => ({ ...c, archived: c.archived === 1 })),
		version: version.results[0]?.version ?? "",
	};
}

/**
 * The guard, first in every save's batch: it adds nothing while the list is still the one the rule read, and tries to
 * add a category with no name when it is not. The name is NOT NULL, so that fails the statement and the whole batch
 * with an error changedSinceRead knows. SQLite's RAISE works only inside a trigger, so this is how a batch raises.
 */
const listUnchanged = (db: D1Database, expectedVersion: string) =>
	db
		.prepare(
			`INSERT INTO categories (name, icon, color) SELECT NULL, 'tag', 'cat-blue' WHERE ${LIST_VERSION} IS NOT ?1`,
		)
		.bind(expectedVersion);

/** Adds the category; the new row's id is the second statement's last_row_id. */
export const addCategoryStatements = (
	db: D1Database,
	save: AddCategoryWrite,
) => [
	listUnchanged(db, save.expectedVersion),
	db
		.prepare(
			"INSERT INTO categories (name, name_key, icon, color, sort_order) VALUES (?, ?, 'tag', ?, ?)",
		)
		.bind(save.name, save.nameKey, save.color, save.sortOrder),
];

export const renameCategoryStatements = (
	db: D1Database,
	save: RenameCategoryWrite,
) => [
	listUnchanged(db, save.expectedVersion),
	db
		.prepare("UPDATE categories SET name = ?, name_key = ? WHERE id = ?")
		.bind(save.name, save.nameKey, save.id),
];

/** Archives the category and opens its archive period (spec §5) on the same date, unless one is already open. */
export const archiveCategoryStatements = (
	db: D1Database,
	save: ArchiveCategoryWrite,
) => [
	listUnchanged(db, save.expectedVersion),
	db
		.prepare("UPDATE categories SET archived = 1, archived_on = ? WHERE id = ?")
		.bind(save.on, save.id),
	db
		.prepare(
			`INSERT INTO category_archive_periods (category_id, archived_on)
			SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM category_archive_periods WHERE category_id = ?1 AND restored_on IS NULL)`,
		)
		.bind(save.id, save.on),
];

/** Restores the category to its new place and closes its open archive period on the same date. */
export const restoreCategoryStatements = (
	db: D1Database,
	save: RestoreCategoryWrite,
) => [
	listUnchanged(db, save.expectedVersion),
	db
		.prepare(
			"UPDATE categories SET archived = 0, archived_on = NULL, sort_order = ? WHERE id = ?",
		)
		.bind(save.sortOrder, save.id),
	db
		.prepare(
			"UPDATE category_archive_periods SET restored_on = ? WHERE category_id = ? AND restored_on IS NULL",
		)
		.bind(save.on, save.id),
];

/** Numbers the active list 1, 2, 3… in the new order. */
export const moveCategoryStatements = (
	db: D1Database,
	save: MoveCategoryWrite,
) => [
	listUnchanged(db, save.expectedVersion),
	...save.order.map((id, i) =>
		db
			.prepare("UPDATE categories SET sort_order = ? WHERE id = ?")
			.bind(i + 1, id),
	),
];

/** The text of the guard's failure, as D1 passes SQLite's message on. Only the guard can try to add a NULL name. */
const GUARD_RAISED = /NOT NULL constraint failed: categories\.name/;

/** Whether a save failed because the list the rule read had changed, and not for any other reason. */
export function categoriesChangedSinceRead(error: Error): boolean {
	return GUARD_RAISED.test(error.message);
}

/**
 * Reads the list, asks a category rule and saves what it decides in one batch, asking again on a fresh list when the
 * guard raises (decideAndSaveWith). Answers with the outcome, the list it was decided on, and the batch's results for
 * a write.
 */
export async function decideCategory<Request, W>(
	db: D1Database,
	rule: { decide: (request: Request, facts: CategoryFacts) => Outcome<W> },
	request: Request,
	statements: (db: D1Database, save: W) => D1PreparedStatement[],
): Promise<{
	outcome: Outcome<W>;
	facts: CategoryFacts;
	saved?: D1Result[];
}> {
	let facts: CategoryFacts = { categories: [], version: "" };

	const answer = await decideAndSaveWith({
		decide: async () => {
			facts = await categoryFacts(db);

			return rule.decide(request, facts);
		},
		save: (what: W) => db.batch(statements(db, what)),
		changedSinceRead: categoriesChangedSinceRead,
		gaveUp: "The categories kept changing while one was being saved.",
	});

	return { ...answer, facts };
}
