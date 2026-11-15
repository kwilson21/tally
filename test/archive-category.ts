// Archives or restores a category the way the settings screen does: through its rule and its save (the live path),
// with the household's date passed in. Tests use these instead of writing the category's rows by hand.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
	archiveCategoryStatements,
	decideCategory,
	restoreCategoryStatements,
} from "../src/db/category-saves";
import { Database } from "../src/db/database";
import { archiveCategory, restoreCategory } from "../src/rules/categories";

/**
 * True when the rule decided on a change and its save landed. A refusal the old helper answered with false (a full list,
 * a category that is not there) is false here too; anything else still fails the test.
 */
const landed = (
	db: D1Database,
	program: Effect.Effect<boolean, { _tag: string }, Database>,
) =>
	Effect.runPromise(
		program.pipe(
			Effect.catchTags({
				ListFull: () => Effect.succeed(false),
				CategoryChanged: () => Effect.succeed(false),
			}),
			Effect.provideService(Database, db),
		),
	);

/** Archives the category from `on`, opening its archive period. False when it was already archived. */
export const archiveOn = (db: D1Database, id: number, on: string) =>
	landed(
		db,
		decideCategory(
			archiveCategory,
			{ id, today: on },
			archiveCategoryStatements,
		).pipe(
			Effect.map(
				(answer) => "decided" in answer && Option.isSome(answer.decided),
			),
		),
	);

/**
 * Restores the category to the end of the active list from `on`, closing its archive period. False when the list is
 * full or the category was already active.
 */
export const restoreOn = (db: D1Database, id: number, on: string) =>
	landed(
		db,
		decideCategory(
			restoreCategory,
			{ id, today: on },
			restoreCategoryStatements,
		).pipe(
			Effect.map(
				(answer) => "decided" in answer && Option.isSome(answer.decided),
			),
		),
	);
