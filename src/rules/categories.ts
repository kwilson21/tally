// The categories area's rules (decisions 187 and 206): add, rename, archive, restore and move a category. Each takes a
// typed request and the stored list, and is written as a list of its parts (`rule`, in ./terms). Its `decide` answers
// what to save, or nothing when what was asked is already true, or fails with a named refusal. The date is an input
// (decision 195), and nothing here parses, reads a clock or touches the database. The save's guard is in
// src/db/category-saves.ts (decision 190).
import * as Data from "effect/Data";
import { NONE_FIT } from "../ai/decide";
import {
	COLORS,
	fullMessage,
	MAX_ACTIVE,
	nameKey,
	sameName,
} from "../settings/category-form";
import { rule, term, unless } from "./terms";

export type StoredCategory = {
	id: number;
	name: string;
	archived: boolean;
	sortOrder: number;
};

/** What the category rules read: every category, active ones first in the order the list shows, and the list's version. */
export type CategoryFacts = {
	categories: StoredCategory[];
	/** Stands for the whole list as it was read. A save lands only while the stored list still has this version. */
	version: string;
};

export type AddCategoryWrite = {
	name: string;
	nameKey: string;
	color: string;
	sortOrder: number;
	expectedVersion: string;
};

export type RenameCategoryWrite = {
	id: number;
	name: string;
	nameKey: string;
	expectedVersion: string;
};

export type ArchiveCategoryWrite = {
	id: number;
	on: string;
	expectedVersion: string;
};

export type RestoreCategoryWrite = {
	id: number;
	on: string;
	sortOrder: number;
	expectedVersion: string;
};

export type MoveCategoryWrite = {
	/** Every active category's id, in the new order. */
	order: number[];
	expectedVersion: string;
};

// The refusals: one class each, with the sentence a person reads.

export class CategoryChanged extends Data.TaggedError("CategoryChanged") {
	readonly say =
		"That category was changed somewhere else. Here's the current list.";
}

export class NameReserved extends Data.TaggedError("NameReserved") {
	readonly say = "That name is reserved for Tally. Pick another.";
}

export class NameArchived extends Data.TaggedError("NameArchived") {
	readonly say = "An archived category has that name. Restore it instead.";
}

export class NameTaken extends Data.TaggedError("NameTaken") {
	readonly say = "That name is taken.";
}

export class ListFull extends Data.TaggedError("ListFull")<{
	readonly action: "add" | "restore";
}> {
	get say() {
		return fullMessage(this.action);
	}
}

export const active = (facts: CategoryFacts) =>
	facts.categories.filter((c) => !c.archived);

export const lastPlace = (categories: StoredCategory[]) =>
	categories.reduce((last, c) => Math.max(last, c.sortOrder), 0);

export const hasRoom = (facts: CategoryFacts) =>
	active(facts).length < MAX_ACTIVE;

const find = (facts: CategoryFacts, id: number) =>
	facts.categories.find((c) => c.id === id);

/** What a typed name runs into: Tally's own name, and another category with the same name (an active one first). */
export const nameChecks = (
	name: string,
	facts: CategoryFacts,
	self: number | null,
) => {
	const clash = facts.categories.find(
		(c) => c.id !== self && sameName(c.name, name),
	);

	return {
		reserved: sameName(name, NONE_FIT),
		archivedHasName: clash?.archived === true,
		activeHasName: clash?.archived === false,
	};
};

type NameChecks = ReturnType<typeof nameChecks>;

type Found = { category: StoredCategory | undefined };

// The terms, shared between the rules.

export const nameIsNotReserved = unless(
	term<NameChecks>("the name is not Tally's own", (g) => !g.reserved),
	() => new NameReserved(),
);

export const noArchivedCategoryHasTheName = unless(
	term<NameChecks>(
		"no archived category has the name",
		(g) => !g.archivedHasName,
	),
	() => new NameArchived(),
);

export const noOtherCategoryHasTheName = unless(
	term<NameChecks>(
		"no other active category has the name",
		(g) => !g.activeHasName,
	),
	() => new NameTaken(),
);

const categoryIsActive = unless(
	term<Found>(
		"the category is in the active list",
		(g) => g.category?.archived === false,
	),
	() => new CategoryChanged(),
);

const categoryExists = unless(
	term<Found>("the category exists", (g) => g.category !== undefined),
	() => new CategoryChanged(),
);

export const listHasRoom = (action: "add" | "restore") =>
	unless(
		term<{ room: boolean }>(
			`fewer than ${MAX_ACTIVE} categories are active`,
			(g) => g.room,
		),
		() => new ListFull({ action }),
	);

