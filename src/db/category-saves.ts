import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import {
	type AddCategoryWrite,
	type ArchiveCategoryWrite,
	type CategoryFacts,
	type MoveCategoryWrite,
	NameTaken,
	type RenameCategoryWrite,
	type RestoreCategoryWrite,
	type StoredCategory,
} from "../rules/categories";
import type { Refusal } from "../rules/terms";
import { Database } from "./database";
import { isUniqueViolation } from "./errors";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";
import { leftEmpty } from "./refused";

/**
 * The whole list as one text, as SQL: every category's id, whether it is archived, its place and its name. Two reads
 * give the same text only while nothing the rules look at has changed. The name is in hex, so no name can look like
 * the marks between the parts.
 */
export const LIST_VERSION = `(SELECT COALESCE(group_concat(id || ':' || archived || ':' || sort_order || ':' || hex(name), '|'), '')
	FROM (SELECT id, archived, sort_order, name FROM categories ORDER BY id))`;

/** Every category, active ones first in the order the list shows, as SQL. */
export const LIST =
	"SELECT id, name, archived, sort_order AS sortOrder FROM categories ORDER BY archived, sort_order, name, id";

/** What the category rules read: every category, active ones first in the order the list shows, and the list's version. */
export const categoryFacts = Effect.gen(function* () {
	const db = yield* Database;

	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch
	// is one transaction, so the version is of the very list read beside it.
	const [list, version] = (yield* Effect.promise(() =>
		db.batch([
			db.prepare(LIST),
			db.prepare(`SELECT ${LIST_VERSION} AS version`),
		]),
	)) as [
		D1Result<Omit<StoredCategory, "archived"> & { archived: number }>,
		D1Result<{ version: string }>,
	];

	const facts: CategoryFacts = {
		categories: list.results.map((c) => ({ ...c, archived: c.archived === 1 })),
		version: version.results[0]?.version ?? "",
	};

	return facts;
});

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

/** Whether a save failed because its guard raised. Only the guard can try to add a NULL name. */
const guardRaised = leftEmpty("categories", "name");

/** Runs a save's batch, and says what its failure was. `whenNameTaken` makes the refusal for a save that sets a name. */
const runBatch = <E = never>(
	statements: D1PreparedStatement[],
	whenNameTaken?: () => E,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* Effect.tryPromise({
			try: () => db.batch(statements),
			catch: (cause) => cause,
		}).pipe(
			Effect.catch((cause): Effect.Effect<never, ChangedSinceRead | E> => {
				if (cause instanceof Error && guardRaised(cause))
					return Effect.fail(new ChangedSinceRead());

				// Anything else is a defect: it is not caught, and the request fails as it would have.
				return whenNameTaken && isUniqueViolation(cause)
					? Effect.fail(whenNameTaken())
					: Effect.die(cause);
			}),
		);
	});

/** Runs a save's batch. The guard's failure becomes ChangedSinceRead; anything else is a defect. */
export const saveCategories = (statements: D1PreparedStatement[]) =>
	runBatch(statements);

/**
 * Runs a batch that sets a name (an add or a rename). The unique name indexes settle two saves at once (migrations 0005
 * and 0052), and their failure becomes the NameTaken refusal.
 */
export const saveNamedCategory = (statements: D1PreparedStatement[]) =>
	runBatch(statements, () => new NameTaken());

/**
 * Reads the list, asks a category rule and saves what it decides in one batch, asking again on the fresh list when the
 * guard raises (decideAndSave).
 * Answers with the list it decided on, what the rule decided (nothing, when what was asked is already true), and the
 * batch's results for a save. `save` is saveNamedCategory for a rule that sets a name.
 */
export const decideCategory = <Request, W, E extends Refusal, E2 = never>(
	rule: {
		decide: (
			request: Request,
			facts: CategoryFacts,
		) => Effect.Effect<Option.Option<W>, E>;
	},
	request: Request,
	statements: (db: D1Database, save: W) => D1PreparedStatement[],
	save: (
		statements: D1PreparedStatement[],
	) => Effect.Effect<
		D1Result[],
		ChangedSinceRead | E2,
		Database
	> = saveCategories,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: categoryFacts,
			decide: (facts) => rule.decide(request, facts),
			save: (write) => save(statements(db, write)),
			gaveUp: "The categories kept changing while one was being saved.",
		});
	});
