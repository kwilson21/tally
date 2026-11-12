// The categories area's rules (decisions 187 and 205): add, rename, archive, restore and move a category. Each takes a
// typed request and the stored list, and either answers what to save (or nothing, when what was asked is already true)
// or fails with a named refusal. The date is an input (decision 195), and nothing here parses, reads a clock or touches
// the database. The save's guard is in src/db/category-saves.ts (decision 190).
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NONE_FIT } from "../ai/decide";
import {
	COLORS,
	fullMessage,
	MAX_ACTIVE,
	nameKey,
	sameName,
} from "../settings/category-form";
import { check, term, unless } from "./terms";

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

const active = (facts: CategoryFacts) =>
	facts.categories.filter((c) => !c.archived);

const lastPlace = (categories: StoredCategory[]) =>
	categories.reduce((last, c) => Math.max(last, c.sortOrder), 0);

const hasRoom = (facts: CategoryFacts) => active(facts).length < MAX_ACTIVE;

const find = (facts: CategoryFacts, id: number) =>
	facts.categories.find((c) => c.id === id);

/** What a typed name runs into: Tally's own name, and another category with the same name (an active one first). */
const nameChecks = (
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

/** The answer when what was asked is already true: nothing is saved, and the person gets the first press's answer. */
const nothingToDo = <W>() => Effect.succeed(Option.none<W>());

// The terms, shared between the rules.

const nameIsNotReserved = unless(
	term<NameChecks>("the name is not Tally's own", (g) => !g.reserved),
	() => new NameReserved(),
);

const noArchivedCategoryHasTheName = unless(
	term<NameChecks>(
		"no archived category has the name",
		(g) => !g.archivedHasName,
	),
	() => new NameArchived(),
);

const noOtherCategoryHasTheName = unless(
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

const listHasRoom = (action: "add" | "restore") =>
	unless(
		term<{ room: boolean }>(
			`fewer than ${MAX_ACTIVE} categories are active`,
			(g) => g.room,
		),
		() => new ListFull({ action }),
	);

const addRefusals = [
	nameIsNotReserved,
	noArchivedCategoryHasTheName,
	noOtherCategoryHasTheName,
	listHasRoom("add"),
];

export const addCategory = {
	name: "Add a category",
	refusals: addRefusals,
	writesText:
		"Adds the category at the end of the list, with the tag icon and the next colour in turn.",
	decide: (request: { name: string }, facts: CategoryFacts) =>
		check(
			{ ...nameChecks(request.name, facts, null), room: hasRoom(facts) },
			addRefusals,
		).pipe(
			Effect.as(
				Option.some<AddCategoryWrite>({
					name: request.name,
					nameKey: nameKey(request.name),
					// SAFETY: COLORS is a fixed, non-empty list and the index is taken modulo its length, so the entry exists.
					color: COLORS[facts.categories.length % COLORS.length] as string,
					sortOrder: lastPlace(facts.categories) + 1,
					expectedVersion: facts.version,
				}),
			),
		),
};

const alreadyNamed = term<Found & { name: string }>(
	"the category is in the active list and already has exactly that name",
	(g) => g.category?.archived === false && g.category.name === g.name,
);

const renameRefusals = [
	categoryIsActive,
	nameIsNotReserved,
	noArchivedCategoryHasTheName,
	noOtherCategoryHasTheName,
];

export const renameCategory = {
	name: "Rename a category",
	nothingToDoIf: alreadyNamed,
	refusals: renameRefusals,
	writesText: "Sets the category's name.",
	decide: (request: { id: number; name: string }, facts: CategoryFacts) => {
		const given = {
			...nameChecks(request.name, facts, request.id),
			category: find(facts, request.id),
			name: request.name,
		};

		return alreadyNamed.holds(given)
			? nothingToDo<RenameCategoryWrite>()
			: check(given, renameRefusals).pipe(
					Effect.as(
						Option.some<RenameCategoryWrite>({
							id: request.id,
							name: request.name,
							nameKey: nameKey(request.name),
							expectedVersion: facts.version,
						}),
					),
				);
	},
};

const alreadyArchived = term<Found>(
	"the category is already archived",
	(g) => g.category?.archived === true,
);

const archiveRefusals = [categoryExists];

export const archiveCategory = {
	name: "Archive a category",
	nothingToDoIf: alreadyArchived,
	refusals: archiveRefusals,
	writesText:
		"Archives the category from today and opens its archive period. Nothing is deleted.",
	decide: (request: { id: number; today: string }, facts: CategoryFacts) => {
		const given = { category: find(facts, request.id) };

		return alreadyArchived.holds(given)
			? nothingToDo<ArchiveCategoryWrite>()
			: check(given, archiveRefusals).pipe(
					Effect.as(
						Option.some<ArchiveCategoryWrite>({
							id: request.id,
							on: request.today,
							expectedVersion: facts.version,
						}),
					),
				);
	},
};

const alreadyActive = term<Found>(
	"the category is already in the active list",
	(g) => g.category?.archived === false,
);

const restoreRefusals = [categoryExists, listHasRoom("restore")];

export const restoreCategory = {
	name: "Restore a category",
	nothingToDoIf: alreadyActive,
	refusals: restoreRefusals,
	writesText:
		"Puts the category back at the end of the active list and closes its archive period today.",
	decide: (request: { id: number; today: string }, facts: CategoryFacts) => {
		const given = { category: find(facts, request.id), room: hasRoom(facts) };

		return alreadyActive.holds(given)
			? nothingToDo<RestoreCategoryWrite>()
			: check(given, restoreRefusals).pipe(
					Effect.as(
						Option.some<RestoreCategoryWrite>({
							id: request.id,
							on: request.today,
							sortOrder: lastPlace(active(facts)) + 1,
							expectedVersion: facts.version,
						}),
					),
				);
	},
};

type Places = { order: number[]; from: number; to: number };

const alreadyAtThatEnd = term<Places>(
	"the category is in the active list and already at that end of it",
	(g) => g.from !== -1 && (g.to < 0 || g.to >= g.order.length),
);

const moveRefusals = [categoryIsActive];

export const moveCategory = {
	name: "Move a category",
	nothingToDoIf: alreadyAtThatEnd,
	refusals: moveRefusals,
	writesText:
		"Swaps the category with its neighbour that way and numbers the active list 1, 2, 3…",
	decide: (
		request: { id: number; direction: "up" | "down" },
		facts: CategoryFacts,
	) => {
		const order = active(facts).map((c) => c.id);
		const from = order.indexOf(request.id);
		const to = request.direction === "up" ? from - 1 : from + 1;

		return alreadyAtThatEnd.holds({ order, from, to })
			? nothingToDo<MoveCategoryWrite>()
			: check({ category: find(facts, request.id) }, moveRefusals).pipe(
					Effect.as(
						Option.some<MoveCategoryWrite>({
							order: order.map((id, i) =>
								// SAFETY: from and to are both places in order here: the refusal and nothing-to-do above answered the rest.
								i === from
									? (order[to] as number)
									: i === to
										? (order[from] as number)
										: id,
							),
							expectedVersion: facts.version,
						}),
					),
				);
	},
};
