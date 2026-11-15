// Renames and moves a category through the save the settings screen runs (the live path), with the household's list read
// just before, as the screen does. Tests use these instead of the old one-line database helpers.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
	decideCategory,
	moveCategoryStatements,
	renameCategoryStatements,
	saveNamedCategory,
} from "../src/db/category-saves";
import { Database } from "../src/db/database";
import { type CategoryFacts, moveCategory } from "../src/rules/categories";
import { nameKey } from "../src/settings/category-form";

/**
 * True when the save landed. A name taken (ignoring case and accents) or a list changed under the read is false here;
 * anything else still fails the test.
 */
const landed = (
	db: D1Database,
	program: Effect.Effect<boolean, { _tag: string }, Database>,
) =>
	Effect.runPromise(
		program.pipe(
			Effect.catchTags({
				NameTaken: () => Effect.succeed(false),
				CategoryChanged: () => Effect.succeed(false),
			}),
			Effect.provideService(Database, db),
		),
	);

/**
 * Renames the category to `name`, through the guard and the unique name check every rename's save runs. No rule is asked:
 * the rename rule refuses an archived category, and the tests that use this rename one on purpose, as another screen did.
 * False when the name is taken or the list changed and could not be read again.
 */
export const renameOn = (db: D1Database, id: number, name: string) =>
	landed(
		db,
		decideCategory(
			{
				decide: (request: { id: number; name: string }, facts: CategoryFacts) =>
					Effect.succeed(
						Option.some({
							id: request.id,
							name: request.name,
							nameKey: nameKey(request.name),
							expectedVersion: facts.version,
						}),
					),
			},
			{ id, name },
			renameCategoryStatements,
			saveNamedCategory,
		).pipe(Effect.as(true)),
	);

/**
 * Moves an active category one place up or down, through the move rule and its save. False when it is already at that
 * end, is not in the active list, or the list changed under the read.
 */
export const moveOn = (db: D1Database, id: number, direction: "up" | "down") =>
	landed(
		db,
		decideCategory(
			moveCategory,
			{ id, direction },
			moveCategoryStatements,
		).pipe(
			Effect.map(
				(answer) => "decided" in answer && Option.isSome(answer.decided),
			),
		),
	);
