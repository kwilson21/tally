import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { readAtEdge } from "../src/edge";
import {
	addCategory,
	archiveCategory,
	type CategoryFacts,
	moveCategory,
	renameCategory,
	restoreCategory,
} from "../src/rules/categories";
import type { Refusal } from "../src/rules/terms";
import {
	CategoryId,
	CategoryName,
	MoveDirection,
} from "../src/settings/category-form";

// The categories area's five rules as stories (decisions 187, 206): each row is what was asked, what was stored, and
// what the rule answers. The date is an input (decision 195); nothing here touches a clock or a database.

/** What a story expects: what to save, nothing to do, or a named refusal with its sentence. */
const write = <W>(save: W) => ({ kind: "write" as const, save });
const nothingToDo = () => ({ kind: "nothingToDo" as const });

const refuse = (type: string, say: string) => ({
	kind: "refuse" as const,
	type,
	say,
});

/** Runs a rule's answer, which needs nothing handed in, and puts it in a story's words. */
const answerOf = <W, E extends Refusal>(
	decided: Effect.Effect<Option.Option<W>, E>,
) =>
	Effect.runSync(
		Effect.match(decided, {
			onFailure: (refusal) => refuse(refusal._tag, refusal.say),
			onSuccess: (save) =>
				Option.isSome(save) ? write(save.value) : nothingToDo(),
		}),
	);

const VERSION = "v1";
const TODAY = "2026-11-12";

/** A list from short rows: [id, name] is active, [id, name, "archived"] is not. Places count up from 1. */
const list = (
	...rows: ([number, string] | [number, string, "archived"])[]
): CategoryFacts => ({
	version: VERSION,
	categories: rows.map(([id, name, archived], i) => ({
		id,
		name,
		archived: archived === "archived",
		sortOrder: i + 1,
	})),
});

const HOUSE = list(
	[1, "Groceries"],
	[2, "Eating Out"],
	[3, "Gas"],
	[4, "Pets", "archived"],
);

/** A list of 50 active categories, the most Tally keeps, and one archived. */
const FULL = list(
	...Array.from({ length: 50 }, (_, i): [number, string] => [
		i + 1,
		`Category ${i + 1}`,
	]),
	[51, "Pets", "archived"],
);

const CHANGED = refuse(
	"CategoryChanged",
	"That category was changed somewhere else. Here's the current list.",
);

const RESERVED = refuse(
	"NameReserved",
	"That name is reserved for Tally. Pick another.",
);

const ARCHIVED_NAME = refuse(
	"NameArchived",
	"An archived category has that name. Restore it instead.",
);

const TAKEN = refuse("NameTaken", "That name is taken.");

describe("Add a category", () => {
	const ask = (name: string, facts: CategoryFacts) =>
		answerOf(addCategory.decide({ name }, facts));

	it.each([
		[
			"adds it at the end, with the next colour in turn",
			"Travel",
			HOUSE,
			write({
				name: "Travel",
				nameKey: "travel",
				color: "cat-brown",
				sortOrder: 5,
				expectedVersion: VERSION,
			}),
		],
		[
			"adds the first category",
			"Travel",
			list(),
			write({
				name: "Travel",
				nameKey: "travel",
				color: "cat-blue",
				sortOrder: 1,
				expectedVersion: VERSION,
			}),
		],
		["refuses Jev's reserved name", "none of these FIT", HOUSE, RESERVED],
		["refuses a name an active category has", "gas", HOUSE, TAKEN],
		["refuses a name an archived category has", "PETS", HOUSE, ARCHIVED_NAME],
		[
			"refuses a 51st active category",
			"Travel",
			FULL,
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to add another.",
			),
		],
		[
			"says the name is taken before it says the list is full",
			"category 7",
			FULL,
			TAKEN,
		],
	])("%s", (_story, name, facts, answer) => {
		expect(ask(name, facts)).toEqual(answer);
	});
});

describe("Rename a category", () => {
	const ask = (id: number, name: string, facts: CategoryFacts = HOUSE) =>
		answerOf(renameCategory.decide({ id, name }, facts));

	const saves = (id: number, name: string, nameKey: string) =>
		write({ id, name, nameKey, expectedVersion: VERSION });

	it.each([
		["renames it", 1, "Food at home", saves(1, "Food at home", "food at home")],
		[
			"changes only its capitals",
			1,
			"GROCERIES",
			saves(1, "GROCERIES", "groceries"),
		],
		["has nothing to do for the name it already has", 3, "Gas", nothingToDo()],
		["refuses a name another active category has", 1, "gas", TAKEN],
		["refuses a name an archived category has", 1, "Pets", ARCHIVED_NAME],
		["refuses Jev's reserved name", 1, "None of these fit", RESERVED],
		["refuses a category that does not exist", 999, "X", CHANGED],
		["refuses an archived category", 4, "Animals", CHANGED],
		[
			"refuses an archived category even for the name it has",
			4,
			"Pets",
			CHANGED,
		],
	])("%s", (_story, id, name, answer) => {
		expect(ask(id, name)).toEqual(answer);
	});
});