export const addCategory = rule({
	name: "Add a category",
	given: (request: { name: string }, facts: CategoryFacts) => ({
		...nameChecks(request.name, facts, null),
		name: request.name,
		room: hasRoom(facts),
		// SAFETY: COLORS is a fixed, non-empty list and the index is taken modulo its length, so the entry exists.
		color: COLORS[facts.categories.length % COLORS.length] as string,
		sortOrder: lastPlace(facts.categories) + 1,
		version: facts.version,
	}),
	refusals: [
		nameIsNotReserved,
		noArchivedCategoryHasTheName,
		noOtherCategoryHasTheName,
		listHasRoom("add"),
	],
	writes: (g): AddCategoryWrite => ({
		name: g.name,
		nameKey: nameKey(g.name),
		color: g.color,
		sortOrder: g.sortOrder,
		expectedVersion: g.version,
	}),
	writesText:
		"Adds the category at the end of the list, with the tag icon and the next colour in turn.",
});

export const renameCategory = rule({
	name: "Rename a category",
	given: (request: { id: number; name: string }, facts: CategoryFacts) => ({
		...nameChecks(request.name, facts, request.id),
		...request,
		category: find(facts, request.id),
		version: facts.version,
	}),
	nothingToDoIf: term<Found & { name: string }>(
		"the category is in the active list and already has exactly that name",
		(g) => g.category?.archived === false && g.category.name === g.name,
	),
	refusals: [
		categoryIsActive,
		nameIsNotReserved,
		noArchivedCategoryHasTheName,
		noOtherCategoryHasTheName,
	],
	writes: (g): RenameCategoryWrite => ({
		id: g.id,
		name: g.name,
		nameKey: nameKey(g.name),
		expectedVersion: g.version,
	}),
	writesText: "Sets the category's name.",
});

export const archiveCategory = rule({
	name: "Archive a category",
	given: (request: { id: number; today: string }, facts: CategoryFacts) => ({
		...request,
		category: find(facts, request.id),
		version: facts.version,
	}),
	nothingToDoIf: term<Found>(
		"the category is already archived",
		(g) => g.category?.archived === true,
	),
	refusals: [categoryExists],
	writes: (g): ArchiveCategoryWrite => ({
		id: g.id,
		on: g.today,
		expectedVersion: g.version,
	}),
	writesText:
		"Archives the category from today and opens its archive period. Nothing is deleted.",
});

export const restoreCategory = rule({
	name: "Restore a category",
	given: (request: { id: number; today: string }, facts: CategoryFacts) => ({
		...request,
		category: find(facts, request.id),
		room: hasRoom(facts),
		sortOrder: lastPlace(active(facts)) + 1,
		version: facts.version,
	}),
	nothingToDoIf: term<Found>(
		"the category is already in the active list",
		(g) => g.category?.archived === false,
	),
	refusals: [categoryExists, listHasRoom("restore")],
	writes: (g): RestoreCategoryWrite => ({
		id: g.id,
		on: g.today,
		sortOrder: g.sortOrder,
		expectedVersion: g.version,
	}),
	writesText:
		"Puts the category back at the end of the active list and closes its archive period today.",
});

/** Where a move starts and ends in the active list, as places in `order`. `from` is -1 for a category not in it. */
type Places = { order: number[]; from: number; to: number };

export const moveCategory = rule({
	name: "Move a category",
	given: (
		request: { id: number; direction: "up" | "down" },
		facts: CategoryFacts,
	) => {
		const order = active(facts).map((c) => c.id);
		const from = order.indexOf(request.id);

		return {
			category: find(facts, request.id),
			order,
			from,
			to: request.direction === "up" ? from - 1 : from + 1,
			version: facts.version,
		};
	},
	nothingToDoIf: term<Places>(
		"the category is in the active list and already at that end of it",
		(g) => g.from !== -1 && (g.to < 0 || g.to >= g.order.length),
	),
	refusals: [categoryIsActive],
	writes: (g): MoveCategoryWrite => ({
		order: g.order.map((id, i) =>
			// SAFETY: from and to are both places in order here: the refusal and nothing-to-do above answered the rest.
			i === g.from
				? (g.order[g.to] as number)
				: i === g.to
					? (g.order[g.from] as number)
					: id,
		),
		expectedVersion: g.version,
	}),
	writesText:
		"Swaps the category with its neighbour that way and numbers the active list 1, 2, 3…",
});
