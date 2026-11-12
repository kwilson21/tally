import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addCategoryStatements,
	archiveCategoryStatements,
	decideCategory as decideCategoryIn,
	moveCategoryStatements,
	categoryFacts as readCategoryFacts,
	renameCategoryStatements,
	restoreCategoryStatements,
	saveCategories,
	saveNamedCategory,
} from "../src/db/category-saves";
import { Database } from "../src/db/database";
import { resetDemo } from "../src/demo/reset";
import {
	addCategory,
	archiveCategory,
	moveCategory,
	renameCategory,
	restoreCategory,
} from "../src/rules/categories";
import type { Refusal } from "../src/rules/terms";

// The categories area's guard (decision 190): a save lands only while the list the rule read is still the list, and a
// miss raises an error the save loop recognises, so nothing is saved on a stale list and the rule is asked again.

const db = env.DB;

/** Runs a program of the categories area against the test database. */
const run = <A, E>(program: Effect.Effect<A, E, Database>) =>
	Effect.runPromise(program.pipe(Effect.provideService(Database, db)));

const categoryFacts = (_db: D1Database) => run(readCategoryFacts);

const decideCategory = <Request, W, E extends Refusal>(
	rule: Parameters<typeof decideCategoryIn<Request, W, E>>[0],
	request: Request,
	statements: (db: D1Database, save: W) => D1PreparedStatement[],
) =>
	run(
		decideCategoryIn(rule, request, statements).pipe(
			Effect.match({
				onFailure: (refusal) => ({ refused: refusal._tag }),
				onSuccess: (answer) => answer,
			}),
		),
	);

/** How a save's batch ended: saved, the guard raised (the list changed), the name was taken, or it failed some other way. */
const ending = (statements: D1PreparedStatement[]) =>
	run(
		saveNamedCategory(statements).pipe(
			Effect.match({
				onFailure: (failure) => failure._tag,
				onSuccess: () => "saved",
			}),
		),
	);

const TODAY = "2026-09-22";

const rows = async () =>
	(
		await db
			.prepare(
				"SELECT id, name, name_key AS nameKey, archived, archived_on AS archivedOn, sort_order AS sortOrder, icon, color FROM categories ORDER BY archived, sort_order, name, id",
			)
			.all<{
				id: number;
				name: string;
				nameKey: string;
				archived: number;
				archivedOn: string | null;
				sortOrder: number;
				icon: string;
				color: string;
			}>()
	).results;

const periods = async (id: number) =>
	(
		await db
			.prepare(
				"SELECT archived_on AS archivedOn, restored_on AS restoredOn FROM category_archive_periods WHERE category_id = ? ORDER BY archived_on",
			)
			.bind(id)
			.all<{ archivedOn: string; restoredOn: string | null }>()
	).results;

const activeNames = async () =>
	(await rows()).filter((c) => !c.archived).map((c) => c.name);

/** Another screen's change, between a rule's read and its save. */
const someoneElseRenames = () =>
	db.prepare("UPDATE categories SET name = 'Fuel' WHERE name = 'Gas'").run();

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("the list the rules read", () => {
	it("lists active categories in the list's order, then archived ones, with one version for the lot", async () => {
		await db.batch(
			archiveCategoryStatements(db, {
				id: 1,
				on: TODAY,
				expectedVersion: (await categoryFacts(db)).version,
			}),
		);
		const facts = await categoryFacts(db);

		expect(facts.categories.map((c) => c.name).slice(0, 2)).toEqual([
			"Eating Out",
			"Gas",
		]);
		expect(facts.categories.at(-1)).toMatchObject({
			name: "Groceries",
			archived: true,
		});
		expect(facts.version).toBe((await categoryFacts(db)).version);
	});

	it.each([
		["a rename", "UPDATE categories SET name = 'Fuel' WHERE id = 3"],
		["an archive", "UPDATE categories SET archived = 1 WHERE id = 3"],
		["a move", "UPDATE categories SET sort_order = 99 WHERE id = 3"],
		[
			"a new category",
			"INSERT INTO categories (name, icon, color) VALUES ('Travel', 'tag', 'cat-blue')",
		],
	])("has a new version after %s", async (_what, sql) => {
		const before = (await categoryFacts(db)).version;

		await db.prepare(sql).run();
		expect((await categoryFacts(db)).version).not.toBe(before);
	});
});