describe("Archive a category", () => {
	const ask = (id: number) =>
		answerOf(archiveCategory.decide({ id, today: TODAY }, HOUSE));

	it.each([
		[
			"archives it from today",
			2,
			write({ id: 2, on: TODAY, expectedVersion: VERSION }),
		],
		["has nothing to do for one already archived", 4, nothingToDo()],
		["refuses a category that does not exist", 999, CHANGED],
	])("%s", (_story, id, answer) => {
		expect(ask(id)).toEqual(answer);
	});
});

describe("Restore a category", () => {
	const ask = (id: number, facts: CategoryFacts) =>
		answerOf(restoreCategory.decide({ id, today: TODAY }, facts));

	it.each([
		[
			"restores it to the end of the list",
			4,
			HOUSE,
			write({ id: 4, on: TODAY, sortOrder: 4, expectedVersion: VERSION }),
		],
		["has nothing to do for one already active", 2, HOUSE, nothingToDo()],
		["refuses a category that does not exist", 999, HOUSE, CHANGED],
		[
			"refuses a 51st active category",
			51,
			FULL,
			refuse(
				"ListFull",
				"Tally has room for 50 categories. Archive one to restore another.",
			),
		],
		[
			"has nothing to do for an active one even when the list is full",
			7,
			FULL,
			nothingToDo(),
		],
	])("%s", (_story, id, facts, answer) => {
		expect(ask(id, facts)).toEqual(answer);
	});
});

describe("Move a category", () => {
	const ask = (id: number, direction: "up" | "down") =>
		answerOf(moveCategory.decide({ id, direction }, HOUSE));

	const saves = (...order: number[]) =>
		write({ order, expectedVersion: VERSION });

	it.each([
		["moves it up one place", 3, "up", saves(1, 3, 2)],
		["moves it down one place", 1, "down", saves(2, 1, 3)],
		["has nothing to do at the top", 1, "up", nothingToDo()],
		["has nothing to do at the bottom", 3, "down", nothingToDo()],
		["refuses a category that does not exist", 999, "up", CHANGED],
		["refuses an archived category", 4, "up", CHANGED],
	] as const)("%s", (_story, id, direction, answer) => {
		expect(ask(id, direction)).toEqual(answer);
	});
});

describe("the edge", () => {
	it.each([
		["  Food   at home ", "Food at home"],
		["Cafe\u0301", "Café"],
	])("reads the name %j as %j", (typed, name) => {
		expect(readAtEdge(CategoryName, typed)).toEqual({ ok: true, value: name });
	});

	it.each([
		["", "Give the category a name."],
		["   ", "Give the category a name."],
		["x".repeat(41), "Keep the name to 40 characters."],
	])("refuses the name %j", (typed, sentence) => {
		expect(readAtEdge(CategoryName, typed)).toEqual({
			ok: false,
			say: sentence,
		});
	});

	it("reads a category's id from the address, and only a whole number above zero", () => {
		expect(readAtEdge(CategoryId, "12")).toEqual({ ok: true, value: 12 });

		for (const text of ["0", "-3", "1.5", "abc", ""])
			expect(readAtEdge(CategoryId, text).ok).toBe(false);
	});

	it("reads a move's direction, and nothing else", () => {
		expect(readAtEdge(MoveDirection, "up")).toEqual({ ok: true, value: "up" });
		expect(readAtEdge(MoveDirection, "sideways").ok).toBe(false);
	});
});

describe("a rule's terms", () => {
	it("lists each rule's refusals by their English text, in the order they are checked", () => {
		expect(renameCategory.refusals.map((r) => r.unless.text)).toEqual([
			"the category is in the active list",
			"the name is not Tally's own",
			"no archived category has the name",
			"no other active category has the name",
		]);
		expect(archiveCategory.nothingToDoIf?.text).toBe(
			"the category is already archived",
		);
		// Adding always has something to do, so that rule names no such term.
		expect(addCategory.nothingToDoIf).toBeUndefined();
	});
});
