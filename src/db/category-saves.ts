// How the categories area's rules (src/rules/categories.ts) read their facts and save what they decide (decision 190).
// The rule decides in TypeScript; the database only checks that the list the rule read has not changed since, and
// raises an error when it has, so nothing is saved on a stale list.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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

/**
 * The whole list as one text, as SQL: every category's id, whether it is archived, its place and its name. Two reads
 * give the same text only while nothing the rules look at has changed. The name is in hex, so no name can look like
 * the marks between the parts.
 */
const LIST_VERSION = `(SELECT COALESCE(group_concat(id || ':' || archived || ':' || sort_order || ':' || hex(name), '|'), '')
	FROM (SELECT id, archived, sort_order, name FROM categories ORDER BY id))`;

/** What the category rules read: every category, active ones first in the order the list shows, and the list's version. */
export const categoryFacts = Effect.gen(function* () {
	const db = yield* Database;

	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here. A batch
	// is one transaction, so the version is of the very list read beside it.
	const [list, version] = (yield* Effect.promise(() =>
		db.batch([
			db.prepare(
				"SELECT id, name, archived, sort_order AS sortOrder FROM categories ORDER BY archived, sort_order, name, id",
			),
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

/** The save found the list changed since the rule read it. Never shown to a person: the rule is asked again. */
export class ListChangedSinceRead extends Data.TaggedError(
	"ListChangedSinceRead",
) {}

/** The text of the guard's failure, as D1 passes SQLite's message on. Only the guard can try to add a NULL name. */
const GUARD_RAISED = /NOT NULL constraint failed: categories\.name/;

/** Runs a save's batch, and says what its failure was: `refusalFor` names the failures a person can be told about. */
const runBatch = <E>(
	statements: D1PreparedStatement[],
	refusalFor: (message: string) => E | undefined,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* Effect.tryPromise({
			try: () => db.batch(statements),
			catch: (cause) => cause,
		}).pipe(
			Effect.catch((cause): Effect.Effect<never, ListChangedSinceRead | E> => {
				const message = cause instanceof Error ? cause.message : "";

				if (GUARD_RAISED.test(message))
					return Effect.fail(new ListChangedSinceRead());
				const refusal = refusalFor(message);

				// Anything else is a defect: it is not caught, and the request fails as it would have.
				return refusal === undefined ? Effect.die(cause) : Effect.fail(refusal);
			}),
		);
	});

/** Runs a save's batch. The guard's failure becomes ListChangedSinceRead; anything else is a defect. */
export const saveCategories = (statements: D1PreparedStatement[]) =>
	runBatch<never>(statements, () => undefined);

/**
 * Runs a batch that sets a name (an add or a rename). The unique name indexes settle two saves at once (migrations 0005
 * and 0052), and their failure becomes the NameTaken refusal.
 */
export const saveNamedCategory = (statements: D1PreparedStatement[]) =>
	runBatch(statements, (message) =>
		/UNIQUE/.test(message) ? new NameTaken() : undefined,
	);

/**
 * Reads the list, asks a category rule and saves what it decides in one batch. When the guard raises, it reads and
 * decides again on the fresh list, three times in all, so two saves at once both count; it then gives up with an error.
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
		ListChangedSinceRead | E2,
		Database
	> = saveCategories,
) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const facts = yield* categoryFacts;
		const decided = yield* rule.decide(request, facts);

		const saved = Option.isSome(decided)
			? yield* save(statements(db, decided.value))
			: undefined;

		return { facts, decided, saved };
	}).pipe(
		Effect.retry({
			times: 2,
			while: Predicate.isTagged("ListChangedSinceRead"),
		}),
		Effect.catchTag("ListChangedSinceRead", () =>
			Effect.die(
				new Error("The categories kept changing while one was being saved."),
			),
		),
	);