describe("a save on the list the rule read", () => {
	it("adds a category with its key, colour and place", async () => {
		const { version } = await categoryFacts(db);

		const results = await db.batch(
			addCategoryStatements(db, {
				name: "Travel",
				nameKey: "travel",
				color: "cat-slate",
				sortOrder: 8,
				expectedVersion: version,
			}),
		);

		const added = (await rows()).find((c) => c.name === "Travel");

		expect(added).toMatchObject({
			nameKey: "travel",
			icon: "tag",
			color: "cat-slate",
			sortOrder: 8,
			archived: 0,
		});
		expect(Number(results[1]?.meta.last_row_id)).toBe(added?.id);
	});

	it("renames a category", async () => {
		const { version } = await categoryFacts(db);

		await db.batch(
			renameCategoryStatements(db, {
				id: 1,
				name: "Food at home",
				nameKey: "food at home",
				expectedVersion: version,
			}),
		);
		expect((await rows()).find((c) => c.id === 1)).toMatchObject({
			name: "Food at home",
			nameKey: "food at home",
		});
	});

	it("archives a category and opens its period, then restores it and closes the period", async () => {
		await db.batch(
			archiveCategoryStatements(db, {
				id: 2,
				on: "2026-09-15",
				expectedVersion: (await categoryFacts(db)).version,
			}),
		);
		expect((await rows()).find((c) => c.id === 2)).toMatchObject({
			archived: 1,
			archivedOn: "2026-09-15",
		});
		expect(await periods(2)).toEqual([
			{ archivedOn: "2026-09-15", restoredOn: null },
		]);

		await db.batch(
			restoreCategoryStatements(db, {
				id: 2,
				on: "2026-10-01",
				sortOrder: 8,
				expectedVersion: (await categoryFacts(db)).version,
			}),
		);
		expect((await rows()).find((c) => c.id === 2)).toMatchObject({
			archived: 0,
			archivedOn: null,
			sortOrder: 8,
		});
		expect(await periods(2)).toEqual([
			{ archivedOn: "2026-09-15", restoredOn: "2026-10-01" },
		]);
	});

	it("numbers the active list in the new order", async () => {
		const facts = await categoryFacts(db);
		const [first, second, ...rest] = facts.categories.map((c) => c.id);

		await db.batch(
			moveCategoryStatements(db, {
				// SAFETY: the demo has seven categories, so the first two ids exist.
				order: [second as number, first as number, ...rest],
				expectedVersion: facts.version,
			}),
		);
		expect((await activeNames()).slice(0, 2)).toEqual([
			"Eating Out",
			"Groceries",
		]);
		expect((await rows()).map((c) => c.sortOrder)).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
	});
});

describe("a save on a list that changed since the rule read it", () => {
	it.each([
		[
			"an add",
			(v: string) =>
				addCategoryStatements(db, {
					name: "Travel",
					nameKey: "travel",
					color: "cat-blue",
					sortOrder: 8,
					expectedVersion: v,
				}),
		],
		[
			"a rename",
			(v: string) =>
				renameCategoryStatements(db, {
					id: 1,
					name: "Food",
					nameKey: "food",
					expectedVersion: v,
				}),
		],
		[
			"an archive",
			(v: string) =>
				archiveCategoryStatements(db, { id: 1, on: TODAY, expectedVersion: v }),
		],
		[
			"a restore",
			(v: string) =>
				restoreCategoryStatements(db, {
					id: 1,
					on: TODAY,
					sortOrder: 9,
					expectedVersion: v,
				}),
		],
		[
			"a move",
			(v: string) =>
				moveCategoryStatements(db, {
					order: [7, 6, 5, 4, 3, 2, 1],
					expectedVersion: v,
				}),
		],
	])(
		"raises the guard's error for %s and saves none of it",
		async (_what, statements) => {
			const { version } = await categoryFacts(db);

			await someoneElseRenames();
			const before = await rows();

			expect(await ending(statements(version))).toBe("ListChangedSinceRead");
			expect(await rows()).toEqual(before);
			expect(await periods(1)).toEqual([]);
		},
	);

	it("says a taken name is taken, and does not take it for the guard's error", async () => {
		const { version } = await categoryFacts(db);

		const statements = () =>
			renameCategoryStatements(db, {
				id: 1,
				name: "Gas",
				nameKey: "gas",
				expectedVersion: version,
			});

		expect(await ending(statements())).toBe("NameTaken");
		// A save that sets no name has no such refusal: the same failure there is a defect, and the request fails.
		await expect(run(saveCategories(statements()))).rejects.toThrow(/UNIQUE/);
	});
});

describe("decideCategory", () => {
	it("saves what the rule decided and answers with the list it decided on and the batch's results", async () => {
		const answer = await decideCategory(
			addCategory,
			{ name: "Travel" },
			addCategoryStatements,
		);

		if ("refused" in answer) throw new Error(`Refused: ${answer.refused}`);
		expect(Option.isSome(answer.decided)).toBe(true);
		expect(answer.facts.categories).toHaveLength(7);
		expect(Number(answer.saved?.[1]?.meta.last_row_id)).toBe(
			(await rows()).find((c) => c.name === "Travel")?.id,
		);
	});

	it("saves nothing for a refusal or for nothing to do", async () => {
		const before = await rows();

		const refused = await decideCategory(
			renameCategory,
			{ id: 1, name: "gas" },
			renameCategoryStatements,
		);

		const nothing = await decideCategory(
			restoreCategory,
			{ id: 1, today: TODAY },
			restoreCategoryStatements,
		);

		expect(refused).toEqual({ refused: "NameTaken" });
		expect("decided" in nothing && Option.isNone(nothing.decided)).toBe(true);
		expect("saved" in nothing && nothing.saved).toBeUndefined();
		expect(await rows()).toEqual(before);
	});

	it("asks the rule again when the list changed under it, so both changes land", async () => {
		let asked = 0;

		const answer = await decideCategory(
			{
				decide: (
					request: { id: number; direction: "up" | "down" },
					facts: Parameters<typeof moveCategory.decide>[1],
				) => {
					asked++;

					return moveCategory.decide(request, facts);
				},
			},
			{ id: 2, direction: "up" },
			(d, save) => {
				// The first save finds a rename landed after its read; the second is on the fresh list.
				const statements = moveCategoryStatements(d, save);

				return asked === 1
					? [
							d.prepare(
								"UPDATE categories SET name = 'Fuel' WHERE name = 'Gas'",
							),
							...statements,
						]
					: statements;
			},
		);

		expect(asked).toBe(2);
		expect("decided" in answer && Option.isSome(answer.decided)).toBe(true);
		expect((await activeNames()).slice(0, 3)).toEqual([
			"Eating Out",
			"Groceries",
			"Gas",
		]);
	});

	it("gives up with an error when the list changes under it three times", async () => {
		let n = 0;

		await expect(
			decideCategory(archiveCategory, { id: 1, today: TODAY }, (d, save) => [
				d
					.prepare("UPDATE categories SET sort_order = sort_order + ?")
					.bind(++n),
				...archiveCategoryStatements(d, save),
			]),
		).rejects.toThrow(
			"The categories kept changing while one was being saved.",
		);
		expect(n).toBe(3);
		expect((await rows()).find((c) => c.id === 1)?.archived).toBe(0);
	});
});
